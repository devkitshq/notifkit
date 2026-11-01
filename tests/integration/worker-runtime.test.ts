import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { IdempotencyGuard } from "@/idempotency/index.js";
import {
  ApiRateLimiter,
  UserThrottle,
  ProjectSettingsCache,
  calculateTokenBatchSize,
} from "@/rate-limiter/index.js";
import { ProviderThrottle } from "@/services/delivery/throttle.js";
import { RedisClient } from "@/redis/index.js";
import {
  BaseWorker,
  NonRetryableError,
  LockHeldError,
  startHealthReporter,
  type ProcessResult,
} from "@/workers/index.js";
import {
  createPriorityProducers,
  createStreamConsumer,
  shutdownWorker,
  uniqueConsumerId,
} from "@/workers/bootstrap.js";
import { StreamConsumer, PendingMessageScanner, type StreamMessage } from "@/queue/index.js";
import { STREAMS, CONSUMER_GROUPS, buildStreamEvent } from "@/contracts/index.js";
import { ProjectRepository } from "@/repositories/index.js";
import { createLogger } from "@/logger/index.js";
import { globalEmitter } from "@/shared/index.js";
import { useInfra, waitFor, settle } from "./support/infra.js";

const infra = useInfra();
const logger = createLogger({ name: "test", level: "silent" });

beforeEach(async () => {
  await infra.reset();
});

// ─── IdempotencyGuard ────────────────────────────────────────────────────────

describe("IdempotencyGuard", () => {
  const guard = () =>
    new IdempotencyGuard({ redis: infra.redis, keyPrefix: "t:idem", ttlSeconds: 60 });

  it("grants a lease once, reports it locked to others, and completed after marking", async () => {
    const g = guard();
    expect(await g.acquireLease("m1", 30)).toBe("acquired");
    expect(await g.acquireLease("m1", 30)).toBe("locked");
    await g.markProcessed("m1");
    expect(await g.acquireLease("m1", 30)).toBe("completed");
    expect(await infra.redis.ttl("t:idem:m1")).toBeGreaterThan(30);
  });

  it("gives exactly one of many concurrent callers the lease", async () => {
    const g = guard();
    const results = await Promise.all(Array.from({ length: 50 }, () => g.acquireLease("race", 30)));
    expect(results.filter((r) => r === "acquired")).toHaveLength(1);
    expect(results.filter((r) => r === "locked")).toHaveLength(49);
  });

  it("lets a new holder in once an abandoned lease expires", async () => {
    const g = guard();
    expect(await g.acquireLease("crash", 1)).toBe("acquired");
    await settle(1_100);
    expect(await g.acquireLease("crash", 1)).toBe("acquired");
  });

  it("checkAndMark is true exactly once", async () => {
    const g = guard();
    const results = await Promise.all(Array.from({ length: 20 }, () => g.checkAndMark("once")));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await g.isProcessed("once")).toBe(true);
    expect(await g.isProcessed("never")).toBe(false);
  });

  it("unmark clears the marker so the id can be processed again", async () => {
    const g = guard();
    await g.acquireLease("again", 30);
    await g.markProcessed("again");
    await g.unmark("again");
    expect(await g.isProcessed("again")).toBe(false);
    expect(await g.acquireLease("again", 30)).toBe("acquired");
  });

  it("honours a custom TTL", async () => {
    const g = guard();
    await g.checkAndMark("ttl", 5);
    const ttl = await infra.redis.ttl("t:idem:ttl");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5);
  });
});

// ─── Rate limiting ──────────────────────────────────────────────────────────

describe("calculateTokenBatchSize", () => {
  it("scales with the limit and stays within bounds", () => {
    expect(calculateTokenBatchSize(0)).toBe(0);
    expect(calculateTokenBatchSize(-5)).toBe(0);
    expect(calculateTokenBatchSize(10)).toBe(1);
    expect(calculateTokenBatchSize(60)).toBe(5);
    expect(calculateTokenBatchSize(61)).toBe(10);
    expect(calculateTokenBatchSize(6_000)).toBe(500);
    expect(calculateTokenBatchSize(600_000)).toBe(500);
    expect(calculateTokenBatchSize(600_000, 50)).toBe(50);
  });
});

