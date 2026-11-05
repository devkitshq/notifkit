import { loadEnv, readBaseConfig } from "@/index.js";
import type { Logger } from "@/index.js";
import type { RedisClient } from "@/index.js";
import {
  type StreamConsumer,
  type PendingMessageScanner,
  StreamProducer,
  type StreamMessage,
} from "@/index.js";
import { BaseWorker } from "@/index.js";
import { STREAMS, CONSUMER_GROUPS, buildStreamEvent } from "@/index.js";
import { insertMessageLogs } from "@/db/bulk.js";
import { workflowWaiters, workflowSteps, workflowInstances } from "@/db/schema.js";
import { eq, and, or, isNull, gt } from "drizzle-orm";
import { type WorkerOptions } from "@/shared/index.js";
import { startHealthReporter } from "@/workers/index.js";
import {
  createStreamConsumer,
  createWorkerRuntime,
  shutdownWorker,
  uniqueConsumerId,
} from "@/workers/bootstrap.js";

loadEnv();
const config = readBaseConfig();
let logger: Logger;
let redis: RedisClient;
let sql: any;
let db: any;

let consumer: StreamConsumer;
let pendingScanner: PendingMessageScanner;
let worker: BaseWorker;
let healthInterval: NodeJS.Timeout | null = null;

let workflowProducer: StreamProducer;

export interface EventWorkerOptions extends WorkerOptions {
  db: any;
  workflowProducer: any;
}

export class EventWorker extends BaseWorker {
  private readonly dbConn: any;
  private readonly workflowProducer: any;
  private messageLogBuffer: { log: any; resolve: () => void; reject: (err: any) => void }[] = [];
  private eventBuffer: {
    producer: any;
    event: any;
    resolve: () => void;
    reject: (err: any) => void;
  }[] = [];
  private flushInterval: NodeJS.Timeout | null = null;
  private flushesInFlight = 0;
  private static readonly MAX_CONCURRENT_FLUSHES = 4;
  /**
   * Buffered logs that trigger a flush without waiting for the interval.
   *
   * Every message holds its worker slot until its log row is written, so a
   * purely timed flush caps the worker at `concurrency / LOG_FLUSH_INTERVAL_MS`
   * rows per second — far below what one delivery worker produces. Flushing
   * once half the slots are waiting keeps the other half reading.
   */
  private readonly flushThreshold: number;

  constructor(options: EventWorkerOptions) {
    super(options);
    this.dbConn = options.db;
    this.workflowProducer = options.workflowProducer;
    this.flushThreshold = Math.max(1, Math.min(500, Math.floor(this.concurrency / 2)));
    this.startFlushInterval();
  }

  private startFlushInterval() {
    this.flushInterval = setInterval(() => {
      void this.flushLogs();
    }, config.LOG_FLUSH_INTERVAL_MS);
  }

  private async flushLogs() {
    if (
      this.flushesInFlight >= EventWorker.MAX_CONCURRENT_FLUSHES ||
      (this.messageLogBuffer.length === 0 && this.eventBuffer.length === 0)
    )
      return;
    this.flushesInFlight++;

    const startTime = Date.now();
    const batch = this.messageLogBuffer;
    this.messageLogBuffer = [];

    const events = this.eventBuffer;
    this.eventBuffer = [];

    try {
      if (batch.length > 0) {
        await insertMessageLogs(
          this.dbConn,
          batch.map((b) => b.log),
        ); // Idempotent insert
        for (const b of batch) b.resolve();

        this.logger.debug(
          {
            batchSize: batch.length,
            latencyMs: Date.now() - startTime,
          },
          "flushed delivery logs to database",
        );
      }

      if (events.length > 0) {
        const byProducer = new Map<any, typeof events>();
        for (const item of events) {
          if (!byProducer.has(item.producer)) byProducer.set(item.producer, []);
          byProducer.get(item.producer)!.push(item);
        }
        for (const [producer, evts] of byProducer) {
          await producer.publishBatch(evts.map((e) => e.event));
          for (const e of evts) e.resolve();
        }
      }
    } catch (error: any) {
      this.logger.error(
        {
          batchSize: batch.length,
          err: error,
        },
        "failed to flush delivery logs — dropping batch",
      );
      for (const b of batch) b.reject(error);
      for (const e of events) e.reject(error);
    } finally {
      this.flushesInFlight--;
      // Flush rows that queued while every slot was busy, instead of waiting out the interval.
      if (this.messageLogBuffer.length >= this.flushThreshold) {
        void this.flushLogs();
      }
    }
  }

