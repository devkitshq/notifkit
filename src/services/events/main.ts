import { loadEnv, readBaseConfig } from "@/index.js";
import { createLogger } from "@/index.js";
import { RedisClient } from "@/index.js";
import {
  StreamConsumer,
  PendingMessageScanner,
  StreamProducer,
  type StreamMessage,
} from "@/index.js";
import { BaseWorker } from "@/index.js";
import { STREAMS, CONSUMER_GROUPS, buildStreamEvent } from "@/index.js";
import { type StreamName } from "@/contracts/streams.js";
import { createDatabase } from "@/db/index.js";
import { workflowWaiters, workflowSteps, workflowInstances, messageLogs } from "@/db/schema.js";
import { eq, and, or, isNull, gt } from "drizzle-orm";
import { type WorkerOptions } from "@/shared/index.js";
import { startHealthReporter } from "@/workers/index.js";

loadEnv();
const config = readBaseConfig();
let logger: ReturnType<typeof createLogger>;
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
  private isFlushing = false;

  constructor(options: EventWorkerOptions) {
    super(options);
    this.dbConn = options.db;
    this.workflowProducer = options.workflowProducer;
    this.startFlushInterval();
  }

  private startFlushInterval() {
    this.flushInterval = setInterval(() => {
      void this.flushLogs();
    }, config.LOG_FLUSH_INTERVAL_MS);
  }

  private async flushLogs() {
    if (this.isFlushing || (this.messageLogBuffer.length === 0 && this.eventBuffer.length === 0))
      return;
    this.isFlushing = true;

    const startTime = Date.now();
    const batch = this.messageLogBuffer;
    this.messageLogBuffer = [];

    const events = this.eventBuffer;
    this.eventBuffer = [];

    try {
      if (batch.length > 0) {
        await this.dbConn
          .insert(messageLogs)
          .values(batch.map((b) => b.log))
          .onConflictDoNothing(); // Idempotent insert
        for (const b of batch) b.resolve();

        this.logger.info(
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
          error: error.message,
        },
        "failed to flush delivery logs — dropping batch",
      );
      for (const b of batch) b.reject(error);
      for (const e of events) e.reject(error);
    } finally {
      this.isFlushing = false;
    }
  }

  override async stop(): Promise<void> {
    if (this.flushInterval) clearInterval(this.flushInterval);
    await super.stop();
    await this.flushLogs();
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

      publishPromises.push(
        new Promise((resolve, reject) => {
          this.messageLogBuffer.push({
            log: {
              projectId: payload.projectId,
              taskId: payload.taskId,
              providerMessageId: payload.providerMessageId || null,
              channel: payload.channel,
              attempt: payload.attempt || 1,
              kind,
              status,
              templateId: payload.templateId || null,
              workflowInstanceId: payload.workflowInstanceId || null,
              campaignId: payload.campaignId || null,
            },
            resolve,
            reject,
          });
        }),
      );
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

    // Find matching waiters
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
      // Check match criteria
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

        // Find the step that is waiting
        const steps = await this.dbConn
          .select()
          .from(workflowSteps)
          .where(
            and(
              eq(workflowSteps.instanceId, waiter.instanceId),
              eq(workflowSteps.action, "waitForEvent"),
            ),
          );

        // Get the latest one that has no output
        const pendingStep = steps.find((s: any) => s.output === null);

        if (pendingStep) {
          // Update the step with the event payload
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

        // Delete the waiter
        await this.dbConn.delete(workflowWaiters).where(eq(workflowWaiters.id, waiter.id));

        // The timer ZSET entry is left to expire: the poll loop re-checks the
        // instance status and drops the entry if it is no longer pending.
      }
    }

    await Promise.all(publishPromises);
  }
}

export async function startEventWorker() {
  logger = createLogger({ name: "event-worker", level: config.LOG_LEVEL });
  redis = new RedisClient({ url: config.REDIS_URL, name: "events", logger });
  const dbData = createDatabase({ url: config.DATABASE_URL, applicationName: "events", logger });
  sql = dbData.sql;
  db = dbData.db;
  workflowProducer = new StreamProducer({
    redis: redis.native,
    stream: STREAMS.WORKFLOW_INBOUND,
    logger,
  });
  consumer = new StreamConsumer({
    redis: redis.native,
    stream: STREAMS.EVENTS_INBOUND as StreamName,
    group: CONSUMER_GROUPS.EVENTS as any,
    consumer: `events-${process.pid}`,
    dlqStream: STREAMS.DEAD_LETTER,
    batchSize: config.WORKER_CONCURRENCY,
    logger,
  });

  pendingScanner = new PendingMessageScanner({
    redis: redis.native,
    stream: STREAMS.EVENTS_INBOUND as StreamName,
    group: CONSUMER_GROUPS.EVENTS as any,
    consumer: `events-${process.pid}`,
    logger,
  });

  worker = new EventWorker({
    consumer,
    pendingScanner,
    logger,
    concurrency: config.WORKER_CONCURRENCY,
    db,
    workflowProducer,
  });

  healthInterval = startHealthReporter("events", worker, redis, logger);

  logger.info("event worker starting");
  await worker.start();
}

export async function stopEventWorker(): Promise<void> {
  logger?.info("shutdown initiated");
  if (healthInterval) clearInterval(healthInterval);
  if (worker) await worker.stop();
  if (sql) await sql.end();
  if (redis) await redis.disconnect();
  logger?.info("event worker stopped");
}
