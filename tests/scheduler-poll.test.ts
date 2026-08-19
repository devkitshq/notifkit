import { describe, it, expect, vi } from "vitest";
import { executeSchedulerPoll } from "@/services/scheduler/main.js";
import { scheduledPayloads } from "@/db/schema.js";
import { createMockDb, type MockDb } from "./helpers/mock-db.js";

/**
 * The scheduler's release loop: take a distributed lock, claim due tasks out of
 * 16 ZSET shards under a visibility timeout, join them to their payloads in
 * Postgres, publish, then clean up both stores.
 *
 * Its failure modes are all quiet ones — a task released twice, a task dropped,
 * an orphan left in Redis to be re-claimed forever — so the assertions below are
 * about what happens to a task that does *not* take the happy path.
 */

const SHARDS = 16;

function task(taskId: string, traceId = "trace-1") {
  return JSON.stringify({ taskId, enrichedEventId: "evt-1", traceId });
}

/** 16 shard replies, all empty apart from the ones supplied. */
function shardReplies(tasksByShard: Record<number, string[]> = {}): any[] {
  return Array.from({ length: SHARDS }, (_, i) => [null, tasksByShard[i] ?? []]);
}

interface Producer {
  publishBatch: ReturnType<typeof vi.fn>;
}

interface Harness {
  redis: any;
  pollPipeline: any;
  cleanupPipeline: any;
  /** `critical` is deleted by the fallback test, so it is optional here. */
  producers: { critical?: Producer; normal: Producer; low: Producer };
  logger: any;
  mockDb: MockDb;
}