  override async stop(): Promise<void> {
    // Keep the flush interval until in-flight messages settle; they wait on it.
    await super.stop();
    if (this.flushInterval) clearInterval(this.flushInterval);
    const deadline = Date.now() + 10_000;
    while (
      (this.messageLogBuffer.length > 0 ||
        this.eventBuffer.length > 0 ||
        this.flushesInFlight > 0) &&
      Date.now() < deadline
    ) {
      await this.flushLogs();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  override async process(message: StreamMessage): Promise<void> {
    const { event } = message;
    const publishPromises: Promise<void>[] = [];

    if (
      event.type === "notification.dispatched" ||
      event.type === "notification.delivered" ||
      event.type === "notification.failed"
    ) {
      const payload = event.payload as any;
      if (this.messageLogBuffer.length >= config.LOG_BUFFER_MAX_SIZE) {
        this.logger.warn(
          { dropped: 1, bufferSize: this.messageLogBuffer.length },
          "log buffer full — dropping oldest delivery log",
        );
        const dropped = this.messageLogBuffer.shift(); // Drop oldest to apply back-pressure/prevent OOM
        if (dropped) dropped.reject(new Error("Dropped due to buffer overflow"));
      }

      const status =
        event.type === "notification.dispatched"
          ? "dispatched"
          : event.type === "notification.delivered"
            ? "delivered"
            : "failed";

      const kind = event.type === "notification.dispatched" ? "dispatched" : "attempt";

      const row = (
        rowKind: string,
        rowStatus: string,
        providerMessageId: string | null,
        timestamp?: string,
      ) =>
        new Promise<void>((resolve, reject) => {
          this.messageLogBuffer.push({
            log: {
              projectId: payload.projectId,
              taskId: payload.taskId,
              providerMessageId,
              channel: payload.channel,
              attempt: payload.attempt || 1,
              kind: rowKind,
              status: rowStatus,
              templateId: payload.templateId || null,
              workflowInstanceId: payload.workflowInstanceId || null,
              campaignId: payload.campaignId || null,
              timestamp,
            },
            resolve,
            reject,
          });
        });

      // An outcome carrying `dispatchedAt` also stands in for the attempt's
      // dispatched entry, which delivery folded into it. Stamped with the
      // dispatch time so the log still reads dispatched → outcome.
      if (kind === "attempt" && payload.dispatchedAt) {
        publishPromises.push(row("dispatched", "dispatched", null, payload.dispatchedAt));
      }
      publishPromises.push(row(kind, status, payload.providerMessageId || null));
      if (this.messageLogBuffer.length >= this.flushThreshold) {
        void this.flushLogs();
      }
      await Promise.all(publishPromises);
      return;
    }

    if (event.type !== "event.received") {
      return;
    }

    const payload = event.payload as any;
    const eventName = payload.eventName;
    const eventData = payload.payload;
    const projectId = payload.projectId;

    if (!eventName || !projectId) {
      this.logger.warn("Missing eventName or projectId in payload");
      return;
    }

    const now = new Date();
    const waiters = await this.dbConn
      .select()
      .from(workflowWaiters)
      .where(
        and(
          eq(workflowWaiters.eventName, eventName),
          eq(workflowWaiters.projectId, projectId),
          or(isNull(workflowWaiters.expiresAt), gt(workflowWaiters.expiresAt, now)),
        ),
      );

    const data: Record<string, any> = eventData && typeof eventData === "object" ? eventData : {};

    for (const waiter of waiters) {
      let matched = true;
      const criteria = waiter.matchCriteria as Record<string, any>;
      if (criteria && typeof criteria === "object") {
        for (const [k, v] of Object.entries(criteria)) {
          // simple dot notation check for a flat object or 1 level deep
          let dataValue = data[k];
          if (k.includes(".")) {
            const parts = k.split(".");
            dataValue = data;
            for (const p of parts) {
              if (dataValue) dataValue = dataValue[p];
            }
          }
          if (dataValue !== v) {
            matched = false;
            break;
          }
        }
      }

      if (matched) {
        this.logger.info(
          { instanceId: waiter.instanceId, eventName },
          "Event matched a sleeping workflow",
        );

        // The resume event must carry everything WorkflowWorker.process requires
        // (name, instanceId, projectId) or it is dropped and the instance — whose
        // waiter we are about to delete — is stranded forever.
        const instance = (
          await this.dbConn
            .select()
            .from(workflowInstances)
            .where(eq(workflowInstances.id, waiter.instanceId))
            .limit(1)
        )[0];

        if (!instance) {
          this.logger.warn(
            { instanceId: waiter.instanceId },
            "waiter references a missing workflow instance — dropping waiter",
          );
          await this.dbConn.delete(workflowWaiters).where(eq(workflowWaiters.id, waiter.id));
          continue;
        }

        const steps = await this.dbConn
          .select()
          .from(workflowSteps)
          .where(
            and(
              eq(workflowSteps.instanceId, waiter.instanceId),
              eq(workflowSteps.action, "waitForEvent"),
            ),
          );

        // The step still waiting. An instance waits on one event at a time.
        const pendingStep = steps.find((s: any) => s.output === null);

        if (pendingStep) {
          await this.dbConn
            .update(workflowSteps)
            .set({ output: data })
            .where(eq(workflowSteps.id, pendingStep.id));
        }

        // Wake up workflow. Publish BEFORE deleting the waiter: a crash after the
        // delete but before the publish would leave the instance unrecoverable,
        // whereas a duplicate resume is idempotent (the instance lock and the
        // replayed step outputs both absorb it).
        publishPromises.push(
          new Promise((resolve, reject) => {
            this.eventBuffer.push({
              producer: this.workflowProducer,
              event: buildStreamEvent(
                "workflow.resumed",
                {
                  projectId: instance.projectId,
                  instanceId: waiter.instanceId,
                  name: instance.name,
                  input: instance.input ?? {},
                  reason: "event_matched",
                },
                "events",
                event.metadata.traceId,
              ),
              resolve,
              reject,
            });
          }),
        );

        await this.dbConn.delete(workflowWaiters).where(eq(workflowWaiters.id, waiter.id));

        // The timer entry is left; the poll loop drops it once the instance isn't pending.
      }
    }

    await Promise.all(publishPromises);
  }
}

export async function startEventWorker() {
  ({ logger, redis, sql, db } = createWorkerRuntime(config, "events", "event-worker"));
  workflowProducer = new StreamProducer({
    redis: redis.native,
    stream: STREAMS.WORKFLOW_INBOUND,
    logger,
  });
  // Delivery emits two events per message, so this worker has to keep at least
  // as many in flight as delivery does or its stream grows without bound.
  const eventsConcurrency = Math.max(
    config.WORKER_CONCURRENCY,
    config.DELIVERY_CONCURRENCY ?? config.WORKER_CONCURRENCY,
  );
  ({ consumer, pendingScanner } = createStreamConsumer(
    { redis, logger },
    {
      stream: STREAMS.EVENTS_INBOUND,
      group: CONSUMER_GROUPS.EVENTS,
      consumer: uniqueConsumerId("events"),
      batchSize: eventsConcurrency,
      bufferAcks: true,
      // Log rows are not latency-sensitive; let reads fill up.
      coalesceMs: 10,
    },
  ));

  worker = new EventWorker({
    consumer,
    pendingScanner,
    logger,
    concurrency: eventsConcurrency,
    db,
    workflowProducer,
  });

  healthInterval = startHealthReporter("events", worker, redis, logger);

  logger.info("event worker starting");
  await worker.start();
}

export async function stopEventWorker(): Promise<void> {
  await shutdownWorker("event worker", { logger, timers: [healthInterval], worker, sql, redis });
  healthInterval = null;
}
