import { loadEnv, parseConfig, baseConfigSchema } from "@/index.js";
import type { Logger } from "@/index.js";
import type { RedisClient, Redis } from "@/index.js";
import {
  type StreamConsumer,
  type PendingMessageScanner,
  type StreamMessage,
  StreamProducer,
} from "@/index.js";
import { BaseWorker, type ProcessResult } from "@/index.js";
import {
  STREAMS,
  OUTBOUND_STREAMS,
  CONSUMER_GROUPS,
  registry,
  buildStreamEvent,
  type NotificationDispatchedPayload,
  type DispatchedTaskPayload,
  type RenderedContent,
  PUBSUB_CHANNELS,
} from "@/index.js";
import { upsertOutboxProviderIds } from "@/db/bulk.js";
import { deliveryOutbox, scheduledPayloads } from "@/db/schema.js";
import { sql as drizzleSql } from "drizzle-orm";
import { ContactRepository, IdempotencyGuard, TemplateRepository } from "@/index.js";
import { renderWithTemplate, TemplateCache } from "@/templates/index.js";
import { transportRegistry } from "@/index.js";
import { globalEmitter, getPriorityBucket, type WorkerOptions } from "@/shared/index.js";
import { startHealthReporter, NonRetryableError } from "@/workers/index.js";
import {
  createPriorityProducers,
  createStreamConsumer,
  createWorkerRuntime,
  shutdownWorker,
  uniqueConsumerId,
} from "@/workers/bootstrap.js";
import { BatchProcessor, CircuitBreaker } from "@/shared/index.js";
import { publishDeliveryEvents } from "./live-events.js";
import { ProviderThrottle } from "./throttle.js";
import { metrics } from "@/metrics/index.js";

// ─── App-specific config ────────────────────────────────────────────────────

const deliveryConfigSchema = baseConfigSchema.extend({});

// ─── Bootstrap ─────────────────────────────────────────────────────────────

loadEnv();
const config = parseConfig(deliveryConfigSchema, process.env);

let logger: Logger;
let redis: RedisClient;
let sql: any;
let db: any;

let consumer: StreamConsumer;
let pendingScanner: PendingMessageScanner;
let worker: BaseWorker;
let scheduledProducer: StreamProducer;
let enrichedProducers: Record<string, StreamProducer>;
let healthInterval: NodeJS.Timeout | null = null;
let subscriber: Redis | null = null;
let stopLiveEvents: (() => void) | null = null;

(global as any)._telemetry = (global as any)._telemetry || {
  count: 0,
  insert: 0,
  provider: 0,
  flush: 0,
  ack: 0,
  dequeue: 0,
  dbupdate: 0,
  flushCount: 0,
};

/** How long a send may run before its dispatched log entry is published alone. */
const DISPATCH_LOG_DELAY_MS = 1_000;

/**
 * Wait before re-trying a send that failed at the provider, by prior failures.
 * The first step matches the circuit breaker's reset timeout, so a retry of a
 * task the open breaker turned away reaches the provider's recovery probe
 * rather than the same closed door.
 */
const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000];

/**
 * How many times a send may be put back for want of provider capacity before
 * it is failed. Separate from `maxAttempts`, which counts sends the provider
 * refused: waiting in line is not a failed attempt, and a campaign several
 * windows deeper than the provider's limit has to be able to wait that long.
 */
export const MAX_THROTTLE_DEFERRALS = 50;

/**
 * Names the provider at `transports[i]` for its rate limit and circuit breaker.
 * The rate limit's budget lives in Redis and is shared by every delivery
 * process, so the name must come out the same everywhere: the class name,
 * numbered when a channel has two providers of one class.
 */
function providerKey(channel: string, transports: any[], i: number): string {
  const name = transports[i].constructor?.name ?? "provider";
  const nth = transports.slice(0, i).filter((t) => t.constructor?.name === name).length;
  return nth === 0 ? `${channel}:${name}` : `${channel}:${name}#${nth + 1}`;
}

/** A provider's refusal, keeping whether it said another attempt could work. */
function providerFailure(res: { error?: string; retryable?: boolean }): Error {
  const err = new Error(res.error ?? "Transport failed");
  (err as any).retryable = res.retryable;
  return err;
}

export function retryDelayMs(priorFailures: number): number {
  return RETRY_BACKOFF_MS[Math.min(priorFailures, RETRY_BACKOFF_MS.length - 1)]!;
}

