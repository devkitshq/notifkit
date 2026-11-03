import { randomUUID } from "node:crypto";
import { loadEnv, readBaseConfig } from "@/index.js";
import type { Logger } from "@/index.js";
import type { RedisClient, Redis } from "@/index.js";
import { type StreamConsumer, type PendingMessageScanner, type StreamMessage } from "@/index.js";
import { BaseWorker } from "@/index.js";
import {
  STREAMS,
  CONSUMER_GROUPS,
  registry,
  type EventRegistry,
  buildStreamEvent,
} from "@/index.js";
import { getPriorityBucket, globalEmitter, type WorkerOptions } from "@/shared/index.js";
import { scheduledPayloads } from "@/db/schema.js";
import { and, asc, eq, gt, inArray, or, sql as drizzleSql } from "drizzle-orm";
import { startHealthReporter } from "@/workers/index.js";
import {
  createPriorityProducers,
  createStreamConsumer,
  createWorkerRuntime,
  shutdownWorker,
  uniqueConsumerId,
} from "@/workers/bootstrap.js";
import { findBlockedAtRelease } from "./send-gate.js";
import { maybePruneDeliveryLogs } from "./retention.js";
// ─── Bootstrap ─────────────────────────────────────────────────────────────

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
let pollTimeout: ReturnType<typeof setTimeout> | null = null;
let isPolling = false;

/** Scheduled tasks are spread over 16 sorted sets by the last hex digit of the task id. */
const shardOf = (taskId: string): number => parseInt(taskId.slice(-1), 16) || 0;
const zsetKey = (shard: number): string => `notif:scheduled:zset:${shard}`;

export interface SchedulerWorkerOptions extends WorkerOptions {
  registry: EventRegistry;
  redis: Redis;
}

export class SchedulerWorker extends BaseWorker {
  private readonly registry: EventRegistry;
  private readonly redisCli: Redis;

  constructor(options: SchedulerWorkerOptions) {
    super(options);
    this.registry = options.registry;
    this.redisCli = options.redis;
  }
  async process(message: StreamMessage): Promise<void> {
    const { event } = message;

    const payloadResult = this.registry.safeParsePayload("notification.scheduled", event.payload);
    if (!payloadResult.success) {
      this.logger.warn(
        { messageId: message.id, issues: payloadResult.error.issues },
        "invalid notification.scheduled payload — skipping",
      );
      return;
    }

    const scheduled = payloadResult.data;
    const scheduledAt = new Date(scheduled.scheduledAt).getTime();

    const taskData = JSON.stringify({
      taskId: scheduled.taskId,
      enrichedEventId: scheduled.enrichedEventId,
      traceId: event.metadata.traceId,
    });

    const shard = shardOf(scheduled.taskId);
    await this.redisCli.zadd(zsetKey(shard), scheduledAt, taskData);
    this.logger.debug(
      { taskId: scheduled.taskId, scheduledAt: scheduled.scheduledAt, shard },
      "scheduled task queued in ZSET",
    );
  }
}

