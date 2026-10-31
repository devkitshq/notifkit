import { loadEnv, readBaseConfig } from "@/index.js";
import type { Logger } from "@/index.js";
import type { RedisClient, Redis } from "@/index.js";
import { redactUrl } from "@/index.js";
import {
  type StreamConsumer,
  type PendingMessageScanner,
  StreamProducer,
  type StreamMessage,
} from "@/index.js";
import { BaseWorker, type ProcessResult } from "@/index.js";
import {
  STREAMS,
  CONSUMER_GROUPS,
  PUBSUB_CHANNELS,
  registry,
  type EventRegistry,
  type NotificationDispatchedPayload,
  getAiConfig,
  AI_DEFAULTS,
} from "@/index.js";
import { generateText } from "ai";
import { IdempotencyGuard } from "@/index.js";
import { TemplateRepository } from "@/index.js";
import { scheduleOrDispatch } from "@/services/engine/schedule-or-dispatch.js";
import { globalEmitter, type WorkerOptions } from "@/shared/index.js";
import { renderWithTemplate, TemplateCache } from "@/templates/index.js";
import { startHealthReporter } from "@/workers/index.js";
import {
  createPriorityProducers,
  createStreamConsumer,
  createWorkerRuntime,
  shutdownWorker,
  uniqueConsumerId,
} from "@/workers/bootstrap.js";

// ─── Bootstrap ─────────────────────────────────────────────────────────────

loadEnv();
const config = readBaseConfig();

let logger: Logger;
let redis: RedisClient;
let sql: any;
let db: any;
let templateRepo: TemplateRepository;

let templateCache: TemplateCache;

let consumer: StreamConsumer;
let pendingScanner: PendingMessageScanner;
let worker: BaseWorker;
let healthInterval: NodeJS.Timeout | null = null;
let subscriber: any = null;

/**
 * A model failure that retrying cannot fix (bad prompt, rejected request,
 * unsupported model). Thrown so the notification fails once instead of being
 * re-billed on every retry.
 */
export class PermanentAiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermanentAiError";
  }
}

/** Timeouts, rate limits and 5xx are worth another attempt; 4xx are not. */
export function isRetryableAiError(err: unknown): boolean {
  if (err instanceof PermanentAiError) return false;

  const e = err as { name?: string; statusCode?: number; status?: number } | null;
  if (!e) return false;

  if (e.name === "TimeoutError" || e.name === "AbortError") return true;

  const status = e.statusCode ?? e.status;
  if (typeof status === "number") {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }

  // Unclassifiable (network errors, transport failures) — assume transient.
  return true;
}

export interface AiWorkerOptions extends WorkerOptions {
  registry: EventRegistry;
  idempotency: any;
  redis: Redis;
  generateAiContent: any;
  templateCache: TemplateCache;
  scheduledProducer: any;
  outboundProducers: any;
  db: any;
}

export class AiWorker extends BaseWorker {
  private readonly registry: EventRegistry;
  private readonly idempotency: any;
  private readonly generateAiContent: any;
  private readonly templateCache: TemplateCache;
  private readonly scheduledProducer: any;
  private readonly outboundProducers: any;
  private readonly db: any;