export interface DeliveryWorkerOptions extends WorkerOptions {
  transportRegistry: any;
  idempotency: any;
  redis: Redis;
  scheduledProducer: any;
  enrichedProducers: any;
  contactRepo: any;
  eventsProducer: any;
  globalEmitter: any;
  db: any;
  providerThrottle?: ProviderThrottle;
  /** Renders tasks that arrive without `renderedContent`. */
  templateCache?: TemplateCache;
}

export class DeliveryWorker extends BaseWorker {
  private readonly transportRegistry: any;
  private readonly idempotency: any;
  private readonly scheduledProducer: any;
  private readonly enrichedProducers: any;
  private readonly contactRepo: any;
  private readonly eventsProducer: any;
  private readonly globalEmitter: any;
  private readonly db: any;

  private eventProcessor: BatchProcessor<any, void>;
  private outboxUpdateProcessor: BatchProcessor<any, void>;
  private outboxInsertProcessor: BatchProcessor<any, boolean>;
  private breakers = new Map<string, CircuitBreaker>();
  private readonly providerThrottle: ProviderThrottle;
  private readonly templateCache?: TemplateCache;

  constructor(options: DeliveryWorkerOptions) {
    super(options);
    this.transportRegistry = options.transportRegistry;
    this.idempotency = options.idempotency;
    this.scheduledProducer = options.scheduledProducer;
    this.enrichedProducers = options.enrichedProducers;
    this.contactRepo = options.contactRepo;
    this.eventsProducer = options.eventsProducer;
    this.globalEmitter = options.globalEmitter;
    this.db = options.db;
    this.providerThrottle =
      options.providerThrottle ?? new ProviderThrottle(options.redis, this.logger);
    this.templateCache = options.templateCache;

    // Every message waits on these flushes before it is acked, so they bound
    // the worker's throughput: allow a few in flight and let batches grow with
    // the configured concurrency.
    const batchSize = Math.max(10, Math.min(options.concurrency ?? 50, 500));
    const flushConcurrency = 4;

    this.eventProcessor = new BatchProcessor<any, void>(
      batchSize,
      5,
      async (events) => {
        await this.eventsProducer.publishBatch(events);
        return events.map(() => undefined as void);
      },
      flushConcurrency,
    );

    this.outboxUpdateProcessor = new BatchProcessor<any, void>(
      batchSize,
      5,
      async (updates) => {
        const values = updates.map((update) => ({
          taskId: update.taskId,
          channel: update.channel,
          destination: update.destination,
          providerMessageId: update.providerMessageId,
        }));

        const tDbUpdateStart = Date.now();
        await upsertOutboxProviderIds(this.db, values).catch((e: any) =>
          this.logger.error({ err: e }, "background update failed"),
        );

        (global as any)._telemetry.dbupdate += Date.now() - tDbUpdateStart;
        (global as any)._telemetry.flushCount++;
        return updates.map(() => undefined as void);
      },
      flushConcurrency,
    );

    this.outboxInsertProcessor = new BatchProcessor(batchSize, 5, async (tasks) => {
      const values = tasks.map((task: any) => ({
        taskId: task.taskId,
        channel: task.channel,
        destination: task.destination,
      }));

      await this.db.insert(deliveryOutbox).values(values).onConflictDoNothing();
      return tasks.map(() => true);
    });
  }

  override async stop(): Promise<void> {
    await Promise.all([
      this.eventProcessor.flush(),
      this.outboxUpdateProcessor.flush(),
      this.outboxInsertProcessor.flush(),
    ]);
    await super.stop();
  }

  /**
   * Renders a task the engine dispatched unrendered. Done here, after the
   * throttle and the lease, so the body is built once per actual send and never
   * travels through the outbound stream.
   */
  private async render(task: NotificationDispatchedPayload): Promise<RenderedContent> {
    if (!task.templateId) return renderWithTemplate(null, task.templateVariables);
    const template = this.templateCache
      ? await this.templateCache.getCachedTemplate(task.projectId, task.templateId)
      : null;
    if (!template) {
      // The engine checked it existed; it was deleted since. Retrying won't help.
      throw new NonRetryableError(`template "${task.templateId}" not found at send time`);
    }
    return renderWithTemplate(template, task.templateVariables);
  }

  /**
   * Parks a task in Postgres and the scheduler until `sendAt`. The payload
   * carries the send time, so the scheduler can rebuild it if Redis loses its
   * data.
   */
  private async reschedule(
    task: DispatchedTaskPayload,
    sendAt: Date,
    reason: string,
  ): Promise<void> {
    const scheduledAt = sendAt.toISOString();
    await this.db
      .insert(scheduledPayloads)
      .values({ taskId: task.taskId, payload: { ...task, scheduledAt } })
      .onConflictDoUpdate({
        target: scheduledPayloads.taskId,
        set: { payload: drizzleSql`EXCLUDED.payload` },
      });

    await this.scheduledProducer.publish(
      buildStreamEvent(
        "notification.scheduled",
        {
          projectId: task.projectId,
          enrichedEventId: task.enrichedEventId,
          taskId: task.taskId,
          scheduledAt,
        },
        "delivery",
        `${task.taskId}:${reason}:${Date.now()}`,
      ),
    );
  }