export async function executeSchedulerPoll(
  redis: Redis,
  outboundProducers: any,
  logger: any,
  db: any,
): Promise<boolean> {
  const lockKey = "notif:lock:scheduler:poll";
  const lockOwner = randomUUID();
  let acquired = false;
  try {
    const lockAcquired = await redis.set(lockKey, lockOwner, "EX", 30, "NX");
    if (lockAcquired !== "OK") {
      return false; // Another instance is currently polling
    }
    acquired = true;

    const now = Date.now();
    const visibilityTimeout = 60000; // 60 seconds
    const perShardLimit = 100;
    const pipeline = redis.pipeline();

    for (let i = 0; i < 16; i++) {
      const shardKey = zsetKey(i);
      pipeline.schedulerPoll(shardKey, now, perShardLimit, visibilityTimeout);
    }

    const results = await pipeline.exec();
    const perShard = results?.map((res: any) => (res[0] ? [] : ((res[1] ?? []) as string[]))) ?? [];
    const tasks = perShard.flat();
    // A shard that came back full may still have due tasks behind it, which is
    // what tells the caller to poll again rather than wait for the next tick.
    const anyShardFull = perShard.some((shard) => shard.length >= perShardLimit);

    if (tasks.length === 0) return false;

    const parsedTasks = tasks
      .map((t) => {
        try {
          return { taskStr: t, ...JSON.parse(t) };
        } catch (err) {
          logger.error({ taskStr: t, err }, "failed to parse scheduled task JSON");
          return null;
        }
      })
      .filter(Boolean) as any[];
    if (parsedTasks.length === 0) return false;

    const taskIds = parsedTasks.map((t) => t.taskId);
    const dbPayloads = await db
      .select()
      .from(scheduledPayloads)
      .where(inArray(scheduledPayloads.taskId, taskIds));
    const payloadMap = new Map(dbPayloads.map((row: any) => [row.taskId, row.payload]));

    // What the person did while this sat parked still applies. A failed
    // lookup throws to the catch below: the claimed tasks reappear after the
    // visibility timeout instead of going out unchecked.
    const blocked = await findBlockedAtRelease(db, [...payloadMap.values()] as any[]);

    const batchedEvents: Record<"critical" | "normal" | "low", Omit<any, "id" | "timestamp">[]> = {
      critical: [],
      normal: [],
      low: [],
    };

    const cleanupPipeline = redis.pipeline();
    const dbCleanupIds: string[] = [];

    // After a rebuild the same task can sit in the ZSET twice (the original
    // member carries a trace id Postgres does not keep), so release each task
    // once and just clear any second copy.
    const released = new Set<string>();

    for (let i = 0; i < parsedTasks.length; i++) {
      const { taskStr, taskId, traceId } = parsedTasks[i];
      if (released.has(taskId)) {
        cleanupPipeline.zrem(zsetKey(shardOf(taskId)), taskStr);
        continue;
      }
      const payload = payloadMap.get(taskId);

      if (!payload) {
        logger.warn({ taskId }, "scheduled payload not found in Postgres — skipping release");
        cleanupPipeline.zrem(zsetKey(shardOf(taskId)), taskStr);
        continue;
      }

      const dispatchPayload = payload as any;

      const blockReason = blocked.get(taskId);
      if (blockReason) {
        logger.info({ taskId, reason: blockReason }, "parked send no longer allowed — dropping");
        globalEmitter.emit("notification:skipped", {
          projectId: dispatchPayload.projectId,
          eventId: dispatchPayload.enrichedEventId,
          recipientId: dispatchPayload.recipientId,
          reason: blockReason,
        });
        released.add(taskId);
        dbCleanupIds.push(taskId);
        cleanupPipeline.zrem(zsetKey(shardOf(taskId)), taskStr);
        continue;
      }

      const p = getPriorityBucket(dispatchPayload.priority);

      batchedEvents[p].push(
        buildStreamEvent("notification.dispatched", dispatchPayload, "scheduler", traceId),
      );

      released.add(taskId);
      dbCleanupIds.push(taskId);
      cleanupPipeline.zrem(zsetKey(shardOf(taskId)), taskStr);
    }

    // Every bucket, not a hardcoded subset: a task binned into one that is not
    // published here has already been added to the cleanup list, so it would be
    // deleted from Redis and Postgres without ever being sent.
    for (const p of Object.keys(batchedEvents) as (keyof typeof batchedEvents)[]) {
      if (batchedEvents[p].length > 0) {
        const producer = outboundProducers[p] ?? outboundProducers["normal"]!;
        await producer!.publishBatch(batchedEvents[p]);
      }
    }

    if (dbCleanupIds.length > 0) {
      try {
        // Only the payload that was released. By now delivery may have
        // throttled the task and parked it again under the same id with a
        // later send time; deleting by id alone removed that newer payload,
        // and its ZSET entry was then dropped as canceled — the send was lost.
        const sendAt = drizzleSql`${scheduledPayloads.payload}->>'scheduledAt'`;
        await db.delete(scheduledPayloads).where(
          or(
            ...dbCleanupIds.map((taskId) => {
              const released = (payloadMap.get(taskId) as any)?.scheduledAt;
              return and(
                eq(scheduledPayloads.taskId, taskId),
                typeof released === "string"
                  ? drizzleSql`${sendAt} = ${released}`
                  : drizzleSql`${sendAt} IS NULL`,
              );
            }),
          ),
        );
      } catch (err) {
        logger.error(
          { err },
          "failed to delete scheduled payloads from Postgres, continuing with Redis cleanup",
        );
      }
    }
    await cleanupPipeline.exec();

    logger.info({ count: parsedTasks.length }, "scheduled tasks released to outbound");

    // "Poll again immediately" — the caller loops while this is true. The old
    // test was `tasks.length === 100` against a total drawn from 16 shards, so
    // a real backlog reported "nothing more" and waited for the next tick.
    return anyShardFull;
  } catch (err) {
    logger.error({ err }, "error in scheduler polling loop");
    return false;
  } finally {
    if (acquired) {
      await redis.releaseLock(lockKey, lockOwner).catch(() => {});
    }
  }
}

