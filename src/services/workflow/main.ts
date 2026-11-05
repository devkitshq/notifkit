import { randomUUID } from "node:crypto";
import { loadEnv, readBaseConfig } from "@/index.js";
import type { Logger } from "@/index.js";
import type { RedisClient, Redis } from "@/index.js";
import {
  type StreamConsumer,
  type PendingMessageScanner,
  StreamProducer,
  type StreamMessage,
} from "@/index.js";
import { BaseWorker } from "@/index.js";
import { STREAMS, CONSUMER_GROUPS, buildStreamEvent } from "@/index.js";
import {
  workflowInstances,
  workflowSteps,
  workflowWaiters,
  workflowDefinitions,
} from "@/db/schema.js";
import { eq, and } from "drizzle-orm";
import {
  workflowRegistry,
  SuspendExecutionError,
  buildStepNotifyPayload,
  type WorkflowContext,
  type WorkflowStepContext,
} from "@/workflows/index.js";
import { type WorkerOptions } from "@/shared/index.js";
import { startHealthReporter } from "@/workers/index.js";
import {
  createStreamConsumer,
  createWorkerRuntime,
  shutdownWorker,
  uniqueConsumerId,
} from "@/workers/bootstrap.js";
import { WORKFLOW_TIMERS_KEY, pollWorkflowTimers, reapStuckInstances } from "./timers.js";
import { durationToMs, parseDurationSeconds } from "./duration.js";

export { WORKFLOW_TIMERS_KEY, parseDurationSeconds };

/** How long a workflow instance lock is held before it self-expires. */
const WORKFLOW_LOCK_TTL_SECONDS = 60;
/** Renew the lock well inside its TTL so long-running handlers keep it. */
const WORKFLOW_LOCK_RENEW_MS = (WORKFLOW_LOCK_TTL_SECONDS / 3) * 1000;
/** How soon a resume that found its instance busy is tried again. */
const WORKFLOW_RESUME_RETRY_MS = 2_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown at a step boundary once the instance has been canceled. */
class WorkflowCanceledError extends Error {
  constructor() {
    super("Workflow instance was canceled");
    this.name = "WorkflowCanceledError";
  }
}

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
let pollInterval: NodeJS.Timeout | null = null;
let reaperInterval: NodeJS.Timeout | null = null;

let notificationProducer: StreamProducer;
let workflowProducer: StreamProducer;

export interface WorkflowWorkerOptions extends WorkerOptions {
  redis: Redis;
  db: any;
  workflowProducer: any;
  notificationProducer: any;
}

export class WorkflowWorker extends BaseWorker {
  private readonly redisCli: Redis;
  private readonly dbConn: any;
  private readonly notificationProducer: any;