function harness(options: { shards?: any[]; lock?: string | null } = {}): Harness {
  const pollPipeline = {
    eval: vi.fn(),
    exec: vi.fn().mockResolvedValue(options.shards ?? shardReplies()),
  };
  const cleanupPipeline = { zrem: vi.fn(), exec: vi.fn().mockResolvedValue([]) };

  let pipelineCall = 0;
  const redis = {
    set: vi.fn().mockResolvedValue(options.lock === undefined ? "OK" : options.lock),
    eval: vi.fn().mockResolvedValue(1),
    pipeline: vi.fn(() => (pipelineCall++ === 0 ? pollPipeline : cleanupPipeline)),
  };

  return {
    redis,
    pollPipeline,
    cleanupPipeline,
    producers: {
      critical: { publishBatch: vi.fn() },
      normal: { publishBatch: vi.fn() },
      low: { publishBatch: vi.fn() },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockDb: createMockDb(),
  };
}

const run = (h: Harness) =>
  executeSchedulerPoll(h.redis as any, h.producers as any, h.logger, h.mockDb.db);

describe("executeSchedulerPoll", () => {
  describe("the poll lock", () => {
    it("backs off without polling when another instance holds the lock", async () => {
      const h = harness({ lock: null });

      await expect(run(h)).resolves.toBe(false);
      expect(h.redis.pipeline).not.toHaveBeenCalled();
    });

    it("takes the lock with NX and an expiry, so a crashed poller cannot hold it forever", async () => {
      const h = harness();
      await run(h);

      expect(h.redis.set).toHaveBeenCalledWith(
        "notif:lock:scheduler:poll",
        expect.any(String),
        "EX",
        30,
        "NX",
      );
    });

    it("releases the lock only if it still owns it", async () => {
      const h = harness();
      await run(h);

      // A compare-and-delete: an expired lock now held by another poller must
      // not be deleted by this one.
      const [script, keyCount, key, owner] = h.redis.eval.mock.calls.at(-1)!;
      expect(script).toContain('redis.call("get", KEYS[1])');
      expect(script).toContain('redis.call("del", KEYS[1])');
      expect(keyCount).toBe(1);
      expect(key).toBe("notif:lock:scheduler:poll");
      expect(owner).toBe(h.redis.set.mock.calls[0]![1]);
    });

    it("does not release a lock it never took", async () => {
      const h = harness({ lock: null });
      await run(h);

      expect(h.redis.eval).not.toHaveBeenCalled();
    });

    it("releases the lock even when the poll throws", async () => {
      const h = harness();
      h.pollPipeline.exec.mockRejectedValue(new Error("redis gone"));

      await expect(run(h)).resolves.toBe(false);
      expect(h.logger.error).toHaveBeenCalled();
      expect(h.redis.eval).toHaveBeenCalledTimes(1);
    });
  });

  describe("claiming due tasks", () => {
    it("polls all 16 shards with a visibility timeout", async () => {
      const h = harness();
      await run(h);

      expect(h.pollPipeline.eval).toHaveBeenCalledTimes(SHARDS);
      for (let i = 0; i < SHARDS; i++) {
        expect(h.pollPipeline.eval).toHaveBeenCalledWith(
          expect.any(String),
          1,
          `notif:scheduled:zset:${i}`,
          expect.any(Number),
          100,
          60_000,
        );
      }
    });

    it("reports nothing to do when every shard is empty", async () => {
      const h = harness();

      await expect(run(h)).resolves.toBe(false);
      expect(h.producers.normal.publishBatch).not.toHaveBeenCalled();
    });

    it("skips a shard whose script errored instead of failing the whole poll", async () => {
      const shards = shardReplies({ 1: [task("task-1")] });
      shards[2] = [new Error("NOSCRIPT"), null];
      const h = harness({ shards });
      h.mockDb.queueSelect([{ taskId: "task-1", payload: { priority: "normal" } }]);

      await run(h);

      expect(h.producers.normal.publishBatch).toHaveBeenCalledTimes(1);
    });

    it("asks for another round when it filled its batch", async () => {
      // 100 tasks came back, which is the page size — there may be more due.
      const many = Array.from({ length: 100 }, (_, i) => task(`task-${i}`));
      const h = harness({ shards: shardReplies({ 0: many }) });
      h.mockDb.queueSelect(
        Array.from({ length: 100 }, (_, i) => ({
          taskId: `task-${i}`,
          payload: { priority: "normal" },
        })),
      );

      await expect(run(h)).resolves.toBe(true);
    });

    it("asks for another round when any single shard filled up", async () => {
      // The signal is per-shard: a total drawn from 16 shards says nothing
      // about whether any one of them still has due tasks behind it.
      const full = Array.from({ length: 100 }, (_, i) => task(`task-a${i}`));
      const h = harness({ shards: shardReplies({ 7: full, 9: [task("task-b")] }) });
      h.mockDb.queueSelect([
        ...full.map((_, i) => ({ taskId: `task-a${i}`, payload: { priority: "normal" } })),
        { taskId: "task-b", payload: { priority: "normal" } },
      ]);

      await expect(run(h)).resolves.toBe(true);
    });

    it("does not ask for another round just because the shards added up", async () => {
      // 160 tasks across 16 shards, none of which hit its own limit.
      const tasksByShard: Record<number, string[]> = {};
      for (let i = 0; i < SHARDS; i++) {
        tasksByShard[i] = Array.from({ length: 10 }, (_, j) => task(`task-${i}-${j}`));
      }
      const h = harness({ shards: shardReplies(tasksByShard) });
      h.mockDb.queueSelect(
        Object.values(tasksByShard)
          .flat()
          .map((t) => ({ taskId: JSON.parse(t).taskId, payload: { priority: "normal" } })),
      );

      await expect(run(h)).resolves.toBe(false);
    });

    it("stops after a partial batch", async () => {
      const h = harness({ shards: shardReplies({ 0: [task("task-1")] }) });
      h.mockDb.queueSelect([{ taskId: "task-1", payload: { priority: "normal" } }]);

      await expect(run(h)).resolves.toBe(false);
    });
  });

  describe("releasing tasks", () => {
    it("publishes a dispatched event carrying the stored payload and trace id", async () => {
      const h = harness({ shards: shardReplies({ 3: [task("task-3", "trace-abc")] }) });
      h.mockDb.queueSelect([
        { taskId: "task-3", payload: { priority: "normal", destination: "a@example.com" } },
      ]);

      await run(h);

      expect(h.producers.normal.publishBatch).toHaveBeenCalledTimes(1);
      const [batch] = h.producers.normal.publishBatch.mock.calls[0]!;
      expect(batch).toHaveLength(1);
      expect(batch[0].type).toBe("notification.dispatched");
      expect(batch[0].payload.destination).toBe("a@example.com");
      expect(batch[0].metadata.traceId).toBe("trace-abc");
    });

    it("routes by the payload's priority", async () => {
      const h = harness({ shards: shardReplies({ 0: [task("task-a"), task("task-b")] }) });
      h.mockDb.queueSelect([
        { taskId: "task-a", payload: { priority: "critical" } },
        { taskId: "task-b", payload: { priority: "low" } },
      ]);

      await run(h);

      expect(h.producers.critical!.publishBatch).toHaveBeenCalledTimes(1);
      expect(h.producers.low.publishBatch).toHaveBeenCalledTimes(1);
      expect(h.producers.normal.publishBatch).not.toHaveBeenCalled();
    });

    it("falls back to the normal stream when the priority has no producer", async () => {
      const h = harness({ shards: shardReplies({ 0: [task("task-a")] }) });
      delete (h.producers as any).critical;
      h.mockDb.queueSelect([{ taskId: "task-a", payload: { priority: "critical" } }]);

      await run(h);

      expect(h.producers.normal.publishBatch).toHaveBeenCalledTimes(1);
    });

    it("clears the released task from Redis and Postgres", async () => {
      // "task-3" ends in 3, so it lives on shard 3.
      const h = harness({ shards: shardReplies({ 3: [task("task-3")] }) });
      h.mockDb.queueSelect([{ taskId: "task-3", payload: { priority: "normal" } }]);

      await run(h);

      expect(h.cleanupPipeline.zrem).toHaveBeenCalledWith("notif:scheduled:zset:3", task("task-3"));
      expect(h.cleanupPipeline.exec).toHaveBeenCalledTimes(1);
      expect(h.mockDb.deletes[0]!.table).toBe(scheduledPayloads);
    });

    it("derives the shard from the task id's last hex digit", async () => {
      const h = harness({ shards: shardReplies({ 0: [task("task-f")] }) });
      h.mockDb.queueSelect([{ taskId: "task-f", payload: { priority: "normal" } }]);

      await run(h);

      // The writer shards the same way; disagreeing here would leave the entry
      // in Redis to be re-released after every visibility timeout.
      expect(h.cleanupPipeline.zrem).toHaveBeenCalledWith(
        "notif:scheduled:zset:15",
        task("task-f"),
      );
    });
  });

  describe("tasks that cannot be released", () => {
    it("logs and skips a task whose JSON is corrupt", async () => {
      const h = harness({ shards: shardReplies({ 0: ["{not json"] }) });

      await expect(run(h)).resolves.toBe(false);
      expect(h.logger.error).toHaveBeenCalled();
      expect(h.producers.normal.publishBatch).not.toHaveBeenCalled();
    });

    it("still releases the good tasks alongside a corrupt one", async () => {
      const h = harness({ shards: shardReplies({ 0: ["{not json", task("task-1")] }) });
      h.mockDb.queueSelect([{ taskId: "task-1", payload: { priority: "normal" } }]);

      await run(h);

      expect(h.producers.normal.publishBatch).toHaveBeenCalledTimes(1);
    });

    it("drops the ZSET entry when its payload is gone from Postgres", async () => {
      // Nothing left to send, so the entry has to go — otherwise the visibility
      // timeout re-surfaces it every minute forever.
      const h = harness({ shards: shardReplies({ 1: [task("task-1")] }) });
      h.mockDb.queueSelect([]);

      await run(h);

      expect(h.logger.warn).toHaveBeenCalled();
      expect(h.producers.normal.publishBatch).not.toHaveBeenCalled();
      expect(h.cleanupPipeline.zrem).toHaveBeenCalledWith("notif:scheduled:zset:1", task("task-1"));
      // An orphan has no payload row to delete.
      expect(h.mockDb.deletes).toHaveLength(0);
    });

    it("does the Redis cleanup even when the Postgres delete fails", async () => {
      const h = harness({ shards: shardReplies({ 1: [task("task-1")] }) });
      h.mockDb.queueSelect([{ taskId: "task-1", payload: { priority: "normal" } }]);
      // Only the delete should fail; the select above has already resolved.
      h.mockDb.db.delete = vi.fn(() => ({
        where: () => Promise.reject(new Error("postgres gone")),
      }));

      await run(h);

      expect(h.logger.error).toHaveBeenCalled();
      expect(h.cleanupPipeline.exec).toHaveBeenCalledTimes(1);
      // The message was published before cleanup, so it is not lost.
      expect(h.producers.normal.publishBatch).toHaveBeenCalledTimes(1);
    });

    it("returns false and logs when the payload lookup itself fails", async () => {
      const h = harness({ shards: shardReplies({ 1: [task("task-1")] }) });
      h.mockDb.failWith(new Error("postgres gone"));

      await expect(run(h)).resolves.toBe(false);
      expect(h.logger.error).toHaveBeenCalled();
      // Nothing was published and nothing was cleaned up, so the visibility
      // timeout will bring these tasks back.
      expect(h.producers.normal.publishBatch).not.toHaveBeenCalled();
      expect(h.cleanupPipeline.exec).not.toHaveBeenCalled();
    });
  });
});