describe("ApiRateLimiter", () => {
  it("admits exactly the limit in one window, even when requests arrive all at once", async () => {
    const limiter = new ApiRateLimiter({ redis: infra.redis, windowMs: 60_000 });
    const results = await Promise.all(Array.from({ length: 200 }, () => limiter.check("p1", 50)));
    expect(results.filter(Boolean)).toHaveLength(50);
    expect(await limiter.check("p1", 50)).toBe(false);
  });

  it("denies everything for a non-positive limit", async () => {
    const limiter = new ApiRateLimiter({ redis: infra.redis });
    expect(await limiter.check("p", 0)).toBe(false);
    expect(await limiter.check("p", -1)).toBe(false);
  });

  it("keeps projects independent", async () => {
    const limiter = new ApiRateLimiter({ redis: infra.redis });
    for (let i = 0; i < 5; i++) await limiter.check("a", 5);
    expect(await limiter.check("a", 5)).toBe(false);
    expect(await limiter.check("b", 5)).toBe(true);
  });

  it("admits again once the window has fully passed", async () => {
    const limiter = new ApiRateLimiter({ redis: infra.redis, windowMs: 500 });
    // Align to the start of a bucket so the test does not straddle a boundary.
    await settle(500 - (Date.now() % 500) + 5);
    for (let i = 0; i < 3; i++) expect(await limiter.check("w", 3)).toBe(true);
    expect(await limiter.check("w", 3)).toBe(false);
    // Two windows later the previous bucket no longer weighs in.
    await settle(1_000);
    expect(await limiter.check("w", 3)).toBe(true);
  });

  it("fails open when Redis errors", async () => {
    const broken = new RedisClient({ url: infra.redisUrl });
    await broken.disconnect();
    const limiter = new ApiRateLimiter({ redis: broken.native, logger });
    expect(await limiter.check("p", 10)).toBe(true);
  });

  it("invalidate and clear drop local leases so the next check re-reads Redis", async () => {
    const limiter = new ApiRateLimiter({ redis: infra.redis });
    expect(await limiter.check("p", 600)).toBe(true); // leases a chunk locally
    await infra.redis.flushdb();
    limiter.invalidate("p");
    limiter.clear();
    expect(await limiter.check("p", 600)).toBe(true);
  });
});