  constructor(options: AiWorkerOptions) {
    super(options);
    this.registry = options.registry;
    this.idempotency = options.idempotency;
    this.generateAiContent = options.generateAiContent;
    this.templateCache = options.templateCache;
    this.scheduledProducer = options.scheduledProducer;
    this.outboundProducers = options.outboundProducers;
    this.db = options.db;
  }
  async process(message: StreamMessage): Promise<ProcessResult> {
    const { event } = message;

    const payloadResult = this.registry.safeParsePayload("notification.ai_pending", event.payload);
    if (!payloadResult.success) {
      this.logger.warn(
        { messageId: message.id, issues: payloadResult.error.issues },
        "invalid notification.ai_pending payload — skipping",
      );
      return;
    }

    const pending = payloadResult.data;

    // Stable across replays: the engine's task id when it sent one. A fresh id
    // per attempt made a replay after a crash a second, unrelated task that
    // delivery's lease could not recognise — the recipient got it twice.
    const taskId =
      pending.taskId ?? `${pending.enrichedEventId}:${pending.recipientId}:${pending.channel}`;

    // Idempotency. The lease has to outlast every generation this message may
    // run, or a second worker takes it over mid-call and bills the prompts again.
    const idempotencyKey = `${taskId}:ai`;
    const aiConfig = getAiConfig();
    const maxPrompts = aiConfig.maxPromptsPerNotification ?? AI_DEFAULTS.maxPromptsPerNotification;
    const leaseSeconds =
      Math.ceil(((aiConfig.timeoutMs ?? AI_DEFAULTS.timeoutMs) * maxPrompts) / 1000) + 30;
    const lease = this.idempotency.acquireLease
      ? await this.idempotency.acquireLease(idempotencyKey, leaseSeconds)
      : (await this.idempotency.checkAndMark(idempotencyKey, leaseSeconds))
        ? "acquired"
        : "locked";

    if (lease === "completed") {
      this.logger.debug(
        { messageId: message.id, eventId: event.id },
        "ai task already completed — acking message",
      );
      return;
    }

    if (lease === "locked") {
      this.logger.debug(
        { messageId: message.id, eventId: event.id },
        "duplicate ai task — lock held by another worker, leaving pending in stream",
      );
      return { ack: false };
    }
    try {
      // Execute AI prompts. Each key is a separate billed model call, so the
      // count is capped rather than being driven by whatever the caller sent.
      const promptEntries = Object.entries(pending.aiPrompts);
      if (promptEntries.length > maxPrompts) {
        this.logger.warn(
          { messageId: message.id, requested: promptEntries.length, maxPrompts },
          "aiPrompts exceeds the per-notification cap — extra prompts ignored",
        );
      }

      const generatedVars: Record<string, string> = {};
      for (const [key, prompt] of promptEntries.slice(0, maxPrompts)) {
        generatedVars[key] = await this.generateAiContent(prompt, pending.templateVariables);
      }

      // Merge generated vars with original template vars
      const finalVars = { ...pending.templateVariables, ...generatedVars };

      const dbTemplate = pending.templateId
        ? await this.templateCache.getCachedTemplate(pending.projectId, pending.templateId)
        : null;

      const rendered = renderWithTemplate(dbTemplate, finalVars);

      const destination =
        pending.destination ??
        (pending.channel === "email"
          ? pending.recipient.email
          : pending.channel === "sms" || pending.channel === "whatsapp"
            ? pending.recipient.phone
            : pending.channel === "webhook"
              ? pending.recipient.webhook
              : pending.channel === "telegram"
                ? pending.recipient.telegram
                : pending.channel === "discord"
                  ? pending.recipient.discord
                  : pending.channel === "slack"
                    ? pending.recipient.slack
                    : pending.channel === "push"
                      ? (pending.recipient.pushTokens?.[0] ?? pending.recipient.pushToken)
                      : undefined);
      const resolvedDestination =
        destination ?? (pending.channel === "push" ? undefined : pending.recipientId);

      const taskPayload: NotificationDispatchedPayload = {
        projectId: pending.projectId,
        taskId,
        enrichedEventId: pending.enrichedEventId,
        recipientId: pending.recipientId,
        channel: pending.channel,
        priority: pending.priority,
        templateId: pending.templateId,
        templateVariables: pending.templateVariables,
        aiPrompts: pending.aiPrompts,
        recipient: pending.recipient,
        renderedContent: rendered,
        destination: resolvedDestination,
        deliveryOptions: {
          maxAttempts: 3,
          timeoutMs: 10_000,
          ...(pending.deliveryHeaders ? { headers: pending.deliveryHeaders } : {}),
        },
        fallbackChain: pending.fallbackChain,
        campaignId: pending.campaignId,
        workflowInstanceId: pending.workflowInstanceId,
      };

      await scheduleOrDispatch(
        {
          db: this.db,
          scheduledProducer: this.scheduledProducer,
          outboundProducers: this.outboundProducers,
          logger: this.logger,
        },
        taskPayload,
        {
          source: "ai-worker",
          scheduledAt: pending.scheduledAt,
          messageId: message.id,
          traceId: event.metadata.traceId,
          logLevel: "info",
          scheduledMessage: "task scheduled and payload cached after AI generation",
          dispatchedMessage: "task dispatched after AI generation",
        },
      );
      await this.idempotency.markProcessed?.(idempotencyKey);
    } catch (err) {
      await this.idempotency.unmark(idempotencyKey);
      if (err instanceof PermanentAiError || (err as Error)?.name === "PermanentAiError") {
        // Retrying re-bills the same failing prompt. Fail the notification once.
        this.logger.error(
          { err, messageId: message.id, recipientId: pending.recipientId },
          "AI generation failed permanently — dropping notification without retry",
        );
        globalEmitter.emit(
          "notification:failed",
          pending.enrichedEventId,
          (err as Error).message,
          pending.channel,
        );
        return;
      }
      throw err;
    }
  }
}