  /** Takes a slot from the provider's rate limit, if it has one. */
  private async providerGate(
    channel: string,
    transports: any[],
    i: number,
  ): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const limits = transports[i].limits;
    if (!limits) return { allowed: true, retryAfterMs: 0 };
    return this.providerThrottle.check(providerKey(channel, transports, i), limits);
  }

  private getBreaker(name: string): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30000 });
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  async process(message: StreamMessage, attempt: number = 1): Promise<ProcessResult> {
    const { event } = message;
    const publishPromises: Promise<void>[] = [];

    const payloadResult = registry.safeParsePayload("notification.dispatched", event.payload);
    if (!payloadResult.success) {
      this.logger.warn(
        { messageId: message.id, issues: payloadResult.error.issues },
        "invalid notification.dispatched payload — skipping",
      );
      return;
    }

    const task = payloadResult.data as NotificationDispatchedPayload;
    // Attempts made on earlier trips through the scheduler, plus this one.
    const attemptNo = (task.deliveryAttemptCount ?? 0) + attempt;
    // What gets parked for a retry: the task as it arrived, before rendering
    // and the transport's abort signal were attached to it.
    const original: DispatchedTaskPayload = { ...task };

    const fallbackToNextChannel = async (reason: string) => {
      if (task.fallbackChain && task.fallbackChain.length > 0 && task.recipient) {
        const nextChannel = task.fallbackChain[0];
        const remainingChain = task.fallbackChain.slice(1);

        const fallbackPayload: any = {
          // NotificationEnrichedPayload
          projectId: task.projectId,
          rawEventId: task.enrichedEventId,
          recipientId: task.recipientId,
          channel: nextChannel,
          priority: task.priority,
          templateId: task.templateId,
          templateVariables: task.templateVariables,
          aiPrompts: task.aiPrompts,
          recipient: task.recipient,
          scheduledAt: undefined,
          fallbackChain: remainingChain.length > 0 ? remainingChain : undefined,
          campaignId: task.campaignId,
          workflowInstanceId: task.workflowInstanceId,
          throttleCounted: true,
        };

        const p = getPriorityBucket(task.priority);
        const producer = this.enrichedProducers[p] ?? this.enrichedProducers["normal"]!;
        await producer.publish(
          buildStreamEvent(
            "notification.enriched",
            fallbackPayload,
            "delivery",
            event.metadata.traceId,
          ),
        );

        this.logger.info(
          { taskId: task.taskId, reason, nextChannel, traceId: event.metadata.traceId },
          "Delivery failed completely, rolling over to next channel in fallback chain",
        );
        return true; // Indicates fallback was triggered
      }
      return false; // No fallback
    };

    const transports = this.transportRegistry.getAll(task.channel);

    if (transports.length === 0) {
      this.logger.warn(
        { taskId: task.taskId, channel: task.channel },
        "no transport registered for channel — dropping",
      );
      const fallbackTriggered = await fallbackToNextChannel("no_transport");
      if (!fallbackTriggered) {
        this.globalEmitter.emit(
          "delivery:failed",
          task.taskId,
          "no transport",
          task.channel,
          task.projectId,
        );
        await this.eventProcessor.add(
          buildStreamEvent(
            "notification.failed",
            {
              projectId: task.projectId,
              taskId: task.taskId,
              enrichedEventId: task.enrichedEventId,
              recipientId: task.recipientId,
              channel: task.channel,
              failureReason: "no transport registered for channel",
              failureCode: "no_transport",
              retryable: false,
              attempt: attemptNo,
              templateId: task.templateId,
              workflowInstanceId: task.workflowInstanceId,
              campaignId: task.campaignId,
            },
            "delivery",
            event.metadata.traceId,
          ),
        );
      }
      return;
    }

    // Each provider has its own budget: start at the first with room left. The
    // channel is out of capacity only once every provider for it is.
    let startAt = -1;
    let retryAfterMs = Infinity;
    let windowMs = Infinity;
    for (let i = 0; i < transports.length; i++) {
      const gate = await this.providerGate(task.channel, transports, i);
      if (gate.allowed) {
        startAt = i;
        break;
      }
      retryAfterMs = Math.min(retryAfterMs, gate.retryAfterMs);
      windowMs = Math.min(windowMs, (transports[i].limits?.windowSeconds ?? 0) * 1000);
    }
    if (startAt === -1) {
      task.throttleAttemptCount = (task.throttleAttemptCount ?? 0) + 1;

      if (task.throttleAttemptCount > MAX_THROTTLE_DEFERRALS) {
        this.logger.warn(
          { messageId: message.id, taskId: task.taskId, attempts: task.throttleAttemptCount },
          "provider rate limit max attempts exceeded",
        );
        const fallbackTriggered = await fallbackToNextChannel("provider_throttle_exceeded");
        if (!fallbackTriggered) {
          this.globalEmitter.emit(
            "delivery:failed",
            task.taskId,
            "provider throttle exceeded",
            task.channel,
            task.projectId,
          );
          await this.eventProcessor.add(
            buildStreamEvent(
              "notification.failed",
              {
                projectId: task.projectId,
                taskId: task.taskId,
                enrichedEventId: task.enrichedEventId,
                recipientId: task.recipientId,
                channel: task.channel,
                failureReason: "provider rate limit max attempts exceeded",
                failureCode: "provider_throttle_exceeded",
                retryable: false,
                attempt: attemptNo,
                templateId: task.templateId,
                workflowInstanceId: task.workflowInstanceId,
                campaignId: task.campaignId,
              },
              "delivery",
              event.metadata.traceId,
            ),
          );
        }
        return;
      }

      // Spread over more windows the longer a task has waited. Every task turned
      // away in one window used to come back at the same boundary, where the
      // limit again let one window's worth through and bounced the rest.
      const spreadMs = Number.isFinite(windowMs)
        ? Math.random() * windowMs * Math.min(task.throttleAttemptCount, 10)
        : 0;
      await this.reschedule(
        { ...original, throttleAttemptCount: task.throttleAttemptCount },
        new Date(Date.now() + retryAfterMs + spreadMs),
        "throttle",
      );
      return;
    }

    const idempotencyKey = task.taskId;
    const lease = this.idempotency.acquireLease
      ? await this.idempotency.acquireLease(idempotencyKey, 60)
      : (await this.idempotency.checkAndMark(idempotencyKey, 60))
        ? "acquired"
        : "locked";

    if (lease === "completed") {
      this.logger.info(
        { messageId: message.id, taskId: task.taskId, channel: task.channel },
        "duplicate delivery — already completed, acking message",
      );
      return;
    }

    if (lease === "locked") {
      this.logger.info(
        { messageId: message.id, taskId: task.taskId, channel: task.channel, attempt },
        "duplicate delivery — skipping and leaving pending in stream",
      );
      return { ack: false };
    }

    const tDispatchStart = Date.now();
    const MAX_DISPATCH_BUDGET_MS = 25_000; // Strictly shorter than lock lease (30s)

    // The attempt's `dispatched` log entry normally rides on its outcome event,
    // one stream entry instead of two. A send still running after
    // DISPATCH_LOG_DELAY_MS is logged on its own, so a slow or stuck attempt is
    // visible while it is in flight, as it always was.
    let dispatchStarted = false;
    let dispatchLogged = false;
    let dispatchedAt = "";
    let dispatchLogTimer: NodeJS.Timeout | undefined;
    const logDispatched = (): Promise<void> | undefined => {
      clearTimeout(dispatchLogTimer);
      if (!dispatchStarted || dispatchLogged) return undefined;
      dispatchLogged = true;
      const logged = this.eventProcessor.add(
        buildStreamEvent(
          "notification.dispatched",
          {
            projectId: task.projectId,
            taskId: task.taskId,
            enrichedEventId: task.enrichedEventId,
            recipientId: task.recipientId,
            channel: task.channel,
            templateId: task.templateId,
            attempt: attemptNo,
            workflowInstanceId: task.workflowInstanceId,
            campaignId: task.campaignId,
          },
          "delivery",
          event.metadata.traceId,
        ),
      );
      publishPromises.push(logged);
      return logged;
    };
    /** Outcome payload, carrying the dispatched entry if it has not gone out. */
    const outcome = <T extends Record<string, unknown>>(payload: T): T => {
      clearTimeout(dispatchLogTimer);
      if (dispatchLogged) return payload;
      dispatchLogged = true;
      return { ...payload, attempt: attemptNo, dispatchedAt };
    };

    let retryScheduled = false;
    /**
     * Re-queues a send the provider turned away, unless it said the failure is
     * permanent or the task is out of attempts. An outage, a timeout or an open
     * circuit is exactly what a later attempt can get past; failing the task
     * outright turned every blip into lost mail. The attempt stays in the log as
     * dispatched, and the task's outcome is whatever its last attempt comes to.
     */
    const retryLater = async (failure: { retryable?: boolean; error?: string }) => {
      const maxAttempts = task.deliveryOptions?.maxAttempts ?? 3;
      if (failure.retryable === false || attemptNo >= maxAttempts) return false;
      const delayMs = retryDelayMs(task.deliveryAttemptCount ?? 0);
      await this.reschedule(
        { ...original, deliveryAttemptCount: attemptNo },
        new Date(Date.now() + delayMs),
        "retry",
      );
      retryScheduled = true;
      metrics.deliveryFailed.inc({ channel: task.channel, reason: "retry_scheduled" });
      this.logger.warn(
        {
          taskId: task.taskId,
          channel: task.channel,
          attempt: attemptNo,
          maxAttempts,
          delayMs,
          error: failure.error,
        },
        "provider send failed — retrying later",
      );
      return true;
    };

    try {
      if (!task.renderedContent) {
        task.renderedContent = await this.render(task);
      }

      dispatchStarted = true;
      dispatchedAt = new Date().toISOString();
      dispatchLogTimer = setTimeout(() => {
        void logDispatched();
      }, DISPATCH_LOG_DELAY_MS);

      // For push: we just need to send to the pre-resolved destination,
      // but if it's invalid, we deactivate it.
      if (task.channel === "push") {
        let lastResult: any = { success: false, error: "No transports" };

        for (let i = startAt; i < transports.length; i++) {
          const transport = transports[i];
          // The starting provider's slot was taken above. Failing over to a
          // later one spends that provider's own budget, or skips it if spent.
          if (i > startAt && !(await this.providerGate(task.channel, transports, i)).allowed) {
            continue;
          }
          const elapsedMs = Date.now() - tDispatchStart;
          const remainingBudgetMs = Math.max(0, MAX_DISPATCH_BUDGET_MS - elapsedMs);
          if (remainingBudgetMs <= 0) {
            this.logger.warn(
              { taskId: task.taskId, channel: task.channel },
              "dispatch budget exhausted before transport call — aborting to protect lock lease",
            );
            break;
          }
          const configuredTimeoutMs = task.deliveryOptions?.timeoutMs ?? 10_000;
          const timeoutMs = Math.min(configuredTimeoutMs, remainingBudgetMs);

          try {
            const tProv = Date.now();
            const breaker = this.getBreaker(providerKey(task.channel, transports, i));

            lastResult = await breaker.execute(async () => {
              const controller = new AbortController();
              const timeout = setTimeout(() => {
                controller.abort(new Error(`Transport timeout after ${timeoutMs}ms`));
              }, timeoutMs);

              try {
                (task as any).signal = controller.signal;
                const res: any = await Promise.race([
                  transport.send(task),
                  new Promise((_, reject) => {
                    if (controller.signal.aborted) return reject(controller.signal.reason);
                    controller.signal.addEventListener("abort", () =>
                      reject(controller.signal.reason),
                    );
                  }),
                ]);
                // A permanent rejection is the provider working: returned, not
                // thrown, so the breaker does not count it.
                if (!res.success && !res.invalidToken && res.retryable !== false) {
                  throw providerFailure(res);
                }
                return res;
              } finally {
                clearTimeout(timeout);
              }
            });

            (global as any)._telemetry.provider += Date.now() - tProv;
            if (lastResult.success || lastResult.invalidToken) break;
          } catch (err: any) {
            lastResult = { success: false, error: err.message, retryable: err.retryable };
          }
        }

        if (lastResult.invalidToken) {
          publishPromises.push(
            this.outboxUpdateProcessor.add({
              taskId: task.taskId,
              channel: task.channel,
              destination: task.destination,
              providerMessageId: null,
            }),
          );
          await this.contactRepo.deactivate(
            task.projectId,
            task.recipientId,
            task.channel as any,
            task.destination,
          );
          this.logger.info(
            { channel: task.channel, target: task.destination },
            "deactivated invalid contact target",
          );
          this.globalEmitter.emit(
            "delivery:failed",
            task.taskId,
            "invalidToken",
            task.channel,
            task.projectId,
          );
          metrics.deliveryFailed.inc({ channel: task.channel, reason: "invalid_token" });

          publishPromises.push(
            this.eventProcessor.add(
              buildStreamEvent(
                "notification.failed",
                outcome({
                  projectId: task.projectId,
                  taskId: task.taskId,
                  enrichedEventId: task.enrichedEventId,
                  recipientId: task.recipientId,
                  channel: task.channel,
                  failureReason: "invalid_token",
                  failureCode: "push_failure",
                  retryable: false,
                  attempt: attemptNo,
                  templateId: task.templateId,
                  workflowInstanceId: task.workflowInstanceId,
                  campaignId: task.campaignId,
                }),
                "delivery",
                event.metadata.traceId,
              ),
            ),
          );

          const fallbackTriggered = await fallbackToNextChannel("invalid_token");
          if (!fallbackTriggered) {
            throw new NonRetryableError("Push delivery failed: invalid token");
          }
        } else if (lastResult.success) {
          // Record providerMessageId in outbox before publishing event
          const providerMessageId = lastResult.providerMessageId || "push-success";

          publishPromises.push(
            this.outboxUpdateProcessor.add({
              taskId: task.taskId,
              channel: task.channel,
              destination: task.destination,
              providerMessageId,
            }),
          );

          this.logger.debug(
            { taskId: task.taskId, messageId: providerMessageId },
            "push delivered",
          );
          this.globalEmitter.emit(
            "delivery:delivered",
            task.taskId,
            providerMessageId,
            task.channel,
            task.projectId,
          );
          metrics.deliverySuccess.inc({ channel: task.channel });

          publishPromises.push(
            this.eventProcessor.add(
              buildStreamEvent(
                "notification.delivered",
                outcome({
                  projectId: task.projectId,
                  taskId: task.taskId,
                  enrichedEventId: task.enrichedEventId,
                  channel: task.channel,
                  deliveredAt: new Date().toISOString(),
                  providerMessageId,
                  templateId: task.templateId,
                  workflowInstanceId: task.workflowInstanceId,
                  campaignId: task.campaignId,
                }),
                "delivery",
                event.metadata.traceId,
              ),
            ),
          );
        } else if (!(await retryLater(lastResult))) {
          this.logger.warn(
            { taskId: task.taskId, error: lastResult.error },
            "push delivery failed",
          );
          this.globalEmitter.emit(
            "delivery:failed",
            task.taskId,
            lastResult.error ?? "push delivery failed",
            task.channel,
            task.projectId,
          );
          metrics.deliveryFailed.inc({ channel: task.channel, reason: "push_error" });

          publishPromises.push(
            this.outboxUpdateProcessor.add({
              taskId: task.taskId,
              channel: task.channel,
              destination: task.destination,
              providerMessageId: null,
            }),
          );

          publishPromises.push(
            this.eventProcessor.add(
              buildStreamEvent(
                "notification.failed",
                outcome({
                  projectId: task.projectId,
                  taskId: task.taskId,
                  enrichedEventId: task.enrichedEventId,
                  recipientId: task.recipientId,
                  channel: task.channel,
                  failureReason: lastResult.error ?? "push delivery failed",
                  failureCode: "push_failure",
                  retryable: false,
                  attempt: attemptNo,
                  templateId: task.templateId,
                  workflowInstanceId: task.workflowInstanceId,
                  campaignId: task.campaignId,
                }),
                "delivery",
                event.metadata.traceId,
              ),
            ),
          );

          const fallbackTriggered = await fallbackToNextChannel("push_delivery_failed");
          if (!fallbackTriggered) {
            throw new NonRetryableError(lastResult.error ?? "Push delivery failed");
          }
        }
      } else {
        // Other channels (email, sms, webhook, whatsapp) use the pre-resolved destination
        let result: any = { success: false, error: "No transports" };
        for (let i = startAt; i < transports.length; i++) {
          const transport = transports[i];
          // The starting provider's slot was taken above. Failing over to a
          // later one spends that provider's own budget, or skips it if spent.
          if (i > startAt && !(await this.providerGate(task.channel, transports, i)).allowed) {
            continue;
          }
          const elapsedMs = Date.now() - tDispatchStart;
          const remainingBudgetMs = Math.max(0, MAX_DISPATCH_BUDGET_MS - elapsedMs);
          if (remainingBudgetMs <= 0) {
            this.logger.warn(
              { taskId: task.taskId, channel: task.channel },
              "dispatch budget exhausted before transport call — aborting to protect lock lease",
            );
            break;
          }
          const configuredTimeoutMs = task.deliveryOptions?.timeoutMs ?? 10_000;
          const timeoutMs = Math.min(configuredTimeoutMs, remainingBudgetMs);

          try {
            const tProv = Date.now();
            const breaker = this.getBreaker(providerKey(task.channel, transports, i));

            result = await breaker.execute(async () => {
              const controller = new AbortController();
              const timeout = setTimeout(() => {
                controller.abort(new Error(`Transport timeout after ${timeoutMs}ms`));
              }, timeoutMs);

              try {
                (task as any).signal = controller.signal;
                const res: any = await Promise.race([
                  transport.send(task),
                  new Promise((_, reject) => {
                    if (controller.signal.aborted) return reject(controller.signal.reason);
                    controller.signal.addEventListener("abort", () =>
                      reject(controller.signal.reason),
                    );
                  }),
                ]);
                // A permanent rejection (a bad address) is the provider working:
                // returned, not thrown, so the breaker does not count it. A run
                // of them in one list used to open it for every project.
                if (!res.success && res.retryable !== false) {
                  throw providerFailure(res);
                }
                return res;
              } finally {
                clearTimeout(timeout);
              }
            });

            (global as any)._telemetry.provider += Date.now() - tProv;
            if (result.success) break;
          } catch (err: any) {
            result = { success: false, error: err.message, retryable: err.retryable };
          }
        }

        if (result.success) {
          // Record providerMessageId in outbox before publishing event
          const providerMessageId = result.providerMessageId || "success";

          publishPromises.push(
            this.outboxUpdateProcessor.add({
              taskId: task.taskId,
              channel: task.channel,
              destination: task.destination,
              providerMessageId,
            }),
          );

          this.globalEmitter.emit(
            "delivery:delivered",
            task.taskId,
            providerMessageId,
            task.channel,
            task.projectId,
          );
          metrics.deliverySuccess.inc({ channel: task.channel });

          publishPromises.push(
            this.eventProcessor.add(
              buildStreamEvent(
                "notification.delivered",
                outcome({
                  projectId: task.projectId,
                  taskId: task.taskId,
                  enrichedEventId: task.enrichedEventId,
                  channel: task.channel,
                  deliveredAt: new Date().toISOString(),
                  providerMessageId,
                  templateId: task.templateId,
                  workflowInstanceId: task.workflowInstanceId,
                  campaignId: task.campaignId,
                }),
                "delivery",
                event.metadata.traceId,
              ),
            ),
          );
        } else if (!(await retryLater(result))) {
          publishPromises.push(
            this.outboxUpdateProcessor.add({
              taskId: task.taskId,
              channel: task.channel,
              destination: task.destination,
              providerMessageId: null,
            }),
          );

          publishPromises.push(
            this.eventProcessor.add(
              buildStreamEvent(
                "notification.failed",
                outcome({
                  projectId: task.projectId,
                  taskId: task.taskId,
                  enrichedEventId: task.enrichedEventId,
                  channel: task.channel,
                  failureReason: result.error ?? "delivery failed completely",
                  failureCode: "provider_error",
                  retryable: false,
                  attempt: attemptNo,
                  templateId: task.templateId,
                  workflowInstanceId: task.workflowInstanceId,
                  campaignId: task.campaignId,
                }),
                "delivery",
                event.metadata.traceId,
              ),
            ),
          );
        }

        if (!result.success && !retryScheduled) {
          this.logger.warn(
            { taskId: task.taskId, channel: task.channel, error: result.error },
            "delivery failed completely across providers",
          );
          this.globalEmitter.emit(
            "delivery:failed",
            task.taskId,
            result.error ?? "delivery failed completely",
            task.channel,
            task.projectId,
          );
          metrics.deliveryFailed.inc({ channel: task.channel, reason: "provider_error" });

          const fallbackTriggered = await fallbackToNextChannel("all_providers_failed");
          if (!fallbackTriggered) {
            throw new NonRetryableError(result.error ?? "delivery failed");
          }
        } else if (result.success) {
          this.logger.debug(
            { taskId: task.taskId, channel: task.channel, messageId: result.providerMessageId },
            "notification delivered",
          );
        }
      }

      // Every branch above publishes an outcome; this only guards one that doesn't.
      void logDispatched();

      const tFlushStart = Date.now();
      await Promise.all(publishPromises).catch((err) => {
        this.logger.error(
          { err, taskId: task.taskId },
          "failed to publish post-dispatch events, swallowing error to prevent duplicate delivery",
        );
      });
      const flushTime = Date.now() - tFlushStart;

      if (retryScheduled) {
        // Released so the re-queued attempt can take the lease.
        await this.idempotency.unmark(idempotencyKey).catch(() => {});
      } else {
        void this.idempotency.markProcessed(idempotencyKey).catch((err: any) => {
          this.logger.warn({ err, taskId: task.taskId }, "failed to upgrade idempotency TTL");
        });
      }

      const t = ((global as any)._telemetry = (global as any)._telemetry || {
        count: 0,
        insert: 0,
        provider: 0,
        flush: 0,
        ack: 0,
      });
      t.count++;
      t.insert += 0;
      t.flush += flushTime;

      if (t.count % 1000 === 0) {
        this.logger.debug(
          `[Metrics 1000 msgs] Dequeue: ${t.dequeue / 1000}ms, DB Insert: ${t.insert / 1000}ms, Provider: ${t.provider / 1000}ms, Wait for Flush: ${t.flush / 1000}ms, Ack: ${t.ack / 1000}ms | DB Update (avg per flush): ${t.dbupdate / Math.max(1, t.flushCount)}ms`,
        );
        t.count = 0;
        t.insert = 0;
        t.provider = 0;
        t.flush = 0;
        t.dequeue = 0;
        t.ack = 0;
        t.dbupdate = 0;
        t.flushCount = 0;
      }
    } catch (err) {
      // The attempt happened even though it did not finish; keep it in the log.
      logDispatched()?.catch(() => {});
      await this.idempotency.unmark(idempotencyKey).catch(() => {});
      throw err;
    }
  }
}