describe("ProviderThrottle", () => {
  it("allows up to the provider's limit per window and says when to retry", async () => {
    const throttle = new ProviderThrottle(infra.redis, logger);
    const cfg = { limit: 5, windowSeconds: 60 };
    const results = await Promise.all(Array.from({ length: 8 }, () => throttle.check("sms", cfg)));
    const allowed = results.filter((r) => r.allowed);
    const denied = results.filter((r) => !r.allowed);
    expect(allowed).toHaveLength(5);
    expect(denied).toHaveLength(3);
    for (const d of denied) {
      expect(d.retryAfterMs).toBeGreaterThan(0);
      expect(d.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
  });

  it("counts channels separately", async () => {
    const throttle = new ProviderThrottle(infra.redis);
    const cfg = { limit: 1, windowSeconds: 60 };
    expect((await throttle.check("sms", cfg)).allowed).toBe(true);
    expect((await throttle.check("sms", cfg)).allowed).toBe(false);
    expect((await throttle.check("email", cfg)).allowed).toBe(true);
  });
});

describe("UserThrottle", () => {
  it("never throttles critical sends", async () => {
    const t = new UserThrottle({ redis: infra.redis, maxPerHour: 1 });
    for (let i = 0; i < 5; i++) {
      expect((await t.check("p", "u", "critical")).allowed).toBe(true);
    }
    expect(await infra.redis.exists("throttle:p:user:u")).toBe(0);
  });

  it("a project limit of 0 blocks every non-critical send", async () => {
    const t = new UserThrottle({ redis: infra.redis, maxPerHour: 100 });
    expect((await t.check("p", "u", "normal", { limit: 0 })).allowed).toBe(false);
    expect((await t.check("p", "u", "critical", { limit: 0 })).allowed).toBe(true);
  });

  it("uses the project's window instead of the default", async () => {
    const t = new UserThrottle({ redis: infra.redis, maxPerHour: 1, windowHours: 1 });
    expect((await t.check("p", "u", "normal", { windowHours: 24 })).allowed).toBe(true);
    const ttl = await infra.redis.ttl("throttle:p:user:u");
    expect(ttl).toBeGreaterThan(3600);
  });

  it("ignores nonsensical overrides and falls back to the defaults", async () => {
    const t = new UserThrottle({ redis: infra.redis, maxPerHour: 2 });
    const r = await t.check("p", "u", "normal", { limit: -3, windowHours: 0 });
    expect(r.limit).toBe(2);
    expect(r.allowed).toBe(true);
  });
});

describe("ProjectSettingsCache (backed by the real projects table)", () => {
  async function project(throttleLimit: number | null) {
    const id = randomUUID();
    await infra.sql`INSERT INTO projects (id, name, throttle_limit) VALUES (${id}, 'p', ${throttleLimit})`;
    return id;
  }

  it("loads settings, caches them, and picks up a change after invalidate", async () => {
    const repo = new ProjectRepository(infra.db);
    let loads = 0;
    const cache = new ProjectSettingsCache((id) => {
      loads++;
      return repo.findThrottleSettings(id);
    });
    const id = await project(7);

    expect((await cache.get(id)).throttleLimit).toBe(7);
    await repo.updateSettings(id, { throttleLimit: 9 });
    expect((await cache.get(id)).throttleLimit).toBe(7); // cached
    cache.invalidate(id);
    expect((await cache.get(id)).throttleLimit).toBe(9);
    expect(loads).toBe(2);
  });

  it("runs one query for a burst of lookups on a cold project", async () => {
    const repo = new ProjectRepository(infra.db);
    let loads = 0;
    const cache = new ProjectSettingsCache((id) => {
      loads++;
      return repo.findThrottleSettings(id);
    });
    const id = await project(3);
    const results = await Promise.all(Array.from({ length: 25 }, () => cache.get(id)));
    expect(results.every((r) => r.throttleLimit === 3)).toBe(true);
    expect(loads).toBe(1);
  });

  it("treats an unknown project as having no overrides", async () => {
    const repo = new ProjectRepository(infra.db);
    const cache = new ProjectSettingsCache((id) => repo.findThrottleSettings(id));
    expect(await cache.get(randomUUID())).toEqual({
      throttleLimit: null,
      throttleWindowHours: null,
    });
  });

  it("does not cache a failed lookup", async () => {
    let fail = true;
    const cache = new ProjectSettingsCache(async () => {
      if (fail) throw new Error("db down");
      return { throttleLimit: 1, throttleWindowHours: null };
    });
    await expect(cache.get("p")).rejects.toThrow("db down");
    fail = false;
    expect((await cache.get("p")).throttleLimit).toBe(1);
  });

  it("does not let a lookup that raced an invalidate write stale settings", async () => {
    let release!: (v: any) => void;
    let calls = 0;
    const cache = new ProjectSettingsCache(() => {
      calls++;
      if (calls === 1) return new Promise((r) => (release = r));
      return Promise.resolve({ throttleLimit: 2, throttleWindowHours: null });
    });
    const stale = cache.get("p");
    cache.invalidate("p");
    release({ throttleLimit: 1, throttleWindowHours: null });
    expect((await stale).throttleLimit).toBe(1);
    expect((await cache.get("p")).throttleLimit).toBe(2);
    cache.clear();
  });
});

// ─── RedisClient ────────────────────────────────────────────────────────────

describe("RedisClient", () => {
  it("reports health and stops reporting it after disconnect", async () => {
    const client = new RedisClient({ url: infra.redisUrl, logger });
    expect(await client.healthCheck()).toBe(true);
    await client.disconnect();
    await client.disconnect(); // idempotent
    expect(await client.healthCheck()).toBe(false);
  });

  it("registers the Lua commands", async () => {
    const client = new RedisClient({ url: infra.redisUrl });
    await client.native.set("lock", "me");
    expect(await client.native.releaseLock("lock", "someone-else")).toBe(0);
    expect(await client.native.releaseLock("lock", "me")).toBe(1);
    await client.disconnect();
  });

  it("shares one connection per URL and closes it with the last holder", async () => {
    const url = `${infra.redisUrl}?shared=${randomUUID()}`;
    const a = RedisClient.shared({ url });
    const b = RedisClient.shared({ url });
    expect(a.native).toBe(b.native);

    await a.disconnect();
    await a.disconnect(); // a second release must not steal b's reference
    expect(await b.healthCheck()).toBe(true);

    await b.disconnect();
    expect(await b.healthCheck()).toBe(false);

    const c = RedisClient.shared({ url });
    expect(await c.healthCheck()).toBe(true);
    expect(c.native).not.toBe(a.native);
    await c.disconnect();
  });
});

// ─── BaseWorker ─────────────────────────────────────────────────────────────

type Behaviour = (msg: StreamMessage, attempt?: number) => Promise<ProcessResult>;

class ScriptedWorker extends BaseWorker {
  readonly seen: { n: number; attempt: number }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  constructor(
    opts: ConstructorParameters<typeof BaseWorker>[0],
    public behaviour: Behaviour,
  ) {
    super(opts);
  }
  protected async process(msg: StreamMessage, attempt = 1): Promise<ProcessResult> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      this.seen.push({ n: (msg.event.payload as any).n, attempt });
      return await this.behaviour(msg, attempt);
    } finally {
      this.inFlight--;
    }
  }
}