  private eventBuffer: {
    producer: any;
    event: any;
    resolve: (result?: { messageId: string; notificationId: string }) => void;
    reject: (err: any) => void;
  }[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(options: WorkflowWorkerOptions) {
    super(options);
    this.redisCli = options.redis;
    this.dbConn = options.db;
    this.notificationProducer = options.notificationProducer;

    this.flushTimer = setInterval(() => void this.flushWorkerBuffers(), 100);
  }

  override async stop(): Promise<void> {
    // Keep the flush interval until in-flight runs settle; a step's notify waits on it.
    await super.stop();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushWorkerBuffers();
  }

  private async flushWorkerBuffers(): Promise<void> {
    if (this.eventBuffer.length === 0) return;

    const events = this.eventBuffer;
    this.eventBuffer = [];

    try {
      const byProducer = new Map<any, typeof events>();
      for (const item of events) {
        if (!byProducer.has(item.producer)) byProducer.set(item.producer, []);
        byProducer.get(item.producer)!.push(item);
      }

      for (const [producer, batch] of byProducer) {
        const { messageIds, eventIds } = await producer.publishBatch(batch.map((b) => b.event));
        for (let i = 0; i < batch.length; i++) {
          const mId = messageIds[i];
          const eId = eventIds[i];
          if (mId && eId) batch[i]!.resolve({ messageId: mId, notificationId: eId });
        }
      }
    } catch (err: any) {
      this.logger.error({ err }, "failed to flush workflow worker buffer");
      for (const e of events) e.reject(err);
    }
  }

  /**
   * Re-delivers a resume through the timer ZSET a few seconds from now. The
   * poll loop publishes it once the instance is pending again, and drops it if
   * the instance has finished. The member carries no timestamp, so repeated
   * deferrals of one instance collapse into a single entry. It is marked
   * `deferred` so it never equals a `wait` timer's member: sharing one let the
   * ZADD here re-score a sleep's wake-up to seconds from now, and the early
   * resume then re-suspended with no timer left to wake it.
   */
  private async deferResume(payload: any): Promise<void> {
    await this.redisCli.zadd(
      WORKFLOW_TIMERS_KEY,
      Date.now() + WORKFLOW_RESUME_RETRY_MS,
      JSON.stringify({
        instanceId: payload.instanceId,
        name: payload.name,
        projectId: payload.projectId,
        input: payload.input ?? {},
        deferred: true,
      }),
    );
  }

  async process(message: StreamMessage): Promise<void> {
    const { event } = message;
    if (event.type !== "workflow.triggered" && event.type !== "workflow.resumed") {
      return;
    }

    const payload = event.payload as any;
    const name = payload.name;
    const instanceId = payload.instanceId;

    if (!name || !instanceId || !payload.projectId) {
      this.logger.warn("Missing name, instanceId, or projectId in workflow event");
      return;
    }

    let handler = workflowRegistry.get(name);
    if (!handler) {
      const defRows = await this.dbConn
        .select()
        .from(workflowDefinitions)
        .where(
          and(
            eq(workflowDefinitions.projectId, payload.projectId),
            eq(workflowDefinitions.name, name),
          ),
        )
        .limit(1);

      if (defRows.length === 0) {
        this.logger.warn(
          { name, projectId: payload.projectId },
          "No handler or dynamic definition found for workflow",
        );
        return;
      }

      const def = defRows[0];
      handler = async ({ step }) => {
        const steps = def.steps as any[];
        for (const stepDef of steps) {
          if (stepDef.action === "notify") {
            // A payload target wins; naming none inherits the instance user.
            await step.notify(stepDef.payload);
          } else if (stepDef.action === "wait") {
            await step.wait(stepDef.duration);
          } else if (stepDef.action === "waitForEvent") {
            await step.waitForEvent(stepDef.event, stepDef.options);
          } else {
            this.logger.warn(
              { action: (stepDef as any)?.action, name },
              "unknown workflow step action",
            );
          }
        }
      };
    }

    const lockKey = `lock:workflow:${instanceId}`;
    const lockToken = randomUUID();
    const acquired = await this.redisCli.set(
      lockKey,
      lockToken,
      "EX",
      WORKFLOW_LOCK_TTL_SECONDS,
      "NX",
    );
    if (!acquired) {
      // Another process is mid-run, often still saving the suspension this resume
      // answers. The waiter is already consumed, so the resume must not be dropped.
      this.logger.info({ instanceId }, "Workflow is locked by another process, deferring resume");
      await this.deferResume(payload);
      return;
    }

    // Keep the lock alive while the handler runs; without this a handler that
    // outlives the TTL lets a second resume execute the same steps in parallel.
    const renewTimer = setInterval(() => {
      void this.redisCli
        .renewLock(lockKey, lockToken, WORKFLOW_LOCK_TTL_SECONDS)
        .catch((err: unknown) => {
          this.logger.warn({ err, instanceId }, "failed to renew workflow lock");
        });
    }, WORKFLOW_LOCK_RENEW_MS);

    try {
      let instance = (
        await this.dbConn
          .select()
          .from(workflowInstances)
          .where(eq(workflowInstances.id, instanceId))
          .limit(1)
      )[0];
      if (!instance) {
        const rows = await this.dbConn
          .insert(workflowInstances)
          .values({
            id: instanceId,
            projectId: payload.projectId,
            name: name,
            status: "pending",
            input: payload.input || {},
          })
          .returning();
        instance = rows[0]!;
      }

      if (instance.status === "running") {
        // Its last holder died mid-run (the reaper will set it back to
        // pending) or has not finished suspending. Either way this resume
        // is still owed.
        await this.deferResume(payload);
        return;
      }
      if (instance.status !== "pending") {
        this.logger.info({ instanceId }, "Workflow is not pending, skipping");
        return;
      }

      // Conditional, so a cancel that lands between the read above and here
      // is not overwritten.
      const claimed = await this.dbConn
        .update(workflowInstances)
        .set({ status: "running" })
        .where(and(eq(workflowInstances.id, instanceId), eq(workflowInstances.status, "pending")))
        .returning({ id: workflowInstances.id });
      if (claimed.length === 0) {
        this.logger.info({ instanceId }, "Workflow is no longer pending, skipping");
        return;
      }

      // A cancel can arrive while the handler runs. Checked before each new
      // step, so a canceled instance stops at the next step boundary.
      const stopIfCanceled = async () => {
        const [row] = await this.dbConn
          .select({ status: workflowInstances.status })
          .from(workflowInstances)
          .where(eq(workflowInstances.id, instanceId))
          .limit(1);
        if (row?.status === "canceled") throw new WorkflowCanceledError();
      };

      const existingSteps = await this.dbConn
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.instanceId, instanceId));
      const stepOutputMap = new Map<string, any>();
      for (const s of existingSteps) {
        stepOutputMap.set(s.stepIndex, s.output);
      }

      let currentStepIndex = 0;

      const stepProxy: WorkflowStepContext = {
        notify: async (args) => {
          const stepId = String(currentStepIndex++);
          if (stepOutputMap.has(stepId)) return stepOutputMap.get(stepId);
          await stopIfCanceled();

          // The step payload is the same shape as notify(), but the wire event
          // is not — translate rather than spread.
          const requested = buildStepNotifyPayload(
            args,
            instance!.input,
            payload.projectId,
            `wf-${instanceId}-${stepId}`,
            // The contract wants a uuid, which the API always issues; anything
            // else would fail validation and drop the notification.
            UUID_RE.test(instanceId) ? instanceId : undefined,
          );

          const result = await new Promise<{ messageId: string; notificationId: string }>(
            (resolve, reject) => {
              this.eventBuffer.push({
                producer: this.notificationProducer,
                event: buildStreamEvent(
                  "notification.requested",
                  requested as unknown as Record<string, unknown>,
                  "workflow",
                  event.metadata.traceId,
                ),
                resolve: resolve as any,
                reject,
              });
            },
          );

          const output = {
            success: true,
            messageId: result.messageId,
            notificationId: result.notificationId,
          };

          await this.dbConn.insert(workflowSteps).values({
            instanceId: instance!.id,
            projectId: payload.projectId,
            stepIndex: stepId,
            action: "notify",
            output,
          });

          return output;
        },
        wait: async (duration) => {
          const stepId = String(currentStepIndex++);
          if (stepOutputMap.has(stepId)) {
            // A resume that arrives early — a duplicate trigger, a replayed
            // message — must not cut the sleep short. The timer is still set.
            const until = Number(stepOutputMap.get(stepId)?.scheduledAt);
            if (Number.isFinite(until) && until > Date.now()) {
              throw new SuspendExecutionError("wait", { duration });
            }
            return;
          }
          await stopIfCanceled();

          const ms = durationToMs(duration, "wait duration");

          const resumeAt = Date.now() + ms;

          // Persist the wake-up signal before committing the suspended state.
          // If the process dies after this point the source event is retried;
          // if it dies after the database write, the timer is already durable.
          await this.redisCli.zadd(
            WORKFLOW_TIMERS_KEY,
            resumeAt,
            JSON.stringify({
              instanceId: instance!.id,
              name: instance!.name,
              projectId: payload.projectId,
              input: instance!.input,
            }),
          );

          await this.dbConn.insert(workflowSteps).values({
            instanceId: instance!.id,
            projectId: payload.projectId,
            stepIndex: stepId,
            action: "wait",
            output: { scheduledAt: resumeAt },
          });

          throw new SuspendExecutionError("wait", { duration });
        },
        waitForEvent: async (eventName, options) => {
          const stepId = String(currentStepIndex++);
          if (stepOutputMap.has(stepId)) {
            const out = stepOutputMap.get(stepId);
            // Still waiting: neither the event nor the timeout has filled the
            // step in, so this resume is spurious.
            if (out === null || out === undefined) {
              throw new SuspendExecutionError("waitForEvent", { eventName });
            }
            if (typeof out === "object" && (out as any).timedOut === true) {
              return null;
            }
            return out;
          }
          await stopIfCanceled();

          options = options || {};
          options.timeout = options.timeout || "24h";
          options.match = options.match || {};

          const ms = durationToMs(options.timeout, "waitForEvent timeout");

          const resumeAt = Date.now() + ms;

          await this.redisCli.zadd(
            WORKFLOW_TIMERS_KEY,
            resumeAt,
            JSON.stringify({
              instanceId: instance!.id,
              name: instance!.name,
              projectId: payload.projectId,
              input: instance!.input,
              isEventTimeout: true,
              eventName,
              stepId,
            }),
          );

          // The pending step before the waiter: an event that matches the
          // waiter the moment it exists must find a step to record itself in.
          await this.dbConn.insert(workflowSteps).values({
            instanceId: instance!.id,
            projectId: payload.projectId,
            stepIndex: stepId,
            action: "waitForEvent",
            output: null, // this will be updated by event worker or timeout
          });

          await this.dbConn.insert(workflowWaiters).values({
            instanceId: instance!.id,
            projectId: payload.projectId,
            eventName: eventName,
            matchCriteria: options.match,
            expiresAt: new Date(resumeAt),
          });

          throw new SuspendExecutionError("waitForEvent", { eventName });
        },
        run: async (stepName, fn) => {
          const stepId = String(currentStepIndex++);
          if (stepOutputMap.has(stepId)) return stepOutputMap.get(stepId);
          await stopIfCanceled();

          const result = await fn();
          await this.dbConn.insert(workflowSteps).values({
            instanceId: instance!.id,
            projectId: payload.projectId,
            stepIndex: stepId,
            action: "run",
            output: result,
          });
          return result;
        },
      };

      const ctx: WorkflowContext = {
        step: stepProxy,
        event: (instance!.input as any) || { user: { id: "unknown" } },
      };

      // Only from `running`: a cancel that landed mid-run must stand.
      const finish = (status: "completed" | "pending" | "failed") =>
        this.dbConn
          .update(workflowInstances)
          .set({ status })
          .where(
            and(eq(workflowInstances.id, instance!.id), eq(workflowInstances.status, "running")),
          );

      try {
        await handler(ctx);
        // If we reach here, workflow completed
        await finish("completed");
        this.logger.info({ instanceId: instance!.id }, "Workflow completed successfully");
      } catch (err: any) {
        if (err instanceof WorkflowCanceledError) {
          this.logger.info({ instanceId: instance!.id }, "Workflow canceled mid-run, stopping");
        } else if (err instanceof SuspendExecutionError || err.name === "SuspendExecutionError") {
          await finish("pending");
          this.logger.info({ instanceId: instance!.id, reason: err.reason }, "Workflow suspended");
        } else {
          this.logger.error({ err, instanceId: instance!.id }, "Workflow failed");
          await finish("failed");
        }
      }
    } finally {
      clearInterval(renewTimer);
      // Compare-and-delete: never release a lock a later process re-acquired.
      await this.redisCli.releaseLock(lockKey, lockToken);
    }
  }
}