export async function startAiWorker() {
  ({ logger, redis, sql, db } = createWorkerRuntime(config, "ai"));
  templateRepo = new TemplateRepository(db);
  templateCache = new TemplateCache(templateRepo);
  ({ consumer, pendingScanner } = createStreamConsumer(
    { redis, logger },
    {
      stream: STREAMS.AI_PENDING,
      group: CONSUMER_GROUPS.AI,
      consumer: uniqueConsumerId("ai"),
      batchSize: config.WORKER_CONCURRENCY,
    },
  ));

  const outboundProducers = createPriorityProducers(redis.native, logger, "OUTBOUND");

  const scheduledProducer = new StreamProducer({
    redis: redis.native,
    stream: STREAMS.SCHEDULED,
    logger,
  });

  const idempotency = new IdempotencyGuard({
    redis: redis.native,
    keyPrefix: "notif:processed:ai",
    ttlSeconds: config.IDEMPOTENCY_TTL_SECONDS,
  });

  // AI generation
  async function generateAiContent(prompt: string, vars: Record<string, unknown>): Promise<string> {
    const aiConfig = getAiConfig();
    const interpolated = prompt.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? ""));

    if (!aiConfig.aiModel) {
      logger.warn("AI worker called but no AI model was provided to NotifkitServer");
      return `[AI Disabled] ${interpolated}`;
    }

    const maxOutputTokens = aiConfig.maxOutputTokens ?? AI_DEFAULTS.maxOutputTokens;
    const timeoutMs = aiConfig.timeoutMs ?? AI_DEFAULTS.timeoutMs;

    try {
      const { text } = await generateText({
        model: aiConfig.aiModel,
        prompt: interpolated,
        maxOutputTokens,
        abortSignal: AbortSignal.timeout(timeoutMs),
      });

      return text;
    } catch (err) {
      // BaseWorker retries a throw up to maxRetriesBeforeDlq, and every retry is
      // another billed call. Only re-throw for failures a retry could actually
      // fix; a malformed prompt or a rejected request must not be re-billed.
      if (isRetryableAiError(err)) {
        logger.error({ err }, "AI generation failed (transient) — will retry");
        throw err;
      }
      throw new PermanentAiError(err instanceof Error ? err.message : String(err), { cause: err });
    }
  }

  worker = new AiWorker({
    consumer,
    pendingScanner,
    logger,
    concurrency: config.WORKER_CONCURRENCY,
    registry,
    idempotency,
    redis: redis.native,
    generateAiContent,
    templateCache,
    scheduledProducer,
    outboundProducers,
    db,
  });

  subscriber = redis.native.duplicate({ enableAutoPipelining: false });
  await subscriber.subscribe(PUBSUB_CHANNELS.TEMPLATE_INVALIDATED);
  subscriber.on("message", (channel: string, message: string) => {
    if (channel === PUBSUB_CHANNELS.TEMPLATE_INVALIDATED) {
      templateCache.invalidateKey(message);
      logger.info({ cacheKey: message }, "invalidated template cache");
    }
  });

  healthInterval = startHealthReporter("ai", worker, redis, logger);

  logger.info({ env: config.NODE_ENV, redis: redactUrl(config.REDIS_URL) }, "ai starting");
  await worker.start();
}

export async function stopAiWorker(): Promise<void> {
  await shutdownWorker("ai", {
    logger,
    timers: [healthInterval],
    subscriber,
    worker,
    sql,
    redis,
  });
  healthInterval = null;
  subscriber = null;
}