describe("BaseWorker", () => {
  const STREAM = STREAMS.ENRICHED_NORMAL;
  const GROUP = CONSUMER_GROUPS.ENGINE;
  const workers: BaseWorker[] = [];

  function worker(
    behaviour: Behaviour,
    opts: {
      concurrency?: number;
      recoveryIntervalMs?: number;
      maxRetriesBeforeDlq?: number;
      name?: string;
    } = {},
  ) {
    const { name = "w1", ...workerOpts } = opts;
    const consumer = new StreamConsumer({
      redis: infra.redis,
      stream: STREAM,
      group: GROUP,
      consumer: name,
      dlqStream: STREAMS.DEAD_LETTER,
      blockMs: 100,
      batchSize: 20,
      logger,
    });
    const pendingScanner = new PendingMessageScanner({
      redis: infra.redis,
      stream: STREAM,
      group: GROUP,
      consumer: name,
      logger,
    });
    const w = new ScriptedWorker(
      { consumer, pendingScanner, logger, recoveryIntervalMs: 60_000, ...workerOpts },
      behaviour,
    );
    workers.push(w);
    return w;
  }

  async function publish(n: number) {
    const ev = {
      ...buildStreamEvent("t", { n }, "test"),
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };
    await infra.redis.xadd(STREAM, "*", "data", JSON.stringify(ev));
    return ev;
  }

  const pending = async () => Number(((await infra.redis.xpending(STREAM, GROUP)) as any[])[0]);
  const dlq = async () =>
    (await infra.redis.xrange(STREAMS.DEAD_LETTER, "-", "+")).map((e) => JSON.parse(e[1][1]!));

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop()));
  });

  it("processes and acks every message, and counts them", async () => {
    const w = worker(async () => {});
    await w.start();
    for (let n = 0; n < 10; n++) await publish(n);

    await waitFor("10 processed", () => w.health().processedCount === 10);
    expect(await pending()).toBe(0);
    const h = w.health();
    expect(h.state).toBe("running");
    expect(h.errorCount).toBe(0);
    expect(h.lastProcessedAt).not.toBeNull();
  });

  it("refuses to start twice", async () => {
    const w = worker(async () => {});
    await w.start();
    await expect(w.start()).rejects.toThrow(/cannot start/);
  });

  it("never runs more than `concurrency` messages at once", async () => {
    const w = worker(() => settle(30), { concurrency: 3 });
    await w.start();
    for (let n = 0; n < 15; n++) await publish(n);
    await waitFor("15 processed", () => w.health().processedCount === 15);
    expect(w.maxInFlight).toBeLessThanOrEqual(3);
    expect(w.maxInFlight).toBeGreaterThan(1);
  });

  it("leaves a failed message pending and retries it through recovery", async () => {
    let calls = 0;
    const w = worker(
      async () => {
        if (++calls === 1) throw new Error("transient");
      },
      { recoveryIntervalMs: 100 },
    );
    await w.start();
    await publish(1);

    await waitFor("retried and processed", () => w.health().processedCount === 1, 10_000);
    expect(w.seen.map((s) => s.attempt)).toEqual([1, 2]);
    expect(w.health().errorCount).toBe(1);
    expect(await pending()).toBe(0);
  });

  it("dead-letters a message that keeps failing, once, and reports it", async () => {
    const failed: string[] = [];
    const onFailed = (id: string) => failed.push(id);
    globalEmitter.on("notification:failed", onFailed);
    try {
      const w = worker(
        async () => {
          throw new Error("always");
        },
        { recoveryIntervalMs: 50, maxRetriesBeforeDlq: 2 },
      );
      await w.start();
      const ev = await publish(1);

      await waitFor("dead-lettered", async () => (await dlq()).length === 1, 15_000);
      await settle(300);
      expect((await dlq()).map((d) => d.id)).toEqual([ev.id]);
      expect(await pending()).toBe(0);
      expect(w.seen.map((s) => s.attempt)).toEqual([1, 2]);
      // The event's id, as every other emitter reports it — not the stream
      // entry id, which means nothing to a listener.
      expect(failed).toEqual([ev.id]);
    } finally {
      globalEmitter.off("notification:failed", onFailed);
    }
  });

  it("dead-letters a NonRetryableError immediately, reporting the event's id", async () => {
    const failed: string[] = [];
    const onFailed = (id: string) => failed.push(id);
    globalEmitter.on("notification:failed", onFailed);
    try {
      const w = worker(async () => {
        throw new NonRetryableError("bad input");
      });
      await w.start();
      const ev = await publish(1);
      await waitFor("dead-lettered", async () => (await dlq()).length === 1);
      expect((await dlq())[0].id).toBe(ev.id);
      expect(await pending()).toBe(0);
      expect(w.seen).toHaveLength(1);
      expect(failed).toEqual([ev.id]);
    } finally {
      globalEmitter.off("notification:failed", onFailed);
    }
  });

  it("leaves a message pending, without counting an error, when the lock is held", async () => {
    const w = worker(async () => {
      throw new LockHeldError();
    });
    await w.start();
    await publish(1);
    await waitFor("seen", () => w.seen.length === 1);
    await settle(100);
    expect(await pending()).toBe(1);
    expect(w.health().errorCount).toBe(0);
  });

  it("leaves a message pending when process asks not to ack", async () => {
    const w = worker(async () => ({ ack: false }));
    await w.start();
    await publish(1);
    await waitFor("seen", () => w.seen.length === 1);
    await settle(100);
    expect(await pending()).toBe(1);
    expect(w.health().processedCount).toBe(0);
  });

  it("stop() lets in-flight messages finish and ack", async () => {
    const w = worker(() => settle(300));
    await w.start();
    await publish(1);
    await waitFor("started", () => w.inFlight === 1);
    await w.stop();
    expect(w.health().state).toBe("stopped");
    expect(w.health().processedCount).toBe(1);
    expect(await pending()).toBe(0);
  });

  it("recovers a crashed consumer's message even when no worker outlives one recovery interval", async () => {
    // A worker that crashed mid-message leaves its entry pending under a
    // consumer name nobody will read again. Its replacements restart more often
    // than the recovery interval (a crash loop, an aggressive autoscaler), so a
    // scan timed from each worker's start never fires.
    await infra.redis.xgroup("CREATE", STREAM, GROUP, "0", "MKSTREAM");
    await publish(1);
    await infra.redis.xreadgroup("GROUP", GROUP, "crashed", "COUNT", 1, "STREAMS", STREAM, ">");

    const processed: number[] = [];
    const deadline = Date.now() + 5_000;
    while (processed.length === 0 && Date.now() < deadline) {
      const w = worker(async (msg) => void processed.push((msg.event.payload as any).n), {
        recoveryIntervalMs: 400,
      });
      await w.start();
      await settle(250);
      await w.stop();
    }

    expect(processed).toEqual([1]);
    expect(await pending()).toBe(0);
  });

  it("keeps a slow message to itself while processing it, so no replica reclaims it", async () => {
    // A segment fan-out can run for minutes. Its entry must not look idle to the
    // recovery scan meanwhile, or a second replica starts the same fan-out over.
    const slow = () => settle(1_500);
    const a = worker(slow, { recoveryIntervalMs: 200, name: "a" });
    const b = worker(slow, { recoveryIntervalMs: 200, name: "b" });
    await a.start();
    await b.start();
    await publish(1);

    await waitFor(
      "processed",
      () => a.health().processedCount + b.health().processedCount >= 1,
      10_000,
    );
    await settle(500);

    expect([...a.seen, ...b.seen]).toEqual([{ n: 1, attempt: 1 }]);
    expect(await pending()).toBe(0);
  });

  it("recover() reports the pending count through health()", async () => {
    const w = worker(async () => {});
    expect(w.health().pendingCount).toBeNull();
    await infra.redis.xgroup("CREATE", STREAM, GROUP, "0", "MKSTREAM");
    await w.recover();
    expect(w.health().pendingCount).toBe(0);
  });

  describe("processInline", () => {
    const ev = () => ({
      ...buildStreamEvent("t", { n: 1 }, "test"),
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    });

    it("processes and counts a handed-over event", async () => {
      const w = worker(async () => {});
      await w.processInline(ev());
      expect(w.health().processedCount).toBe(1);
      expect(w.seen[0]!.attempt).toBe(1);
    });

    it("dead-letters a non-retryable failure instead of throwing it upstream", async () => {
      const w = worker(async () => {
        throw new NonRetryableError("nope");
      });
      const e = ev();
      await w.processInline(e);
      expect((await dlq()).map((d) => d.id)).toEqual([e.id]);
      expect(w.health().errorCount).toBe(1);
    });

    it("swallows a held lock", async () => {
      const w = worker(async () => {
        throw new LockHeldError();
      });
      await expect(w.processInline(ev())).resolves.toBeUndefined();
      expect(w.health().errorCount).toBe(0);
    });

    it("rethrows a retryable failure so the upstream entry stays pending", async () => {
      const w = worker(async () => {
        throw new Error("boom");
      });
      await expect(w.processInline(ev())).rejects.toThrow("boom");
    });
  });
});