export function __injectForTests(r: any, d: any, wp: any, np: any) {
  redis = r;
  db = d;
  workflowProducer = wp;
  notificationProducer = np;
}

export async function startWorkflowWorker() {
  ({ logger, redis, sql, db } = createWorkerRuntime(config, "workflow", "workflow-worker"));
  notificationProducer = new StreamProducer({
    redis: redis.native,
    stream: STREAMS.INBOUND_NORMAL,
    logger,
  });
  workflowProducer = new StreamProducer({
    redis: redis.native,
    stream: STREAMS.WORKFLOW_INBOUND,
    logger,
  });
  ({ consumer, pendingScanner } = createStreamConsumer(
    { redis, logger },
    {
      stream: STREAMS.WORKFLOW_INBOUND,
      group: CONSUMER_GROUPS.WORKFLOW,
      consumer: uniqueConsumerId("workflow"),
      batchSize: config.WORKER_CONCURRENCY,
    },
  ));

  worker = new WorkflowWorker({
    consumer,
    pendingScanner,
    logger,
    concurrency: config.WORKER_CONCURRENCY,
    redis: redis.native,
    db,
    workflowProducer,
    notificationProducer,
  });

  pollInterval = setInterval(() => {
    void pollWorkflowTimers({ redis, db, logger, workflowProducer });
  }, 5000);

  reaperInterval = setInterval(() => {
    void reapStuckInstances({ redis, db, logger });
  }, 60000);

  healthInterval = startHealthReporter("workflow", worker, redis, logger);

  logger.info("workflow worker starting");
  await worker.start();
}

export async function stopWorkflowWorker(): Promise<void> {
  await shutdownWorker("workflow worker", {
    logger,
    timers: [healthInterval, pollInterval, reaperInterval],
    worker,
    sql,
    redis,
  });
  healthInterval = null;
  pollInterval = null;
  reaperInterval = null;
}