/**
 * Present while the scheduler ZSETs are known to be intact. Redis losing its
 * data (a flush, a restart without persistence, failover to an empty replica)
 * takes this key with it, which is how the poll loop notices.
 */
export const SCHEDULER_SENTINEL_KEY = "notif:scheduler:intact";

/**
 * Re-queues every scheduled send still waiting in Postgres. Each row keeps its
 * payload, and with it the send time, so the ZSETs can be rebuilt exactly;
 * a legacy row without a send time is released on the next poll.
 *
 * Only run when the sentinel is missing: a rebuilt member has no trace id and
 * so never matches a surviving original, and the poll only de-duplicates
 * copies that happen to be claimed together.
 */
export async function rebuildScheduledQueue(
  redis: Redis,
  db: any,
  logger: Logger,
  pageSize = 1000,
): Promise<number> {
  let after: string | undefined;
  let total = 0;
  for (;;) {
    const rows: { taskId: string; payload: any }[] = await db
      .select({ taskId: scheduledPayloads.taskId, payload: scheduledPayloads.payload })
      .from(scheduledPayloads)
      .where(after === undefined ? undefined : gt(scheduledPayloads.taskId, after))
      .orderBy(asc(scheduledPayloads.taskId))
      .limit(pageSize);
    if (rows.length === 0) break;

    const pipeline = redis.pipeline();
    for (const { taskId, payload } of rows) {
      const sendAt = Date.parse(payload?.scheduledAt ?? "");
      const member = JSON.stringify({ taskId, enrichedEventId: payload?.enrichedEventId });
      pipeline.zadd(
        zsetKey(shardOf(taskId)),
        "NX",
        Number.isNaN(sendAt) ? Date.now() : sendAt,
        member,
      );
    }
    await pipeline.exec();

    total += rows.length;
    after = rows[rows.length - 1]!.taskId;
    if (rows.length < pageSize) break;
  }
  // Last, so a crash part-way leaves the sentinel missing and the next poll retries.
  await redis.set(SCHEDULER_SENTINEL_KEY, "1");
  if (total > 0) logger.warn({ count: total }, "rebuilt scheduled queue from Postgres");
  return total;
}

export async function startSchedulerWorker() {
  ({ logger, redis, sql, db } = createWorkerRuntime(config, "scheduler"));
  ({ consumer, pendingScanner } = createStreamConsumer(
    { redis, logger },
    {
      stream: STREAMS.SCHEDULED,
      group: CONSUMER_GROUPS.SCHEDULER,
      consumer: uniqueConsumerId("scheduler"),
      batchSize: config.WORKER_CONCURRENCY,
    },
  ));

  const outboundProducers = createPriorityProducers(redis.native, logger, "OUTBOUND");

  worker = new SchedulerWorker({
    consumer,
    pendingScanner,
    logger,
    concurrency: config.WORKER_CONCURRENCY,
    registry,
    redis: redis.native,
  });

  // ─── Polling Loop ─────────────────────────────────────────────────────────
  isPolling = true;
  const pollLoop = async (): Promise<void> => {
    if (!isPolling) return;
    try {
      if (!(await redis.native.exists(SCHEDULER_SENTINEL_KEY))) {
        await rebuildScheduledQueue(redis.native, db, logger);
      }
      void maybePruneDeliveryLogs(redis.native, db, logger, config.LOG_RETENTION_DAYS);
      const hasMore = await executeSchedulerPoll(redis.native, outboundProducers, logger, db);
      if (isPolling) {
        pollTimeout = setTimeout(() => void pollLoop(), hasMore ? 0 : 5000);
      }
    } catch (err) {
      logger.error({ err }, "scheduler poll loop error");
      if (isPolling) {
        pollTimeout = setTimeout(() => void pollLoop(), 5000);
      }
    }
  };
  void pollLoop();

  // ─── Health check interval ──────────────────────────────────────────────────

  healthInterval = startHealthReporter("scheduler", worker, redis, logger);

  logger.info({ env: config.NODE_ENV }, "scheduler starting");
  await worker.start();
}

// ─── Shutdown ──────────────────────────────────────────────────────────────

export async function stopSchedulerWorker(): Promise<void> {
  isPolling = false;
  await shutdownWorker("scheduler", {
    logger,
    timers: [healthInterval, pollTimeout],
    worker,
    sql,
    redis,
  });
  healthInterval = null;
  pollTimeout = null;
}