// ─── Bootstrap helpers ──────────────────────────────────────────────────────

describe("bootstrap helpers", () => {
  it("uniqueConsumerId never repeats", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uniqueConsumerId("x")));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id.startsWith("x-")).toBe(true);
  });

  it("createStreamConsumer pairs a consumer and scanner that agree", async () => {
    const redis = new RedisClient({ url: infra.redisUrl });
    const { consumer, pendingScanner } = createStreamConsumer(
      { redis, logger },
      {
        stream: [STREAMS.OUTBOUND_NORMAL, STREAMS.OUTBOUND_LOW],
        group: CONSUMER_GROUPS.DELIVERY,
        consumer: "d1",
        batchSize: 5,
      },
    );
    await consumer.ensureGroup();
    await infra.redis.xadd(
      STREAMS.OUTBOUND_LOW,
      "*",
      "data",
      JSON.stringify({
        ...buildStreamEvent("t", {}, "s"),
        id: randomUUID(),
        timestamp: new Date().toISOString(),
      }),
    );
    const it = consumer.readBatch();
    const batch = (await it.next()).value!;
    expect(batch[0]!.stream).toBe(STREAMS.OUTBOUND_LOW);
    expect(await pendingScanner.getPendingCount()).toBe(1);
    await consumer.nack(batch[0]!.id, batch[0]!.event, batch[0]!.stream);
    expect(await infra.redis.xlen(STREAMS.DEAD_LETTER)).toBe(1);
    await consumer.stop();
    await redis.disconnect();
  });

  it("createPriorityProducers writes each lane to its own stream", async () => {
    const producers = createPriorityProducers(infra.redis, logger, "OUTBOUND");
    await producers.critical.publish(buildStreamEvent("t", {}, "s"));
    await producers.normal.publish(buildStreamEvent("t", {}, "s"));
    await producers.low.publish(buildStreamEvent("t", {}, "s"));
    expect(await infra.redis.xlen(STREAMS.OUTBOUND_CRITICAL)).toBe(1);
    expect(await infra.redis.xlen(STREAMS.OUTBOUND_NORMAL)).toBe(1);
    expect(await infra.redis.xlen(STREAMS.OUTBOUND_LOW)).toBe(1);
  });

  it("shutdownWorker stops timers, the worker, and closes both connections", async () => {
    const redis = new RedisClient({ url: infra.redisUrl });
    const { createDatabase } = await import("@/db/index.js");
    const { sql } = createDatabase({ url: infra.dbUrl, maxConnections: 1 });
    await sql`SELECT 1`;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    let disconnected = false;

    await shutdownWorker("test", {
      logger,
      timers: [timer, null],
      subscriber: { disconnect: () => (disconnected = true) },
      sql,
      redis,
    });

    const after = ticks;
    await settle(30);
    expect(ticks).toBe(after);
    expect(disconnected).toBe(true);
    expect(await redis.healthCheck()).toBe(false);
    await expect(sql`SELECT 1`).rejects.toThrow();
  });
});