export async function startDeliveryWorker() {
  ({ logger, redis, sql, db } = createWorkerRuntime(config, "delivery"));
  // Delivery spends most of its time waiting on providers, so it needs far
  // more messages in flight than the CPU-bound stages do.
  const deliveryConcurrency = config.DELIVERY_CONCURRENCY ?? config.WORKER_CONCURRENCY;
  const consumerId = uniqueConsumerId("delivery");
  ({ consumer, pendingScanner } = createStreamConsumer(
    { redis, logger },
    {
      stream: OUTBOUND_STREAMS,
      group: CONSUMER_GROUPS.DELIVERY,
      consumer: consumerId,
      batchSize: deliveryConcurrency,
      bufferAcks: true,
      coalesceMs: 2,
    },
  ));

  scheduledProducer = new StreamProducer({
    redis: redis.native,
    stream: STREAMS.SCHEDULED,
    logger,
  });

  enrichedProducers = createPriorityProducers(redis.native, logger, "ENRICHED");

  const contactRepo = new ContactRepository(db);
  const templateCache = new TemplateCache(new TemplateRepository(db));

  const idempotency = new IdempotencyGuard({
    redis: redis.native,
    keyPrefix: "notif:processed:delivery",
    ttlSeconds: config.IDEMPOTENCY_TTL_SECONDS,
  });

  // ─── Stage 3: Delivery Worker ───────────────────────────────────────────────
  //
  // Pipeline:
  //  1. Parse payload as notification.dispatched
  //  2. Resolve active device tokens from DB
  //  3. Send via registered transport
  //  4. Deactivate invalid tokens in DB

  const eventsProducer = new StreamProducer({
    redis: redis.native,
    stream: STREAMS.EVENTS_INBOUND,
    logger,
  });

  worker = new DeliveryWorker({
    consumer,
    pendingScanner,
    logger,
    concurrency: deliveryConcurrency,
    transportRegistry,
    idempotency,
    redis: redis.native,
    scheduledProducer,
    enrichedProducers,
    contactRepo,
    eventsProducer,
    globalEmitter,
    db,
    templateCache,
  });

  // Delivery renders templates now, so it has to hear about edits too.
  subscriber = redis.native.duplicate({ enableAutoPipelining: false });
  await subscriber.subscribe(PUBSUB_CHANNELS.TEMPLATE_INVALIDATED);
  subscriber.on("message", (_channel: string, key: string) => templateCache.invalidateKey(key));

  // ─── Health check interval ──────────────────────────────────────────────────

  // Outcomes for the API's live event stream, which may be in another process.
  stopLiveEvents = publishDeliveryEvents(redis.native, globalEmitter);

  healthInterval = startHealthReporter("delivery", worker, redis, logger);

  logger.info(
    { env: config.NODE_ENV, channels: transportRegistry.registeredChannels() },
    "delivery starting",
  );
  await worker.start();
}

export function getDeliveryWorker(): DeliveryWorker | undefined {
  return worker as DeliveryWorker | undefined;
}

// ─── Shutdown ──────────────────────────────────────────────────────────────

export async function stopDeliveryWorker(): Promise<void> {
  await shutdownWorker("delivery", {
    logger,
    timers: [healthInterval],
    subscriber,
    worker,
    sql,
    redis,
  });
  healthInterval = null;
  subscriber = null;
  stopLiveEvents?.();
  stopLiveEvents = null;
}