describe("startHealthReporter", () => {
  it("publishes the worker's health to Redis with a short TTL", async () => {
    const redis = new RedisClient({ url: infra.redisUrl });
    const w = { health: () => ({ state: "running", processedCount: 3 }) } as any;
    const timer = startHealthReporter("svc", w, redis, logger, 20);
    try {
      await waitFor("health key", async () => (await infra.redis.exists("notif:health:svc")) === 1);
      const body = JSON.parse((await infra.redis.get("notif:health:svc"))!);
      expect(body).toMatchObject({
        service: "svc",
        redis: true,
        state: "running",
        processedCount: 3,
      });
      const ttl = await infra.redis.ttl("notif:health:svc");
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(15);
    } finally {
      clearInterval(timer);
      await redis.disconnect();
    }
  });
});

// ─── Service workers: graceful stop ─────────────────────────────────────────

describe("service workers drain their in-flight messages on stop", () => {
  const PROJECT = "00000000-0000-4000-8000-000000000001";

  /** Resolves "stopped", or "hung" if stop() outlasts `ms`. */
  const stopWithin = (w: BaseWorker, ms: number) =>
    Promise.race([w.stop().then(() => "stopped" as const), settle(ms).then(() => "hung" as const)]);

  function streamWorkerParts(stream: any, group: any) {
    const consumer = new StreamConsumer({
      redis: infra.redis,
      stream,
      group,
      consumer: "drain",
      dlqStream: STREAMS.DEAD_LETTER,
      blockMs: 100,
      batchSize: 10,
      logger,
    });
    const pendingScanner = new PendingMessageScanner({
      redis: infra.redis,
      stream,
      group,
      consumer: "drain",
      logger,
    });
    return { consumer, pendingScanner, logger, recoveryIntervalMs: 60_000 };
  }

  async function publishTo(stream: string, type: string, payload: Record<string, unknown>) {
    const ev = {
      ...buildStreamEvent(type as any, payload, "test"),
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };
    await infra.redis.xadd(stream, "*", "data", JSON.stringify(ev));
    return ev;
  }

  it("enricher: finishes a message that was mid-lookup when stop was called", async () => {
    const { EnricherWorker } = await import("@/services/enricher/main.js");
    let lookupStarted = false;
    const published: unknown[] = [];
    const producer = {
      publishBatch: async (events: unknown[]) => {
        published.push(...events);
        return { messageIds: events.map(() => "1-0"), eventIds: events.map(() => randomUUID()) };
      },
    };
    const w = new EnricherWorker({
      ...streamWorkerParts(STREAMS.INBOUND_NORMAL, CONSUMER_GROUPS.ENRICHER),
      concurrency: 10,
      producers: { critical: producer, normal: producer, low: producer },
      idempotency: new IdempotencyGuard({ redis: infra.redis, keyPrefix: "t:enr" }),
      userRepo: {
        findRecordsByIds: async () => {
          lookupStarted = true;
          await settle(300);
          return [{ userId: "u1", preferences: {} }];
        },
      },
      prefRepo: {},
      contactRepo: {
        findActiveByUserIds: async () =>
          new Map([["u1", [{ id: "c1", channel: "email", target: "u1@x.com" }]]]),
      },
      templateCache: { getCachedTemplate: async () => null } as any,
    });
    await w.start();
    await publishTo(STREAMS.INBOUND_NORMAL, "notification.requested", {
      projectId: PROJECT,
      target: { type: "user", userId: "u1" },
      templateId: "t",
      priority: "normal",
      data: {},
      fallback: false,
    });
    await waitFor("lookup in flight", () => lookupStarted);

    expect(await stopWithin(w, 5_000)).toBe("stopped");
    expect(published).toHaveLength(1);
  }, 20_000);

  it("workflow: finishes a run that was mid-step when stop was called", async () => {
    const { WorkflowWorker } = await import("@/services/workflow/main.js");
    const { workflow } = await import("@/workflows/index.js");
    let stepStarted = false;
    workflow("drain-on-stop", async ({ step }) => {
      await step.run("slow", async () => {
        stepStarted = true;
        await settle(300);
        return true;
      });
      await step.notify({ template: "t" });
    });
    const published: unknown[] = [];
    const producer = {
      publishBatch: async (events: unknown[]) => {
        published.push(...events);
        return { messageIds: events.map(() => "1-0"), eventIds: events.map(() => randomUUID()) };
      },
    };
    const w = new WorkflowWorker({
      ...streamWorkerParts(STREAMS.WORKFLOW_INBOUND, CONSUMER_GROUPS.WORKFLOW),
      concurrency: 10,
      redis: infra.redis,
      db: infra.db,
      workflowProducer: producer,
      notificationProducer: producer,
    });
    await w.start();
    const instanceId = randomUUID();
    await publishTo(STREAMS.WORKFLOW_INBOUND, "workflow.triggered", {
      projectId: PROJECT,
      instanceId,
      name: "drain-on-stop",
      input: { user: { id: "u1" } },
    });
    await waitFor("step in flight", () => stepStarted);

    expect(await stopWithin(w, 5_000)).toBe("stopped");
    expect(published).toHaveLength(1);
    const [row] = await infra.sql`SELECT status FROM workflow_instances WHERE id = ${instanceId}`;
    expect(row!.status).toBe("completed");
  }, 20_000);
});
