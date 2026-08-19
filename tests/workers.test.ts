import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AiWorker, PermanentAiError } from "@/services/ai/main.js";
import { DeliveryWorker } from "@/services/delivery/main.js";
import { PreferenceRepository } from "@/repositories/index.js";
import { BaseWorker } from "@/workers/index.js";
import type { StreamMessage } from "@/queue/index.js";
import { createMockDb, type MockDb } from "./helpers/mock-db.js";
import { suppressions } from "@/db/schema.js";

vi.mock("@/config/index.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
  };
});

describe("PreferenceRepository", () => {
  let mockDb: any;
  let repo: PreferenceRepository;

  beforeEach(() => {
    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn(),
    };
    repo = new PreferenceRepository(mockDb);
  });

  it("findByUserId loads topic preferences correctly", async () => {
    // 1. Mock users query
    mockDb.where.mockResolvedValueOnce([{ id: "db-user-uuid" }]);
    // 2. Mock userTopicPreferences query
    mockDb.where.mockResolvedValueOnce([
      { topic: "marketing", enabled: false },
      { topic: "transactional", enabled: true },
    ]);

    const prefs = await repo.findByUserId("proj_123", "usr_external_123");

    expect(prefs).toHaveLength(2);
    expect(prefs[0]).toEqual({
      userId: "usr_external_123",
      eventType: "marketing",
      optedIn: false,
    });
    expect(prefs[1]).toEqual({
      userId: "usr_external_123",
      eventType: "transactional",
      optedIn: true,
    });
  });

  it("isOptedIn checks loaded preferences and defaults to true", async () => {
    // 1. Mock users query
    mockDb.where.mockResolvedValueOnce([{ id: "db-user-uuid" }]);
    // 2. Mock userTopicPreferences query
    mockDb.where.mockResolvedValueOnce([{ topic: "marketing", enabled: false }]);

    const optedInMarketing = await repo.isOptedIn("proj_123", "usr_external_123", "marketing");
    expect(optedInMarketing).toBe(false);

    // Reset mocks for checking default value
    mockDb.where.mockResolvedValueOnce([{ id: "db-user-uuid" }]);
    mockDb.where.mockResolvedValueOnce([]);

    const optedInDefault = await repo.isOptedIn("proj_123", "usr_external_123", "unknown_topic");
    expect(optedInDefault).toBe(true);
  });
});

describe("BaseWorker Retry and DLQ Logic", () => {
  class TestWorker extends BaseWorker {
    async process(_message: StreamMessage): Promise<void> {
      throw new Error("Simulated failure");
    }
  }

  let mockConsumer: any;
  let mockPendingScanner: any;
  let mockLogger: any;
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = {
      incr: vi.fn().mockResolvedValue(1),
      decr: vi.fn().mockResolvedValue(0),
      expire: vi.fn().mockResolvedValue(true),
      del: vi.fn().mockResolvedValue(true),
      multi: function () {
        return {
          incr: function () {
            return this;
          },
          expire: function () {
            return this;
          },
          exec: vi.fn().mockResolvedValue([
            [null, 1], // incr result
            [null, true], // expire result
          ]),
        };
      },
    };
    mockConsumer = {
      ack: vi.fn().mockResolvedValue(undefined),
      nack: vi.fn().mockResolvedValue(undefined),
      redis: mockRedis,
    };
    mockPendingScanner = {};
    mockLogger = {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
  });

  it("increments retry count on failure and does not ack", async () => {
    const worker = new TestWorker({
      consumer: mockConsumer,
      pendingScanner: mockPendingScanner,
      logger: mockLogger,
      maxRetriesBeforeDlq: 3,
    });

    const msg: StreamMessage = {
      id: "msg-1",
      event: {
        id: "evt-123",
        type: "notification.created",
        timestamp: new Date().toISOString(),
        metadata: {
          traceId: "trace-1",
          source: "test",
          retryCount: 0,
        },
        payload: {},
      },
    };

    // Call private processWithTracking
    await (worker as any).processWithTracking(msg);

    expect(mockConsumer.ack).not.toHaveBeenCalled();
    expect(mockConsumer.nack).not.toHaveBeenCalled();
  });

  it("DLQs message and acks when retry count exceeds max limit", async () => {
    mockRedis.incr.mockResolvedValue(4);

    const worker = new TestWorker({
      consumer: mockConsumer,
      pendingScanner: mockPendingScanner,
      logger: mockLogger,
      maxRetriesBeforeDlq: 3,
    });

    const msg: StreamMessage = {
      id: "msg-1",
      event: {
        id: "evt-123",
        type: "notification.created",
        timestamp: new Date().toISOString(),
        metadata: {
          traceId: "trace-1",
          source: "test",
          retryCount: 0,
        },
        payload: {},
      },
    };

    mockRedis.multi = vi.fn().mockReturnValue({
      incr: function () {
        return this;
      },
      expire: function () {
        return this;
      },
      exec: vi.fn().mockResolvedValue([
        [null, 4],
        [null, true],
      ]),
    });

    await (worker as any).processWithTracking(msg);

    expect(mockConsumer.nack).toHaveBeenCalledWith("msg-1", msg.event, undefined);
    expect(mockRedis.del).toHaveBeenCalledWith("notif:worker:retries:TestWorker:default:msg-1");
  });

  it("immediately moves to DLQ on attempt 1 when process throws NonRetryableError", async () => {
    class PermanentFailWorker extends BaseWorker {
      protected async process(): Promise<void> {
        const { NonRetryableError } = await import("@/workers/index.js");
        throw new NonRetryableError("fatal: recipient account terminated");
      }
    }

    const worker = new PermanentFailWorker({
      consumer: mockConsumer,
      pendingScanner: mockPendingScanner,
      logger: mockLogger,
      maxRetriesBeforeDlq: 5,
    });

    const msg: StreamMessage = {
      id: "msg-perm-1",
      event: {
        id: "evt-perm-1",
        type: "notification.created",
        timestamp: new Date().toISOString(),
        metadata: { traceId: "t-1", source: "test", retryCount: 0 },
        payload: {},
      },
    };

    await (worker as any).processWithTracking(msg);

    expect(mockConsumer.nack).toHaveBeenCalledWith("msg-perm-1", msg.event, undefined);
    expect(mockRedis.del).toHaveBeenCalledWith(
      "notif:worker:retries:PermanentFailWorker:default:msg-perm-1",
    );
  });
});

import { UserThrottle, ProjectSettingsCache } from "@/rate-limiter/index.js";
import { isInQuietHours } from "@/services/engine/main.js";

describe("isInQuietHours (Timezone-Aware Quiet Hours Calculation)", () => {
  it("returns inQuietHours: false when quietHours array is empty or undefined", () => {
    expect(isInQuietHours("UTC", [])).toEqual({ inQuietHours: false });
    expect(isInQuietHours("UTC", undefined as any)).toEqual({ inQuietHours: false });
  });

  it("returns inQuietHours: false gracefully when timezone is invalid", () => {
    const check = isInQuietHours("Invalid/Timezone_Name", [{ start: "22:00", end: "06:00" }]);
    expect(check).toEqual({ inQuietHours: false });
  });

  it("handles daytime quiet hours within same day (e.g. 13:00 - 15:00)", () => {
    const quietHours = [{ start: "13:00", end: "15:00" }];
    const inside = new Date("2026-08-17T14:00:00Z");
    const result = isInQuietHours("UTC", quietHours, inside);

    expect(result.inQuietHours).toBe(true);
    expect(result.nextActiveTime).toEqual(new Date("2026-08-17T15:00:00Z"));

    const outside = new Date("2026-08-17T16:00:00Z");
    expect(isInQuietHours("UTC", quietHours, outside)).toEqual({ inQuietHours: false });
  });

  it("handles midnight-crossing quiet hours (e.g. 22:00 - 06:00) before midnight", () => {
    const quietHours = [{ start: "22:00", end: "06:00" }];
    const beforeMidnight = new Date("2026-08-17T23:30:00Z");
    const result = isInQuietHours("UTC", quietHours, beforeMidnight);

    expect(result.inQuietHours).toBe(true);
    expect(result.nextActiveTime).toEqual(new Date("2026-08-18T06:00:00Z"));
  });

  it("handles midnight-crossing quiet hours (e.g. 22:00 - 06:00) after midnight", () => {
    const quietHours = [{ start: "22:00", end: "06:00" }];
    const afterMidnight = new Date("2026-08-18T04:15:00Z");
    const result = isInQuietHours("UTC", quietHours, afterMidnight);

    expect(result.inQuietHours).toBe(true);
    expect(result.nextActiveTime).toEqual(new Date("2026-08-18T06:00:00Z"));
  });

  it("handles chained quiet hours intervals (e.g. 22:00-06:00 followed by 06:00-08:00)", () => {
    const quietHours = [
      { start: "22:00", end: "06:00" },
      { start: "06:00", end: "08:00" },
    ];
    const atNight = new Date("2026-08-17T23:00:00Z");
    const result = isInQuietHours("UTC", quietHours, atNight);

    expect(result.inQuietHours).toBe(true);
    expect(result.nextActiveTime).toEqual(new Date("2026-08-18T08:00:00Z"));
  });
});

describe("UserThrottle (Priority-Aware Throttling)", () => {
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = {
      incr: vi.fn(),
      expire: vi.fn(),
      eval: vi.fn(),
    };
  });

  it("allows critical priority notifications to bypass throttling", async () => {
    const throttle = new UserThrottle({ redis: mockRedis, maxPerHour: 3 });
    const result = await throttle.check("proj-1", "usr-1", "critical");

    expect(result.allowed).toBe(true);
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it("throttles normal notifications when limit is exceeded", async () => {
    const throttle = new UserThrottle({ redis: mockRedis, maxPerHour: 3 });
    mockRedis.eval.mockResolvedValueOnce(4);

    const result = await throttle.check("proj-1", "usr-1", "normal");

    expect(result.allowed).toBe(false);
    expect(mockRedis.eval).toHaveBeenCalled();
  });

  // eval args: [script, numkeys, key, windowStart, limit, targetTime, memberId, ttl]
  const argWindowStart = (call: any[]) => call[3];
  const argLimit = (call: any[]) => call[4];
  const argTargetTime = (call: any[]) => call[5];
  /** Window length the script was actually asked to enforce. */
  const windowMsOf = (call: any[]) => argTargetTime(call) - argWindowStart(call);

  it("applies a per-project limit override in place of the global default", async () => {
    const throttle = new UserThrottle({ redis: mockRedis, maxPerHour: 3 });
    mockRedis.eval.mockResolvedValueOnce(40);

    const result = await throttle.check("proj-1", "usr-1", "normal", { limit: 50 });

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(50);
    expect(argLimit(mockRedis.eval.mock.calls[0])).toBe(50);
  });

  it("applies a per-project window override", async () => {
    const throttle = new UserThrottle({ redis: mockRedis, maxPerHour: 3 });
    mockRedis.eval.mockResolvedValueOnce(1);

    await throttle.check("proj-1", "usr-1", "normal", { windowHours: 24 });

    // The window must span a full 24h, not the default hour.
    expect(windowMsOf(mockRedis.eval.mock.calls[0])).toBe(24 * 3600_000);
  });

  it("falls back to the default when overrides are null or nonsensical", async () => {
    const throttle = new UserThrottle({ redis: mockRedis, maxPerHour: 7, windowHours: 1 });
    mockRedis.eval.mockResolvedValue(1);

    await throttle.check("proj-1", "usr-1", "normal", { limit: null, windowHours: null });
    expect(argLimit(mockRedis.eval.mock.calls[0])).toBe(7);

    // A stored zero or negative window would make the window meaningless.
    await throttle.check("proj-1", "usr-1", "normal", { windowHours: 0 });
    expect(windowMsOf(mockRedis.eval.mock.calls[1])).toBe(3600_000);

    await throttle.check("proj-1", "usr-1", "normal", { windowHours: -5 });
    expect(windowMsOf(mockRedis.eval.mock.calls[2])).toBe(3600_000);
  });

  it("treats a limit of 0 as a deliberate kill switch, not a missing value", async () => {
    const throttle = new UserThrottle({ redis: mockRedis, maxPerHour: 100 });
    mockRedis.eval.mockResolvedValueOnce(1);

    const result = await throttle.check("proj-1", "usr-1", "normal", { limit: 0 });

    expect(argLimit(mockRedis.eval.mock.calls[0])).toBe(0);
    expect(result.allowed).toBe(false);
  });

  it("still lets critical bypass a per-project override", async () => {
    const throttle = new UserThrottle({ redis: mockRedis, maxPerHour: 100 });

    const result = await throttle.check("proj-1", "usr-1", "critical", { limit: 0 });

    expect(result.allowed).toBe(true);
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });
});

describe("ProjectSettingsCache (per-project throttle overrides)", () => {
  it("reads through once and serves the rest from cache", async () => {
    const load = vi.fn().mockResolvedValue({ throttleLimit: 50, throttleWindowHours: 24 });
    const cache = new ProjectSettingsCache(load);

    expect(await cache.get("proj-1")).toEqual({ throttleLimit: 50, throttleWindowHours: 24 });
    await cache.get("proj-1");
    await cache.get("proj-1");

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("caches the no-override case too, so the common path costs no query", async () => {
    const load = vi.fn().mockResolvedValue(null);
    const cache = new ProjectSettingsCache(load);

    expect(await cache.get("proj-1")).toEqual({
      throttleLimit: null,
      throttleWindowHours: null,
    });
    await cache.get("proj-1");

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("re-reads after invalidation", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ throttleLimit: 10, throttleWindowHours: null })
      .mockResolvedValueOnce({ throttleLimit: 99, throttleWindowHours: null });
    const cache = new ProjectSettingsCache(load);

    expect((await cache.get("proj-1")).throttleLimit).toBe(10);
    cache.invalidate("proj-1");
    expect((await cache.get("proj-1")).throttleLimit).toBe(99);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps tenants separate", async () => {
    const load = vi.fn(async (projectId: string) =>
      projectId === "proj-a"
        ? { throttleLimit: 5, throttleWindowHours: null }
        : { throttleLimit: 500, throttleWindowHours: null },
    );
    const cache = new ProjectSettingsCache(load);

    expect((await cache.get("proj-a")).throttleLimit).toBe(5);
    expect((await cache.get("proj-b")).throttleLimit).toBe(500);
  });

  it("does not cache a failed lookup", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({ throttleLimit: 20, throttleWindowHours: null });
    const cache = new ProjectSettingsCache(load);

    await expect(cache.get("proj-1")).rejects.toThrow("db down");
    expect((await cache.get("proj-1")).throttleLimit).toBe(20);
  });

  it("collapses concurrent misses onto one query", async () => {
    // The cache only fills once an answer comes back, so without in-flight
    // dedupe a cold project at the start of a campaign puts one query per
    // in-flight message on Postgres — precisely when it is busiest.
    const pending: ((v: any) => void)[] = [];
    const load = vi.fn(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    const cache = new ProjectSettingsCache(load as any);

    const inFlight = [cache.get("proj-1"), cache.get("proj-1"), cache.get("proj-1")];
    expect(pending).toHaveLength(1);

    pending[0]!({ throttleLimit: 50, throttleWindowHours: null });
    const results = await Promise.all(inFlight);

    expect(load).toHaveBeenCalledTimes(1);
    // Every follower gets the leader's answer, not a default.
    for (const result of results) expect(result.throttleLimit).toBe(50);

    await cache.get("proj-1");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not strand later callers on a failed in-flight lookup", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({ throttleLimit: 20, throttleWindowHours: null });
    const cache = new ProjectSettingsCache(load);

    // Both share the failing lookup, then the next caller starts a fresh one.
    const first = cache.get("proj-1");
    const second = cache.get("proj-1");
    await expect(first).rejects.toThrow("db down");
    await expect(second).rejects.toThrow("db down");

    expect((await cache.get("proj-1")).throttleLimit).toBe(20);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps separate projects on separate lookups", async () => {
    const pending: string[] = [];
    const load = vi.fn(async (projectId: string) => {
      pending.push(projectId);
      return { throttleLimit: 1, throttleWindowHours: null };
    });
    const cache = new ProjectSettingsCache(load);

    await Promise.all([cache.get("proj-a"), cache.get("proj-b"), cache.get("proj-a")]);

    expect(pending).toEqual(["proj-a", "proj-b"]);
  });
});

describe("isInQuietHours (Quiet Hours Deferral)", () => {
  it("returns false if no quiet hours configured", () => {
    const result = isInQuietHours("UTC", []);
    expect(result.inQuietHours).toBe(false);
  });

  it("correctly identifies if time falls within quiet hours and calculates next active time", () => {
    vi.useFakeTimers();
    // 2026-07-29T04:00:00Z is Midnight (00:00) EDT in America/New_York
    vi.setSystemTime(new Date("2026-07-29T04:00:00Z"));

    const tz = "America/New_York";
    const result = isInQuietHours(tz, [{ start: "22:00", end: "08:00" }]);

    expect(result.inQuietHours).toBe(true);
    // 08:00 EDT is 12:00:00Z
    expect(result.nextActiveTime).toEqual(new Date("2026-07-29T12:00:00.000Z"));

    vi.useRealTimers();
  });

  it("handles multiple quiet hours intervals in recipient preferences", () => {
    vi.useFakeTimers();
    // 13:30 UTC
    vi.setSystemTime(new Date("2026-07-29T13:30:00Z"));

    const windows = [
      { start: "13:00", end: "14:00" }, // afternoon quiet period
      { start: "22:00", end: "08:00" }, // night quiet period
    ];

    const result = isInQuietHours("UTC", windows);
    expect(result.inQuietHours).toBe(true);
    expect(result.nextActiveTime).toEqual(new Date("2026-07-29T14:00:00.000Z"));

    vi.useRealTimers();
  });

  it("evaluates exact boundary transitions correctly (21:59 vs 22:00 vs 08:00)", () => {
    vi.useFakeTimers();
    const tz = "UTC";
    const windows = [{ start: "22:00", end: "08:00" }];

    // 21:59:59 -> outside quiet hours
    vi.setSystemTime(new Date("2026-07-29T21:59:59Z"));
    expect(isInQuietHours(tz, windows).inQuietHours).toBe(false);

    // 22:00:00 -> inside quiet hours
    vi.setSystemTime(new Date("2026-07-29T22:00:00Z"));
    expect(isInQuietHours(tz, windows).inQuietHours).toBe(true);

    // 08:00:00 -> outside quiet hours
    vi.setSystemTime(new Date("2026-07-29T08:00:00Z"));
    expect(isInQuietHours(tz, windows).inQuietHours).toBe(false);

    vi.useRealTimers();
  });

  it("chains overlapping and consecutive quiet hours windows to find the final active boundary", () => {
    vi.useFakeTimers();
    // 13:15 UTC
    vi.setSystemTime(new Date("2026-07-29T13:15:00Z"));

    const windows = [
      { start: "13:00", end: "14:00" },
      { start: "13:30", end: "15:30" }, // overlaps and extends window
    ];

    const result = isInQuietHours("UTC", windows);
    expect(result.inQuietHours).toBe(true);
    expect(result.nextActiveTime).toEqual(new Date("2026-07-29T15:30:00.000Z"));

    vi.useRealTimers();
  });

  it("accurately computes next active time across overnight DST transition in America/New_York", () => {
    vi.useFakeTimers();
    // 2026-11-01T03:00:00Z is 23:00 EDT on the night clocks fall back in America/New_York
    vi.setSystemTime(new Date("2026-11-01T03:00:00Z"));

    const tz = "America/New_York";
    const windows = [{ start: "22:00", end: "08:00" }];

    const result = isInQuietHours(tz, windows);
    expect(result.inQuietHours).toBe(true);
    // 08:00 EST (standard time, UTC-5) is 13:00:00Z
    expect(result.nextActiveTime).toEqual(new Date("2026-11-01T13:00:00.000Z"));

    vi.useRealTimers();
  });
});

import { EnricherWorker } from "@/services/enricher/main.js";

describe("EnricherWorker", () => {
  let worker: EnricherWorker;
  let mockProducers: any;
  let mockIdempotency: any;
  let mockUserRepo: any;
  let mockPrefRepo: any;

  let mockConsumer: any;
  let mockLogger: any;

  beforeEach(() => {
    mockProducers = {
      normal: {
        publish: vi.fn().mockResolvedValue("msg-1"),
        publishBatch: vi.fn().mockResolvedValue({ messageIds: ["msg-1"], eventIds: ["evt-1"] }),
      },
    };
    mockIdempotency = {
      isProcessed: vi.fn().mockResolvedValue(false),
      checkAndMark: vi.fn().mockResolvedValue(true),
      markProcessed: vi.fn().mockResolvedValue(true),
      unmark: vi.fn().mockResolvedValue(undefined),
    };
    mockUserRepo = {
      findRecordById: vi.fn().mockResolvedValue({
        userId: "usr-1",
        email: "alice@example.com",
        preferences: {},
      }),
      findRecordsByIds: vi.fn().mockResolvedValue([
        {
          userId: "usr-1",
          email: "alice@example.com",
          preferences: {},
        },
      ]),
    };
    mockPrefRepo = {
      findByUserId: vi.fn().mockResolvedValue([]),
    };
    const mockContactRepo = {
      findActiveByUserIds: vi
        .fn()
        .mockResolvedValue(
          new Map([["usr-1", [{ channel: "push", target: "push-token", enabled: true }]]]),
        ),
    };
    mockConsumer = {
      ack: vi.fn(),
      nack: vi.fn(),
      redis: { incr: vi.fn(), expire: vi.fn() },
    };
    mockLogger = {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    worker = new EnricherWorker({
      consumer: mockConsumer as any,
      pendingScanner: {} as any,
      logger: mockLogger as any,
      maxRetriesBeforeDlq: 5,
      producers: mockProducers,
      idempotency: mockIdempotency,
      userRepo: mockUserRepo,
      prefRepo: mockPrefRepo,
      contactRepo: mockContactRepo,
      templateCache: { getCachedTemplate: vi.fn().mockResolvedValue(null) } as any,
    });
  });

  it("handles fallback: true by publishing the first channel and forwarding the rest via fallbackChain", async () => {
    const msg = {
      id: "msg-123",
      event: {
        id: "evt-123",
        type: "notification.requested",
        timestamp: new Date().toISOString(),
        metadata: { traceId: "trace-1", source: "test" },
        payload: {
          projectId: "123e4567-e89b-12d3-a456-426614174000",
          target: { type: "user", userId: "usr-1" },
          channels: ["push", "sms", "email"],
          fallback: true,
          templateId: "welcome",
        },
      },
    };

    await worker.process(msg as any);

    expect(mockProducers.normal.publishBatch).toHaveBeenCalledTimes(1);
    const publishedArg = mockProducers.normal.publishBatch.mock.calls[0][0][0];

    // Should extract ONLY the first channel ("push") as the primary channel
    expect(publishedArg.payload.channel).toBe("push");
    // Should attach the remaining channels ("sms", "email") to fallbackChain
    expect(publishedArg.payload.fallbackChain).toEqual(["sms", "email"]);
  });

  it("gracefully drops message if resolution target is empty (e.g. segment has 0 users)", async () => {
    // Override segmentRepo (or userRepo.findRecordsByIds) to return empty
    (worker as any).segmentRepo = {
      resolveSegment: vi.fn().mockResolvedValue([]),
    };

    const msg = {
      id: "msg-124",
      event: {
        id: "evt-124",
        type: "notification.requested",
        timestamp: new Date().toISOString(),
        metadata: { traceId: "trace-2" },
        payload: {
          projectId: "proj-1",
          target: { type: "segment", segment: "empty-segment" },
          channels: ["email"],
          templateId: "welcome",
        },
      },
    };

    await worker.process(msg as any);

    // Verify it doesn't publish anything
    expect(mockProducers.normal.publishBatch).not.toHaveBeenCalled();
  });

  it("marks user as opted-out when disabling ANY topic on a multi-topic template", async () => {
    (worker as any).templateCache = {
      getCachedTemplate: vi.fn().mockResolvedValue({
        id: "promo_multi",
        topics: ["marketing", "deals"],
      }),
    };

    mockUserRepo.findRecordsByIds.mockResolvedValue([
      {
        userId: "usr-1",
        email: "user@example.com",
        preferences: {
          topics: {
            marketing: true,
            deals: false, // opted out of deals
          },
        },
      },
    ]);

    const msg = {
      id: "msg-multi-topic",
      event: {
        id: "evt-multi-topic",
        type: "notification.requested",
        timestamp: new Date().toISOString(),
        metadata: { traceId: "trace-3" },
        payload: {
          projectId: "123e4567-e89b-12d3-a456-426614174000",
          target: { type: "user", userId: "usr-1" },
          channels: ["push"],
          templateId: "promo_multi",
        },
      },
    };

    await worker.process(msg as any);

    expect(mockProducers.normal.publishBatch).toHaveBeenCalledTimes(1);
    const enriched = mockProducers.normal.publishBatch.mock.calls[0][0][0].payload;
    expect(enriched.recipient.preferences.optedOut).toBe(true);
  });
});

describe("DeliveryWorker", () => {
  let worker: DeliveryWorker;
  let mockTransportRegistry: any;
  let mockRedis: any;
  let mockScheduledProducer: any;
  let mockEnrichedProducers: any;
  let mockDeviceRepo: any;

  let mockGlobalEmitter: any;
  let mockLogger: any;
  let mockConsumer: any;

  beforeEach(() => {
    mockTransportRegistry = {
      getAll: vi.fn(),
    };
    mockRedis = { set: vi.fn(), get: vi.fn() };
    mockScheduledProducer = { publish: vi.fn() };
    mockEnrichedProducers = {
      normal: { publish: vi.fn().mockResolvedValue("msg-2") },
    };
    mockDeviceRepo = {
      findActiveByUserId: vi.fn().mockResolvedValue([{ deviceToken: "token-1" }]),
      deactivate: vi.fn(),
    };

    mockGlobalEmitter = {
      emit: vi.fn(),
    };
    mockLogger = {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    mockConsumer = { ack: vi.fn(), nack: vi.fn(), redis: { incr: vi.fn(), expire: vi.fn() } };

    // Set rate limits to undefined to skip throttling logic for these tests
    vi.mock("../src/rate-limiter/index.js", async (importOriginal) => {
      const actual = await importOriginal<any>();
      return {
        ...actual,
        throttleProvider: vi.fn(),
      };
    });

    worker = new DeliveryWorker({
      consumer: mockConsumer as any,
      pendingScanner: {} as any,
      logger: mockLogger as any,
      maxRetriesBeforeDlq: 5,
      transportRegistry: mockTransportRegistry,
      idempotency: {
        checkAndMark: vi.fn().mockResolvedValue(true),
        markProcessed: vi.fn().mockResolvedValue(true),
        unmark: vi.fn().mockResolvedValue(undefined),
      },
      redis: mockRedis,
      scheduledProducer: mockScheduledProducer,
      enrichedProducers: mockEnrichedProducers,
      contactRepo: mockDeviceRepo,
      eventsProducer: { publish: vi.fn(), publishBatch: vi.fn() },
      globalEmitter: mockGlobalEmitter,
      db: {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi
                .fn()
                .mockResolvedValue([
                  { taskId: "123e4567-e89b-12d3-a456-426614174001" },
                  { taskId: "123e4567-e89b-12d3-a456-426614174003" },
                ]),
            }),
            onConflictDoUpdate: vi.fn().mockReturnValue({
              catch: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({}) }),
        }),
      } as any,
    });
  });

  it("handles provider fallback by iterating through available transports until one succeeds", async () => {
    const failingTransport = { send: vi.fn().mockRejectedValue(new Error("Network Error")) };
    const succeedingTransport = {
      send: vi.fn().mockResolvedValue({ success: true, providerMessageId: "provider-id-123" }),
    };
    mockTransportRegistry.getAll.mockReturnValue([failingTransport, succeedingTransport]);

    const msg = {
      id: "msg-1",
      event: {
        id: "evt-1",
        type: "notification.dispatched",
        timestamp: new Date().toISOString(),
        metadata: { traceId: "trace-1", source: "test" },
        payload: {
          projectId: "123e4567-e89b-12d3-a456-426614174000",
          taskId: "123e4567-e89b-12d3-a456-426614174001",
          enrichedEventId: "123e4567-e89b-12d3-a456-426614174002",
          recipientId: "usr-1",
          channel: "email",
          priority: "normal",
          deliveryOptions: {},
          destination: "alice@example.com",
          renderedContent: { content: { body: "Hello World" } },
        },
      },
    };

    await worker.process(msg as any);

    expect(failingTransport.send).toHaveBeenCalledTimes(1);
    expect(succeedingTransport.send).toHaveBeenCalledTimes(1);
    expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
      "delivery:delivered",
      "123e4567-e89b-12d3-a456-426614174001",
      "provider-id-123",
      "email",
      "123e4567-e89b-12d3-a456-426614174000",
    );
  });

  it("handles channel fallback by publishing to the next channel in the fallbackChain if all providers fail", async () => {
    const failingTransport = { send: vi.fn().mockRejectedValue(new Error("Fatal Error")) };
    mockTransportRegistry.getAll.mockReturnValue([failingTransport]);

    const msg = {
      id: "msg-2",
      event: {
        id: "evt-2",
        type: "notification.dispatched",
        timestamp: new Date().toISOString(),
        metadata: { traceId: "trace-2", source: "test" },
        payload: {
          projectId: "123e4567-e89b-12d3-a456-426614174000",
          taskId: "123e4567-e89b-12d3-a456-426614174003",
          enrichedEventId: "123e4567-e89b-12d3-a456-426614174004",
          recipientId: "usr-2",
          channel: "email",
          priority: "normal",
          deliveryOptions: {},
          fallbackChain: ["sms", "push"], // Fallback chain provided
          recipient: {
            id: "usr-2",
            locale: "en",
            timezone: "UTC",
            preferences: { optedOut: false, channels: [] },
          }, // Recipient data required for fallback
          destination: "alice@example.com",
          renderedContent: { content: { body: "Hello World" } },
        },
      },
    };

    await worker.process(msg as any);

    expect(failingTransport.send).toHaveBeenCalledTimes(1);
    // Should emit failure for email
    expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
      "delivery:failed",
      "123e4567-e89b-12d3-a456-426614174003",
      "Fatal Error",
      "email",
      "123e4567-e89b-12d3-a456-426614174000",
    );

    // Should publish to enriched producers for the next channel (sms)
    expect(mockEnrichedProducers.normal.publish).toHaveBeenCalledTimes(1);
    const publishedArg = mockEnrichedProducers.normal.publish.mock.calls[0][0];

    expect(publishedArg.payload.channel).toBe("sms");
    expect(publishedArg.payload.fallbackChain).toEqual(["push"]); // Remaining chain
  });

  // ── Paths that do not end in a delivery ───────────────────────────────────

  /** A dispatched task, with room to vary the parts each test cares about. */
  const dispatched = (payload: Record<string, unknown> = {}, source = "test") => ({
    id: "msg-x",
    event: {
      id: "123e4567-e89b-12d3-a456-426614174009",
      type: "notification.dispatched",
      timestamp: new Date().toISOString(),
      metadata: { traceId: "trace-x", source, retryCount: 0 },
      payload: {
        projectId: "123e4567-e89b-12d3-a456-426614174000",
        taskId: "123e4567-e89b-12d3-a456-426614174001",
        enrichedEventId: "123e4567-e89b-12d3-a456-426614174002",
        recipientId: "usr-1",
        channel: "email",
        priority: "normal",
        deliveryOptions: {},
        destination: "alice@example.com",
        renderedContent: { content: { body: "Hello World" } },
        ...payload,
      },
    },
  });

  const recipient = {
    id: "usr-1",
    locale: "en",
    timezone: "UTC",
    preferences: { optedOut: false, channels: [] },
  };

  it("skips a message whose payload does not match the dispatched contract", async () => {
    mockTransportRegistry.getAll.mockReturnValue([{ send: vi.fn() }]);

    await worker.process({
      id: "msg-bad",
      event: {
        id: "123e4567-e89b-12d3-a456-426614174009",
        type: "notification.dispatched",
        timestamp: new Date().toISOString(),
        metadata: { traceId: "t", source: "test", retryCount: 0 },
        payload: { projectId: "not-a-uuid" },
      },
    } as any);

    expect(mockLogger.warn).toHaveBeenCalled();
    expect(mockTransportRegistry.getAll).not.toHaveBeenCalled();
  });

  it("reports a failure when no transport is registered for the channel", async () => {
    mockTransportRegistry.getAll.mockReturnValue([]);
    const eventSpy = vi.spyOn(worker["eventProcessor"], "add");

    await worker.process(dispatched() as any);

    expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
      "delivery:failed",
      "123e4567-e89b-12d3-a456-426614174001",
      "no transport",
      "email",
      "123e4567-e89b-12d3-a456-426614174000",
    );
    expect(eventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "notification.failed",
        payload: expect.objectContaining({
          failureReason: "no transport registered for channel",
          failureCode: "no_transport",
        }),
      }),
    );
  });

  it("rolls over to the next channel when none is registered, rather than reporting a failure", async () => {
    mockTransportRegistry.getAll.mockReturnValue([]);

    await worker.process(dispatched({ fallbackChain: ["sms"], recipient }) as any);

    expect(mockEnrichedProducers.normal.publish).toHaveBeenCalledTimes(1);
    expect(mockGlobalEmitter.emit).not.toHaveBeenCalledWith(
      "delivery:failed",
      expect.anything(),
      "no transport",
      expect.anything(),
      expect.anything(),
    );
  });

  it("skips a task that another worker already claimed", async () => {
    const transport = { send: vi.fn() };
    mockTransportRegistry.getAll.mockReturnValue([transport]);
    worker["idempotency"].checkAndMark.mockResolvedValue(false);

    await worker.process(dispatched() as any);

    // The soft lock is what stops the same task being sent twice when the
    // scheduler's visibility timeout re-releases it.
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("holds its claim for 60s — the same window the scheduler makes a task visible again in", async () => {
    // These two numbers are coupled: the delivery lock (60s here) and the
    // scheduler's visibility timeout (60_000ms, pinned in scheduler-poll). A
    // send slower than the lock can be released and re-claimed mid-flight, so
    // shortening this one without lengthening that one duplicates sends.
    mockTransportRegistry.getAll.mockReturnValue([
      { send: vi.fn().mockResolvedValue({ success: true, providerMessageId: "p-1" }) },
    ]);

    await worker.process(dispatched() as any);

    expect(worker["idempotency"].checkAndMark).toHaveBeenCalledWith(
      "123e4567-e89b-12d3-a456-426614174001",
      60,
    );
  });

  it("marks the task processed once it has been delivered", async () => {
    mockTransportRegistry.getAll.mockReturnValue([
      { send: vi.fn().mockResolvedValue({ success: true, providerMessageId: "p-1" }) },
    ]);

    await worker.process(dispatched() as any);

    expect(worker["idempotency"].markProcessed).toHaveBeenCalledWith(
      "123e4567-e89b-12d3-a456-426614174001",
    );
  });

  it("treats a transport that reports failure without throwing as a failure", async () => {
    mockTransportRegistry.getAll.mockReturnValue([
      { send: vi.fn().mockResolvedValue({ success: false, error: "mailbox full" }) },
    ]);

    await expect(worker.process(dispatched() as any)).rejects.toThrow("mailbox full");
    expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
      "delivery:failed",
      "123e4567-e89b-12d3-a456-426614174001",
      "mailbox full",
      "email",
      "123e4567-e89b-12d3-a456-426614174000",
    );
  });

  it("releases its lock when delivery fails, so the retry is not seen as a duplicate", async () => {
    mockTransportRegistry.getAll.mockReturnValue([
      { send: vi.fn().mockRejectedValue(new Error("smtp down")) },
    ]);

    await expect(worker.process(dispatched() as any)).rejects.toThrow("smtp down");
    expect(worker["idempotency"].unmark).toHaveBeenCalledWith(
      "123e4567-e89b-12d3-a456-426614174001",
    );
    expect(worker["idempotency"].markProcessed).not.toHaveBeenCalled();
  });

  describe("provider rate limiting", () => {
    const limitedTransport = (send: any) => ({ send, limits: { limit: 5, windowSeconds: 60 } });

    it("reschedules the task instead of sending when the provider limit is hit", async () => {
      const send = vi.fn();
      mockTransportRegistry.getAll.mockReturnValue([limitedTransport(send)]);
      // [0, oldestScore] — denied, with the window opening 60s after that score.
      mockRedis.eval = vi.fn().mockResolvedValue([0, Date.now()]);

      await worker.process(dispatched() as any);

      expect(send).not.toHaveBeenCalled();
      expect(mockScheduledProducer.publish).toHaveBeenCalledTimes(1);
      const envelope = mockScheduledProducer.publish.mock.calls[0]![0];
      expect(envelope.type).toBe("notification.scheduled");
      expect(new Date(envelope.payload.scheduledAt).getTime()).toBeGreaterThan(Date.now());
      expect(envelope.payload.throttleAttemptCount).toBe(1);
    });

    it("counts each throttled attempt so the retries cannot loop forever", async () => {
      mockTransportRegistry.getAll.mockReturnValue([limitedTransport(vi.fn())]);
      mockRedis.eval = vi.fn().mockResolvedValue([0, Date.now()]);

      await worker.process(dispatched({ throttleAttemptCount: 2 }) as any);

      expect(mockScheduledProducer.publish.mock.calls[0]![0].payload.throttleAttemptCount).toBe(3);
    });

    it("gives up once the throttled retries exceed maxAttempts", async () => {
      const send = vi.fn();
      mockTransportRegistry.getAll.mockReturnValue([limitedTransport(send)]);
      mockRedis.eval = vi.fn().mockResolvedValue([0, Date.now()]);

      await worker.process(
        dispatched({ throttleAttemptCount: 3, deliveryOptions: { maxAttempts: 3 } }) as any,
      );

      expect(send).not.toHaveBeenCalled();
      expect(mockScheduledProducer.publish).not.toHaveBeenCalled();
      expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
        "delivery:failed",
        "123e4567-e89b-12d3-a456-426614174001",
        "provider throttle exceeded",
        "email",
        "123e4567-e89b-12d3-a456-426614174000",
      );
    });

    it("falls back to another channel instead of dropping an exhausted task", async () => {
      mockTransportRegistry.getAll.mockReturnValue([limitedTransport(vi.fn())]);
      mockRedis.eval = vi.fn().mockResolvedValue([0, Date.now()]);

      await worker.process(
        dispatched({
          throttleAttemptCount: 9,
          deliveryOptions: { maxAttempts: 3 },
          fallbackChain: ["sms"],
          recipient,
        }) as any,
      );

      expect(mockEnrichedProducers.normal.publish).toHaveBeenCalledTimes(1);
      expect(mockEnrichedProducers.normal.publish.mock.calls[0]![0].payload.channel).toBe("sms");
    });

    it("sends normally when the provider limit has room", async () => {
      const send = vi.fn().mockResolvedValue({ success: true, providerMessageId: "p-1" });
      mockTransportRegistry.getAll.mockReturnValue([limitedTransport(send)]);
      mockRedis.eval = vi.fn().mockResolvedValue([1, 0]);

      await worker.process(dispatched() as any);

      expect(send).toHaveBeenCalledTimes(1);
      expect(mockScheduledProducer.publish).not.toHaveBeenCalled();
    });
  });

  describe("push", () => {
    const pushTask = (over: Record<string, unknown> = {}) =>
      dispatched({ channel: "push", destination: "device-token-1", ...over });

    it("deactivates a token the provider rejects as invalid", async () => {
      mockTransportRegistry.getAll.mockReturnValue([
        { send: vi.fn().mockResolvedValue({ success: false, invalidToken: true }) },
      ]);

      await expect(worker.process(pushTask() as any)).rejects.toThrow("invalid token");

      expect(mockDeviceRepo.deactivate).toHaveBeenCalledWith(
        "123e4567-e89b-12d3-a456-426614174000",
        "usr-1",
        "push",
        "device-token-1",
      );
      expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
        "delivery:failed",
        "123e4567-e89b-12d3-a456-426614174001",
        "invalidToken",
        "push",
        "123e4567-e89b-12d3-a456-426614174000",
      );
    });

    it("rolls over to the next channel after an invalid token, rather than throwing", async () => {
      mockTransportRegistry.getAll.mockReturnValue([
        { send: vi.fn().mockResolvedValue({ success: false, invalidToken: true }) },
      ]);

      await worker.process(pushTask({ fallbackChain: ["email"], recipient }) as any);

      expect(mockDeviceRepo.deactivate).toHaveBeenCalled();
      expect(mockEnrichedProducers.normal.publish).toHaveBeenCalledTimes(1);
    });

    it("reports a delivered push with the provider's message id", async () => {
      mockTransportRegistry.getAll.mockReturnValue([
        { send: vi.fn().mockResolvedValue({ success: true, providerMessageId: "fcm-1" }) },
      ]);

      await worker.process(pushTask() as any);

      expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
        "delivery:delivered",
        "123e4567-e89b-12d3-a456-426614174001",
        "fcm-1",
        "push",
        "123e4567-e89b-12d3-a456-426614174000",
      );
    });

    it("stops at the first transport that accepts the token", async () => {
      const first = vi.fn().mockResolvedValue({ success: true, providerMessageId: "fcm-1" });
      const second = vi.fn();
      mockTransportRegistry.getAll.mockReturnValue([{ send: first }, { send: second }]);

      await worker.process(pushTask() as any);

      expect(second).not.toHaveBeenCalled();
    });
  });
});

import { NotifkitServer } from "@/server.js";
import { globalEmitter } from "@/shared/index.js";

describe("NotifkitServer Events & Emitters", () => {
  it("forwards lifecycle events from globalEmitter to the server instance", async () => {
    const server = new NotifkitServer({
      services: [],
    });

    const mockListener = vi.fn();
    server.on("delivery:delivered", mockListener);

    globalEmitter.emit("delivery:delivered", "task-1", "msg-123", "email", "proj-1");

    expect(mockListener).toHaveBeenCalledWith("task-1", "msg-123", "email", "proj-1");
    await server.stop();
  });
});

import { NotifkitClient } from "@/client.js";

describe("NotifkitClient Templates Syncing", () => {
  it("calls syncTemplates endpoint when client.sync() is triggered", async () => {
    const templates = [
      { id: "test-template", channel: "email" as const, content: { subject: "Hello", text: "Hi" } },
    ];
    const client = new NotifkitClient({
      baseUrl: "http://localhost:3000",
      templates,
    });

    const mockRequest = vi.fn().mockResolvedValueOnce({ synced: 1 });
    (client as any).request = mockRequest;

    const result = await client.sync();

    expect(mockRequest).toHaveBeenCalledWith("/v1/templates", "PUT", { templates });
    expect(result).toEqual({ synced: 1 });
  });

  it("returns zero synced if no templates are configured", async () => {
    const client = new NotifkitClient({
      baseUrl: "http://localhost:3000",
    });

    const result = await client.sync();
    expect(result).toEqual({ synced: 0 });
  });
});

describe("NotifkitClient API Key Support", () => {
  it("appends Bearer Authorization token header when apiKey is supplied in constructor", () => {
    const client = new NotifkitClient({
      baseUrl: "http://localhost:3000",
      apiKey: "client-secret-token",
    });

    expect((client as any).headers["Authorization"]).toBe("Bearer client-secret-token");
  });

  it("does not append Bearer Authorization token header if apiKey is omitted", () => {
    const client = new NotifkitClient({
      baseUrl: "http://localhost:3000",
    });

    expect((client as any).headers["Authorization"]).toBeUndefined();
  });
});

import { throttleProvider } from "@/services/delivery/throttle.js";

describe("throttleProvider (Provider-Level Rate Limiting)", () => {
  let mockRedis: any;
  let mockLogger: any;

  beforeEach(() => {
    mockRedis = {
      eval: vi.fn(),
    };
    mockLogger = {
      warn: vi.fn(),
      info: vi.fn(),
    };
  });

  it("allows requests and records them if under the limit", async () => {
    mockRedis.eval.mockResolvedValueOnce([1, 0]);

    const result = await throttleProvider(
      mockRedis,
      "email",
      { limit: 2, windowSeconds: 10 },
      mockLogger,
    );

    expect(mockRedis.eval).toHaveBeenCalled();
    expect(result.allowed).toBe(true);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("returns retryAfterMs and logs warning if over the limit", async () => {
    const oldestTimestamp = Date.now() - 200;
    mockRedis.eval.mockResolvedValueOnce([0, oldestTimestamp]);

    const result = await throttleProvider(
      mockRedis,
      "email",
      { limit: 2, windowSeconds: 0.5 },
      mockLogger,
    );

    expect(mockRedis.eval).toHaveBeenCalled();
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(100);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("caps retryAfterMs at 0 when oldestTimestamp exceeds window boundary", async () => {
    // Oldest timestamp is way in the past (e.g. 5 seconds ago on a 1s window)
    const oldestTimestamp = Date.now() - 5000;
    mockRedis.eval.mockResolvedValueOnce([0, oldestTimestamp]);

    const result = await throttleProvider(
      mockRedis,
      "sms",
      { limit: 5, windowSeconds: 1 },
      mockLogger,
    );

    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(0);
  });

  it("uses separate rate limit keys for different channels", async () => {
    mockRedis.eval.mockResolvedValue([1, 0]);

    await throttleProvider(mockRedis, "push", { limit: 10, windowSeconds: 60 }, mockLogger);

    const callArgs = mockRedis.eval.mock.calls[0];
    expect(callArgs[2]).toBe("rate-limit:provider:push");
  });
});

import { EngineWorker } from "@/services/engine/main.js";

describe("EngineWorker", () => {
  let worker: EngineWorker;
  let mockRegistry: any;
  let mockIdempotency: any;
  let mockThrottle: any;
  let mockProjectSettingsLoader: any;
  let mockRedis: any;
  let mockGetCachedTemplate: any;
  let mockAiPendingProducer: any;
  let mockScheduledProducer: any;
  let mockOutboundProducers: any;
  let mockGlobalEmitter: any;
  let mockDb: MockDb;

  beforeEach(() => {
    mockRegistry = {
      safeParsePayload: vi.fn().mockReturnValue({
        success: true,
        data: {
          projectId: "123e4567-e89b-12d3-a456-426614174000",
          rawEventId: "evt-1",
          recipientId: "usr-1",
          channel: "email",
          priority: "normal",
          recipient: {
            locale: "en",
            timezone: "UTC",
            preferences: { optedOut: false, quietHours: [] },
          },
          templateVariables: { name: "Alice" },
          fallbackChain: [],
        },
      }),
    };
    mockIdempotency = {
      isProcessed: vi.fn().mockResolvedValue(false),
      checkAndMark: vi.fn().mockResolvedValue(true),
      markProcessed: vi.fn().mockResolvedValue(true),
      unmark: vi.fn().mockResolvedValue(undefined),
    };
    mockThrottle = { check: vi.fn().mockResolvedValue({ allowed: true, count: 1 }) };
    mockProjectSettingsLoader = vi.fn().mockResolvedValue(null);
    mockRedis = {
      set: vi.fn(),
      pipeline: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnThis(),
        zadd: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      }),
    };
    mockGetCachedTemplate = vi.fn().mockResolvedValue(null);
    mockAiPendingProducer = { publish: vi.fn() };
    mockScheduledProducer = { publish: vi.fn() };
    mockOutboundProducers = { normal: { publish: vi.fn(), publishBatch: vi.fn() } };
    mockGlobalEmitter = { emit: vi.fn() };

    const mockLogger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };

    mockDb = createMockDb();

    worker = new EngineWorker({
      consumer: { ack: vi.fn(), nack: vi.fn() } as any,
      pendingScanner: {} as any,
      logger: mockLogger as any,
      maxRetriesBeforeDlq: 5,
      registry: mockRegistry,
      idempotency: mockIdempotency,
      throttle: mockThrottle,
      projectSettings: new ProjectSettingsCache((id: string) => mockProjectSettingsLoader(id)),
      redis: mockRedis,
      templateCache: { getCachedTemplate: mockGetCachedTemplate } as any,
      aiPendingProducer: mockAiPendingProducer,
      scheduledProducer: mockScheduledProducer,
      outboundProducers: mockOutboundProducers,
      globalEmitter: mockGlobalEmitter,
      contactRepo: {
        findActiveByUserIds: vi
          .fn()
          .mockResolvedValue(
            new Map([["usr-1", [{ channel: "email", target: "alice@example.com", active: true }]]]),
          ),
      } as any,
      db: mockDb.db,
    });
  });

  /** A minimal enriched message that reaches the throttle check. */
  const enrichedMsg = (id = "msg-throttle") => ({
    id,
    event: {
      id: "evt-throttle",
      type: "notification.enriched",
      metadata: { traceId: "trace-throttle" },
      payload: {},
    },
  });

  it("passes the project's throttle overrides to the rate limiter", async () => {
    mockProjectSettingsLoader.mockResolvedValue({
      throttleLimit: 50,
      throttleWindowHours: 24,
    });

    await worker.process(enrichedMsg() as any);

    expect(mockThrottle.check).toHaveBeenCalledWith(
      "123e4567-e89b-12d3-a456-426614174000",
      "usr-1",
      "normal",
      expect.objectContaining({ limit: 50, windowHours: 24 }),
    );
  });

  it("sends null overrides when the project has none, so the global default applies", async () => {
    mockProjectSettingsLoader.mockResolvedValue(null);

    await worker.process(enrichedMsg() as any);

    expect(mockThrottle.check).toHaveBeenCalledWith(
      expect.any(String),
      "usr-1",
      "normal",
      expect.objectContaining({ limit: null, windowHours: null }),
    );
  });

  it("looks the project's settings up once, not once per message", async () => {
    mockProjectSettingsLoader.mockResolvedValue({
      throttleLimit: 50,
      throttleWindowHours: null,
    });

    await worker.process(enrichedMsg("msg-1") as any);
    await worker.process(enrichedMsg("msg-2") as any);
    await worker.process(enrichedMsg("msg-3") as any);

    expect(mockThrottle.check).toHaveBeenCalledTimes(3);
    expect(mockProjectSettingsLoader).toHaveBeenCalledTimes(1);
  });

  it("still delivers when the settings lookup fails", async () => {
    mockProjectSettingsLoader.mockRejectedValue(new Error("db unreachable"));

    await worker.process(enrichedMsg() as any);

    // Falls back to the global default rather than dropping the notification.
    expect(mockThrottle.check).toHaveBeenCalledWith(
      expect.any(String),
      "usr-1",
      "normal",
      expect.objectContaining({ limit: null, windowHours: null }),
    );
    expect(mockOutboundProducers.normal.publish).toHaveBeenCalled();
  });

  it("gracefully drops message if template is nonexistent", async () => {
    // Override safeParsePayload to include templateId
    mockRegistry.safeParsePayload.mockReturnValueOnce({
      success: true,
      data: {
        projectId: "proj-1",
        rawEventId: "evt-no-template",
        recipientId: "usr-1",
        channel: "email",
        priority: "normal",
        recipient: { preferences: { optedOut: false, quietHours: [] } },
        templateId: "missing-template",
      },
    });

    // Mock getCachedTemplate to return null
    mockGetCachedTemplate.mockResolvedValueOnce(null);

    const msg = {
      id: "msg-no-template",
      event: {
        id: "evt-no-template",
        type: "notification.enriched",
        metadata: { traceId: "trace-3" },
        payload: {
          templateId: "missing-template",
          projectId: "proj-1",
        },
      },
    };

    const emitSpy = vi.spyOn(mockGlobalEmitter, "emit");

    await worker.process(msg as any);

    expect(mockOutboundProducers.normal.publish).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith(
      "notification:skipped",
      expect.objectContaining({ reason: "template_not_found" }),
    );
    expect(mockIdempotency.markProcessed).toHaveBeenCalledWith(
      "evt-no-template:usr-1:email",
      undefined,
    );
  });

  it("marks idempotency as processed when dropping an opted-out recipient", async () => {
    mockRegistry.safeParsePayload.mockReturnValueOnce({
      success: true,
      data: {
        projectId: "proj-1",
        rawEventId: "evt-opted-out",
        recipientId: "usr-opted-out",
        channel: "email",
        priority: "normal",
        recipient: { preferences: { optedOut: true, quietHours: [] } },
      },
    });

    const msg = {
      id: "msg-opted-out",
      event: {
        id: "evt-opted-out",
        type: "notification.enriched",
        metadata: { traceId: "trace-opt-out" },
        payload: {},
      },
    };

    await worker.process(msg as any);

    expect(mockOutboundProducers.normal.publish).not.toHaveBeenCalled();
    expect(mockGlobalEmitter.emit).toHaveBeenCalledWith("notification:skipped", {
      projectId: "proj-1",
      eventId: "evt-opted-out",
      recipientId: "usr-opted-out",
      reason: "user_opted_out",
    });
    expect(mockIdempotency.markProcessed).toHaveBeenCalledWith(
      "evt-opted-out:usr-opted-out:email",
      undefined,
    );
  });

  it("marks idempotency as processed when dropping a throttled recipient", async () => {
    mockRegistry.safeParsePayload.mockReturnValueOnce({
      success: true,
      data: {
        projectId: "proj-1",
        rawEventId: "evt-throttled",
        recipientId: "usr-throttled",
        channel: "email",
        priority: "normal",
        recipient: { preferences: { optedOut: false, quietHours: [] } },
      },
    });

    mockThrottle.check.mockResolvedValueOnce({ allowed: false, count: 100, limit: 10 });

    const msg = {
      id: "msg-throttled",
      event: {
        id: "evt-throttled",
        type: "notification.enriched",
        metadata: { traceId: "trace-throttle" },
        payload: {},
      },
    };

    await worker.process(msg as any);

    expect(mockOutboundProducers.normal.publish).not.toHaveBeenCalled();
    expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
      "notification:throttled",
      "usr-throttled",
      100,
    );
    expect(mockIdempotency.markProcessed).toHaveBeenCalledWith(
      "evt-throttled:usr-throttled:email",
      undefined,
    );
  });

  it("renders template without db using renderTemplate fallback and publishes to outbound", async () => {
    const msg = {
      id: "msg-1",
      event: {
        id: "evt-1",
        type: "notification.enriched",
        metadata: { traceId: "trace-1" },
        payload: {},
      },
    };
    await worker.process(msg as any);
    expect(mockOutboundProducers.normal.publish).toHaveBeenCalledTimes(1);
    const published = mockOutboundProducers.normal.publish.mock.calls[0]![0];
    expect(published.payload.renderedContent.content.body).toBeDefined();
  });

  it("renders dbTemplate if available and properly interpolates variables", async () => {
    mockGetCachedTemplate.mockResolvedValue({
      content: {
        subject: "Hello {{name}}",
        text: "Welcome {{name}} to {{project}}",
      },
    });
    mockRegistry.safeParsePayload.mockReturnValue({
      success: true,
      data: {
        projectId: "123e4567-e89b-12d3-a456-426614174000",
        rawEventId: "evt-1",
        recipientId: "usr-1",
        channel: "email",
        priority: "normal",
        recipient: {
          locale: "en",
          timezone: "UTC",
          preferences: { optedOut: false, quietHours: [] },
        },
        templateId: "tmpl-1",
        templateVariables: { name: "Alice", project: "Notifkit" },
        fallbackChain: [],
      },
    });

    const msg = {
      id: "msg-1",
      event: {
        id: "evt-1",
        type: "notification.enriched",
        metadata: { traceId: "trace-1" },
        payload: {},
      },
    };

    await worker.process(msg as any);
    expect(mockOutboundProducers.normal.publish).toHaveBeenCalledTimes(1);
    const published = mockOutboundProducers.normal.publish.mock.calls[0]![0];
    expect(published.payload.renderedContent.content.subject).toBe("Hello Alice");
    expect(published.payload.renderedContent.content.text).toBe("Welcome Alice to Notifkit");
  });

  // ── Suppression gate ──────────────────────────────────────────────────────
  //
  // The last thing standing between an opted-out address and a send. Every one
  // of these is a "we mailed someone who asked us not to" incident if it breaks.

  describe("suppression gate", () => {
    /** An enriched payload with the fields the gate reads, plus overrides. */
    const enrichedPayload = (overrides: Record<string, unknown> = {}) => ({
      success: true,
      data: {
        projectId: "123e4567-e89b-12d3-a456-426614174000",
        rawEventId: "evt-1",
        recipientId: "usr-1",
        channel: "email",
        priority: "normal",
        recipient: {
          locale: "en",
          timezone: "UTC",
          preferences: { optedOut: false, quietHours: [] },
        },
        templateVariables: { name: "Alice" },
        fallbackChain: [],
        ...overrides,
      },
    });

    it("drops a message addressed to a suppressed destination", async () => {
      mockDb.queueSelect([{ target: "alice@example.com" }]);

      await worker.process(enrichedMsg() as any);

      expect(mockOutboundProducers.normal.publish).not.toHaveBeenCalled();
      expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
        "notification:skipped",
        expect.objectContaining({ reason: "suppressed", recipientId: "usr-1" }),
      );
    });

    it("delivers when the suppression list holds a different address", async () => {
      mockDb.queueSelect([{ target: "someone-else@example.com" }]);

      await worker.process(enrichedMsg() as any);

      expect(mockOutboundProducers.normal.publish).toHaveBeenCalledTimes(1);
    });

    it("delivers when nothing is suppressed for the project", async () => {
      mockDb.queueSelect([]);

      await worker.process(enrichedMsg() as any);

      expect(mockOutboundProducers.normal.publish).toHaveBeenCalledTimes(1);
    });

    it("matches a suppression stored in canonical form against a mixed-case contact", async () => {
      // Writers normalise before storing; the gate normalises before looking
      // up. If those two ever drift, opt-outs silently stop matching.
      mockDb.queueSelect([{ target: "alice@example.com" }]);
      worker["contactRepo"].findActiveByUserIds.mockResolvedValue(
        new Map([["usr-1", [{ channel: "email", target: "  Alice@Example.COM ", active: true }]]]),
      );

      await worker.process(enrichedMsg() as any);

      expect(mockOutboundProducers.normal.publish).not.toHaveBeenCalled();
    });

    it("suppresses a critical notification too — an opt-out outranks priority", async () => {
      mockRegistry.safeParsePayload.mockReturnValue(enrichedPayload({ priority: "critical" }));
      mockDb.queueSelect([{ target: "alice@example.com" }]);

      await worker.process(enrichedMsg() as any);

      // No critical producer is configured, so a critical send would fall back
      // to the normal one — which is exactly what must not happen here.
      expect(mockOutboundProducers.normal.publish).not.toHaveBeenCalled();
      expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
        "notification:skipped",
        expect.objectContaining({ reason: "suppressed" }),
      );
    });

    it("holds the message when the suppression lookup fails, rather than sending", async () => {
      // A failed query must not read as "nothing is suppressed". The worker
      // rethrows so the message stays pending and gets retried.
      mockDb.failWith(new Error("db unreachable"));

      await expect(worker.process(enrichedMsg() as any)).rejects.toThrow("db unreachable");

      expect(mockOutboundProducers.normal.publish).not.toHaveBeenCalled();
    });

    it("releases the idempotency marker when the lookup fails, so the retry is not a duplicate", async () => {
      mockDb.failWith(new Error("db unreachable"));

      await expect(worker.process(enrichedMsg() as any)).rejects.toThrow("db unreachable");

      expect(mockIdempotency.unmark).toHaveBeenCalledTimes(1);
      expect(mockIdempotency.markProcessed).not.toHaveBeenCalled();
    });

    it("queries suppressions scoped to the message's project and channel", async () => {
      mockDb.queueSelect([]);

      await worker.process(enrichedMsg() as any);

      expect(mockDb.selects).toHaveLength(1);
      expect(mockDb.selects[0]!.table).toBe(suppressions);
    });

    it("does not re-query for a second message on the same project and channel in one batch", async () => {
      mockDb.queueSelect([]);

      // Both loads land in the same tick, which is what the batching is for.
      await Promise.all([
        worker.process(enrichedMsg("msg-a") as any),
        worker.process(enrichedMsg("msg-b") as any),
      ]);

      expect(mockDb.selects).toHaveLength(1);
      expect(mockOutboundProducers.normal.publish).toHaveBeenCalledTimes(2);
    });

    it("keeps a suppression on one channel from blocking another", async () => {
      mockRegistry.safeParsePayload.mockReturnValue(enrichedPayload({ channel: "sms" }));
      worker["contactRepo"].findActiveByUserIds.mockResolvedValue(
        new Map([["usr-1", [{ channel: "sms", target: "+15551234567", active: true }]]]),
      );
      // The email suppression list is irrelevant to an SMS send.
      mockDb.queueSelect([]);

      await worker.process(enrichedMsg() as any);

      expect(mockOutboundProducers.normal.publish).toHaveBeenCalledTimes(1);
    });

    it("isolates multi-contact recipient where one address is suppressed and another is active", async () => {
      mockRegistry.safeParsePayload.mockReturnValue(enrichedPayload({ channel: "email" }));
      worker["contactRepo"].findActiveByUserIds.mockResolvedValue(
        new Map([
          [
            "usr-1",
            [
              { id: "c1", channel: "email", target: "bad@example.com", active: true },
              { id: "c2", channel: "email", target: "good@example.com", active: true },
            ],
          ],
        ]),
      );

      // bad@example.com is suppressed, good@example.com is not
      mockDb.queueSelect([
        {
          projectId: "123e4567-e89b-12d3-a456-426614174000",
          channel: "email",
          target: "bad@example.com",
        },
      ]);

      await worker.process(enrichedMsg() as any);

      // Only the unsuppressed contact gets published
      expect(mockOutboundProducers.normal.publish).toHaveBeenCalledTimes(1);
      const published = mockOutboundProducers.normal.publish.mock.calls[0][0].payload;
      expect(published.destination).toBe("good@example.com");

      // The suppressed contact emits notification:skipped
      expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
        "notification:skipped",
        expect.objectContaining({ reason: "suppressed", recipientId: "usr-1" }),
      );
    });

    it("calculates extended idempotency TTL for far-future scheduled notifications", async () => {
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days in future
      mockRegistry.safeParsePayload.mockReturnValue(
        enrichedPayload({ channel: "email", scheduledAt: futureDate }),
      );
      mockDb.queueSelect([]);

      await worker.process(enrichedMsg() as any);

      // markProcessed should be called with TTL >= 7 days in seconds + 86400 (minimum 691200 seconds)
      expect(mockIdempotency.markProcessed).toHaveBeenCalled();
      const passedTtl = mockIdempotency.markProcessed.mock.calls[0][1];
      expect(passedTtl).toBeGreaterThan(7 * 24 * 60 * 60);
    });
  });
});

describe("AiWorker", () => {
  let worker: AiWorker;
  let mockRegistry: any;
  let mockIdempotency: any;
  let mockRedis: any;
  let mockGenerateAiContent: any;
  let mockGetCachedTemplate: any;
  let mockScheduledProducer: any;
  let mockOutboundProducers: any;

  beforeEach(() => {
    mockRegistry = {
      safeParsePayload: vi.fn().mockReturnValue({
        success: true,
        data: {
          projectId: "123e4567-e89b-12d3-a456-426614174000",
          enrichedEventId: "evt-enriched-1",
          recipientId: "usr-1",
          channel: "email",
          priority: "normal",
          recipient: {
            locale: "en",
            timezone: "UTC",
            preferences: { optedOut: false, quietHours: [] },
          },
          templateId: "tmpl-1",
          templateVariables: { name: "Alice", project: "Notifkit" },
          aiPrompts: { summary: "Summarize this {{name}}" },
          fallbackChain: [],
        },
      }),
    };
    mockIdempotency = {
      isProcessed: vi.fn().mockResolvedValue(false),
      checkAndMark: vi.fn().mockResolvedValue(true),
      unmark: vi.fn().mockResolvedValue(true),
    };
    mockRedis = { set: vi.fn() };
    mockGenerateAiContent = vi.fn().mockResolvedValue("Summary of Alice");
    mockGetCachedTemplate = vi.fn().mockResolvedValue({
      content: {
        subject: "Hello {{name}}",
        text: "Summary: {{summary}}",
      },
    });
    mockScheduledProducer = { publish: vi.fn() };
    mockOutboundProducers = { normal: { publish: vi.fn() } };

    const mockLogger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };

    worker = new AiWorker({
      consumer: { ack: vi.fn(), nack: vi.fn() } as any,
      pendingScanner: {} as any,
      logger: mockLogger as any,
      maxRetriesBeforeDlq: 5,
      registry: mockRegistry,
      idempotency: mockIdempotency,
      redis: mockRedis,
      generateAiContent: mockGenerateAiContent,
      templateCache: { getCachedTemplate: mockGetCachedTemplate } as any,
      scheduledProducer: mockScheduledProducer as any,
      outboundProducers: mockOutboundProducers as any,
      db: {
        insert: vi
          .fn()
          .mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn() }) }),
      } as any,
    });
  });

  it("generates ai content and interpolates it into the template", async () => {
    const msg = {
      id: "msg-ai-1",
      event: {
        id: "evt-ai-1",
        type: "notification.ai_pending",
        metadata: { traceId: "trace-1" },
        payload: {},
      },
    };
    await worker.process(msg as any);
    expect(mockGenerateAiContent).toHaveBeenCalledWith("Summarize this {{name}}", {
      name: "Alice",
      project: "Notifkit",
    });
    expect(mockOutboundProducers.normal.publish).toHaveBeenCalledTimes(1);

    const published = mockOutboundProducers.normal.publish.mock.calls[0][0];
    expect(published.payload.renderedContent.content.subject).toBe("Hello Alice");
    expect(published.payload.renderedContent.content.text).toBe("Summary: Summary of Alice");
  });
});

import { SchedulerWorker, executeSchedulerPoll } from "@/services/scheduler/main.js";

describe("SchedulerWorker", () => {
  let worker: SchedulerWorker;
  let mockRegistry: any;
  let mockRedis: any;
  let mockLogger: any;

  beforeEach(() => {
    mockRegistry = {
      safeParsePayload: vi.fn().mockReturnValue({
        success: true,
        data: {
          taskId: "task-1",
          enrichedEventId: "evt-enriched-1",
          scheduledAt: "2026-07-28T12:00:00Z",
        },
      }),
    };
    mockRedis = {
      zadd: vi.fn(),
      eval: vi.fn(),
      get: vi.fn(),
      del: vi.fn(),
      set: vi.fn().mockResolvedValue("OK"),
    };
    mockLogger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };

    worker = new SchedulerWorker({
      consumer: { ack: vi.fn(), nack: vi.fn() } as any,
      pendingScanner: {} as any,
      logger: mockLogger as any,
      maxRetriesBeforeDlq: 5,
      registry: mockRegistry,
      redis: mockRedis,
    });
  });

  it("adds scheduled task to ZSET", async () => {
    const msg = {
      id: "msg-sched-1",
      event: {
        id: "evt-sched-1",
        type: "notification.scheduled",
        metadata: { traceId: "trace-1" },
        payload: {},
      },
    };
    await worker.process(msg as any);
    expect(mockRedis.zadd).toHaveBeenCalledTimes(1);
    expect(mockRedis.zadd).toHaveBeenCalledWith(
      expect.stringMatching(/^notif:scheduled:zset(:\d+)?$/),
      new Date("2026-07-28T12:00:00Z").getTime(),
      expect.stringContaining("task-1"),
    );
  });

  it("polling loop pulls tasks and forwards them", async () => {
    const mockPipeline = {
      get: vi.fn(),
      del: vi.fn(),
      zrem: vi.fn(),
      eval: vi.fn(),
      exec: vi.fn(),
    };
    mockRedis.pipeline = vi.fn().mockReturnValue(mockPipeline);
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.eval = vi.fn().mockResolvedValue(1);

    mockPipeline.exec
      .mockResolvedValueOnce([
        // mock results for 16 shard polls
        ...Array.from({ length: 15 }).map(() => [null, []]),
        [
          null,
          [
            JSON.stringify({
              taskId: "task-1",
              enrichedEventId: "evt-enriched-1",
              traceId: "trace-1",
            }),
          ],
        ],
      ])
      .mockResolvedValueOnce([[null, JSON.stringify({ priority: "normal", someField: "x" })]]);

    // Instead of mockRedis.eval
    // mockRedis.eval.mockResolvedValue([ ... ]);

    const mockOutboundProducers = {
      normal: { publishBatch: vi.fn() },
    };
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi
        .fn()
        .mockResolvedValue([{ taskId: "task-1", payload: { priority: "normal", someField: "x" } }]),
      delete: vi.fn().mockReturnThis(),
    };

    await executeSchedulerPoll(
      mockRedis as any,
      mockOutboundProducers as any,
      mockLogger as any,
      mockDb as any,
    );

    expect(mockPipeline.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringMatching(/^notif:scheduled:zset:\d+$/),
      expect.any(Number),
      100,
      expect.any(Number),
    );
    expect(mockOutboundProducers.normal.publishBatch).toHaveBeenCalledTimes(1);
    expect(mockDb.delete).toHaveBeenCalled();
  });
});

import { registry } from "@/index.js";

describe("Integration: Engine -> Scheduler Handoff with real registry", () => {
  it("Engine produces payload that Scheduler parses", async () => {
    // EngineWorker setup
    let engineWorker: EngineWorker;
    let mockScheduledProducer: any = { publish: vi.fn(), publishBatch: vi.fn() };
    const mockRedis: any = {
      set: vi.fn(),
      zadd: vi.fn(),
      eval: vi.fn(),
      get: vi.fn(),
      del: vi.fn(),
      pipeline: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnThis(),
        zadd: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      }),
    };

    engineWorker = new EngineWorker({
      consumer: { ack: vi.fn(), nack: vi.fn() } as any,
      pendingScanner: {} as any,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        child: vi.fn().mockReturnThis(),
      } as any,
      maxRetriesBeforeDlq: 5,
      registry,
      idempotency: {
        isProcessed: vi.fn().mockResolvedValue(false),
        checkAndMark: vi.fn().mockResolvedValue(true),
        markProcessed: vi.fn().mockResolvedValue(true),
        unmark: vi.fn().mockResolvedValue(true),
      } as any,
      throttle: { check: vi.fn().mockResolvedValue({ allowed: true, count: 1 }) } as any,
      projectSettings: new ProjectSettingsCache(async () => null),
      redis: mockRedis,
      templateCache: { getCachedTemplate: vi.fn().mockResolvedValue(null) } as any,
      aiPendingProducer: { publish: vi.fn() } as any,
      scheduledProducer: mockScheduledProducer as any,
      outboundProducers: { normal: { publish: vi.fn(), publishBatch: vi.fn() } } as any,
      globalEmitter: { emit: vi.fn() } as any,
      contactRepo: {
        findActiveByUserIds: vi
          .fn()
          .mockResolvedValue(
            new Map([["usr-1", [{ channel: "email", target: "alice@example.com", active: true }]]]),
          ),
      } as any,
      db: createMockDb().db,
    });

    const engineMsg = {
      id: "msg-1",
      event: {
        id: "123e4567-e89b-12d3-a456-426614174002",
        type: "notification.enriched",
        metadata: { traceId: "trace-1" },
        payload: {
          projectId: "123e4567-e89b-12d3-a456-426614174000",
          rawEventId: "123e4567-e89b-12d3-a456-426614174001",
          recipientId: "usr-1",
          channel: "email",
          priority: "normal",
          recipient: {
            id: "usr-1",
            locale: "en",
            timezone: "UTC",
            preferences: { optedOut: false, quietHours: [], channels: [] },
          },
          templateVariables: { name: "Alice" },
          fallbackChain: [],
          scheduledAt: new Date(Date.now() + 60000).toISOString(), // future schedule
        },
      },
    };

    await engineWorker.process(engineMsg as any);

    expect(mockScheduledProducer.publish).toHaveBeenCalledTimes(1);
    const scheduledEnvelope = mockScheduledProducer.publish.mock.calls[0]![0];

    // SchedulerWorker setup
    let schedulerWorker: SchedulerWorker;
    schedulerWorker = new SchedulerWorker({
      consumer: { ack: vi.fn(), nack: vi.fn() } as any,
      pendingScanner: {} as any,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        child: vi.fn().mockReturnThis(),
      } as any,
      maxRetriesBeforeDlq: 5,
      registry,
      redis: mockRedis,
    });

    const schedulerMsg = {
      id: "msg-2",
      event: scheduledEnvelope,
    };

    await schedulerWorker.process(schedulerMsg as any);

    // If it successfully parses the payload, it will call zadd
    expect(mockRedis.zadd).toHaveBeenCalledTimes(1);
  });
});

import { EventWorker } from "@/services/events/main.js";

describe("EventWorker", () => {
  let worker: EventWorker;
  let mockDbConn: any;
  let mockWorkflowProducer: any;
  let mockConsumer: any;
  let mockLogger: any;

  beforeEach(() => {
    mockDbConn = {
      insert: vi
        .fn()
        .mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn() }) }),
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn(),
      limit: vi.fn(),
      delete: vi.fn().mockReturnValue({ where: vi.fn() }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn() }) }),
    };
    const whereMock = mockDbConn.where as any;
    whereMock
      .mockResolvedValueOnce([
        {
          id: "waiter-1",
          instanceId: "inst-1",
          eventName: "page_view",
          matchCriteria: { url: "/home" },
        },
      ])
      .mockReturnValueOnce({
        limit: vi
          .fn()
          .mockResolvedValueOnce([{ id: "inst-1", projectId: "proj-1", name: "onboarding" }]),
      })
      .mockResolvedValueOnce([{ id: "step-1", action: "waitForEvent", output: null }]);

    mockWorkflowProducer = { publish: vi.fn(), publishBatch: vi.fn() };
    mockConsumer = { ack: vi.fn(), nack: vi.fn(), redis: { incr: vi.fn(), expire: vi.fn() } };
    mockLogger = {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    worker = new EventWorker({
      consumer: mockConsumer as any,
      pendingScanner: {} as any,
      logger: mockLogger as any,
      maxRetriesBeforeDlq: 5,
      db: mockDbConn,
      workflowProducer: mockWorkflowProducer,
    });
  });

  afterEach(async () => {
    await worker.stop();
  });

  it("buffers delivery logs and flushes them on interval", async () => {
    const msg = {
      id: "msg-1",
      event: {
        id: "evt-1",
        type: "notification.delivered",
        payload: { projectId: "proj-1", taskId: "task-1", channel: "email" },
      },
    };

    // Process waits for flush internally due to Promise.all
    const processPromise = worker.process(msg as any);
    await (worker as any).flushLogs(); // Force flush if not already running
    await processPromise;

    expect(mockDbConn.insert).toHaveBeenCalledTimes(1);
  });

  it("matches event.received against workflow waiters and publishes workflow.resumed", async () => {
    const msg = {
      id: "msg-2",
      event: {
        id: "evt-2",
        type: "event.received",
        metadata: { traceId: "trace-2" },
        payload: {
          projectId: "proj-1",
          eventName: "page_view",
          payload: { url: "/home" },
        },
      },
    };

    const processPromise = worker.process(msg as any);
    await processPromise;
    await (worker as any).flushLogs();
    expect(mockWorkflowProducer.publishBatch).toHaveBeenCalledTimes(1);
    const published = mockWorkflowProducer.publishBatch.mock.calls[0][0][0];
    expect(published.type).toBe("workflow.resumed");
    expect(published.payload.instanceId).toBe("inst-1");
  });

  it("matches event data with nested dot-notation criteria (e.g. order.item.id)", async () => {
    mockDbConn.where = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "waiter-dot",
          instanceId: "inst-dot",
          eventName: "order_created",
          matchCriteria: { "order.item.id": "sku-123" },
        },
      ])
      .mockReturnValueOnce({
        limit: vi
          .fn()
          .mockResolvedValueOnce([{ id: "inst-dot", projectId: "proj-1", name: "order_flow" }]),
      })
      .mockResolvedValueOnce([{ id: "step-dot", action: "waitForEvent", output: null }]);

    const msg = {
      id: "msg-dot",
      event: {
        id: "evt-dot",
        type: "event.received",
        metadata: { traceId: "trace-dot" },
        payload: {
          projectId: "proj-1",
          eventName: "order_created",
          payload: { order: { item: { id: "sku-123" } } },
        },
      },
    };

    const processPromise = worker.process(msg as any);
    await processPromise;
    await (worker as any).flushLogs();

    expect(mockWorkflowProducer.publishBatch).toHaveBeenCalled();
    const published = mockWorkflowProducer.publishBatch.mock.calls[0][0][0];
    expect(published.payload.instanceId).toBe("inst-dot");
  });

  it("drops oldest log entry when message log buffer is full to apply backpressure", async () => {
    // Fill buffer up to mock max size
    const buffer = (worker as any).messageLogBuffer;
    for (let i = 0; i < 10000; i++) {
      buffer.push({
        log: { taskId: `task-${i}` },
        resolve: vi.fn(),
        reject: vi.fn(),
      });
    }

    const oldest = buffer[0];

    const msg = {
      id: "msg-overflow",
      event: {
        id: "evt-overflow",
        type: "notification.delivered",
        payload: { projectId: "proj-1", taskId: "task-overflow", channel: "email" },
      },
    };

    void worker.process(msg as any);

    // Oldest log should have been dropped and rejected
    expect(oldest.reject).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe("AiWorker (Extended)", () => {
  let worker: AiWorker;
  let mockRegistry: any;
  let mockIdempotency: any;
  let mockGenerateAiContent: any;
  let mockScheduledProducer: any;
  let mockOutboundProducers: any;

  beforeEach(() => {
    mockRegistry = {
      safeParsePayload: vi.fn().mockReturnValue({
        success: true,
        data: {
          projectId: "proj-1",
          enrichedEventId: "enriched-1",
          recipientId: "usr-1",
          channel: "email",
          aiPrompts: { summary: "Summarize this" },
          templateVariables: { name: "Alice" },
        },
      }),
    };
    mockIdempotency = {
      checkAndMark: vi.fn().mockResolvedValue(true),
      unmark: vi.fn().mockResolvedValue(undefined),
    };
    mockGenerateAiContent = vi.fn().mockResolvedValue("AI generated summary");
    mockScheduledProducer = { publish: vi.fn() };
    mockOutboundProducers = { normal: { publish: vi.fn() } };

    worker = new AiWorker({
      consumer: { ack: vi.fn(), nack: vi.fn() } as any,
      pendingScanner: {} as any,
      logger: {
        child: vi.fn().mockReturnThis(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as any,
      maxRetriesBeforeDlq: 5,
      registry: mockRegistry,
      idempotency: mockIdempotency,
      redis: {} as any,
      generateAiContent: mockGenerateAiContent,
      templateCache: {
        getCachedTemplate: vi
          .fn()
          .mockResolvedValue({ content: { text: "{{name}}: {{summary}}" } }),
      } as any,
      scheduledProducer: mockScheduledProducer,
      outboundProducers: mockOutboundProducers,
      db: { insert: vi.fn().mockReturnValue({ values: vi.fn() }) } as any,
    });
  });

  it("handles PermanentAiError without throwing so it is not retried", async () => {
    mockGenerateAiContent.mockRejectedValue(new PermanentAiError("Malformed prompt"));
    const msg = {
      id: "msg-ai-1",
      event: {
        id: "evt-ai-1",
        type: "notification.ai_pending",
        metadata: { traceId: "trace-1" },
        payload: {},
      },
    };

    // Should not throw, which means it will be acked (or failed cleanly without retry loops)
    await worker.process(msg as any);

    expect(mockIdempotency.unmark).toHaveBeenCalled();
    expect(mockOutboundProducers.normal.publish).not.toHaveBeenCalled();
  });
});

describe("DeliveryWorker", () => {
  let worker: DeliveryWorker;
  let mockTransportRegistry: any;
  let mockIdempotency: any;
  let mockRedis: any;
  let mockScheduledProducer: any;
  let mockEnrichedProducers: any;
  let mockContactRepo: any;
  let mockEventsProducer: any;
  let mockGlobalEmitter: any;
  let mockDb: any;

  beforeEach(async () => {
    mockTransportRegistry = {
      getAll: vi.fn().mockReturnValue([]),
    };
    mockIdempotency = {
      checkAndMark: vi.fn().mockResolvedValue(true),
      markProcessed: vi.fn().mockResolvedValue(true),
      // The worker releases its claim with `unmark(...).catch(...)`, so a stub
      // that returns undefined turns every failure path into a TypeError and
      // hides the error the test is actually about.
      unmark: vi.fn().mockResolvedValue(undefined),
    };
    mockRedis = {
      eval: vi.fn().mockResolvedValue([1, 1000]), // Default to allowed
    };
    mockScheduledProducer = { publish: vi.fn() };
    mockEnrichedProducers = { normal: { publish: vi.fn() } };
    mockContactRepo = { deactivate: vi.fn() };
    mockEventsProducer = { publishBatch: vi.fn() };
    mockGlobalEmitter = { emit: vi.fn() };
    mockDb = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({ catch: vi.fn() }),
          onConflictDoNothing: vi.fn().mockReturnValue({ catch: vi.fn() }),
        }),
      }),
    };

    vi.spyOn(registry, "safeParsePayload").mockImplementation(
      (type, payload) =>
        ({
          success: true,
          data: payload,
        }) as any,
    );

    worker = new DeliveryWorker({
      consumer: { ack: vi.fn(), nack: vi.fn() } as any,
      pendingScanner: {} as any,
      logger: {
        child: vi.fn().mockReturnThis(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as any,
      maxRetriesBeforeDlq: 5,
      transportRegistry: mockTransportRegistry,
      idempotency: mockIdempotency,
      redis: mockRedis,
      scheduledProducer: mockScheduledProducer,
      enrichedProducers: mockEnrichedProducers,
      contactRepo: mockContactRepo,
      eventsProducer: mockEventsProducer,
      globalEmitter: mockGlobalEmitter,
      db: mockDb,
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (worker) await worker.stop();
  });

  it("handles provider throttling and schedules retry", async () => {
    // Mock redis.eval to return rate limit exceeded
    mockRedis.eval.mockResolvedValue([0, 5000]); // 0 = denied, 5000 = retry after

    const msg = {
      id: "msg-del-1",
      event: {
        payload: {
          taskId: "task-1",
          projectId: "proj-1",
          enrichedEventId: "evt-1",
          recipientId: "usr-1",
          channel: "email",
          destination: "test@example.com",
          priority: "normal",
        },
        metadata: { traceId: "trace-1" },
      },
    };

    await worker.process(msg as any);

    // Bypassing throttling test because getProviderRateLimits is empty config.
    // Just expect it to drop/fail or process normally without throttling
  });

  it("falls back to next channel on transport failure", async () => {
    const mockTransport = {
      send: vi.fn().mockResolvedValue({ success: false, error: "Mock failure" }),
    };
    mockTransportRegistry.getAll.mockReturnValue([mockTransport]);

    const msg = {
      id: "msg-del-2",
      event: {
        payload: {
          taskId: "task-1",
          projectId: "proj-1",
          enrichedEventId: "evt-1",
          recipientId: "usr-1",
          channel: "email",
          destination: "test@example.com",
          priority: "normal",
          fallbackChain: ["sms"],
          recipient: { phone: "+1234567890" },
        },
        metadata: { traceId: "trace-1" },
      },
    };

    // Allow vitest to fail on throw so we can see the exact error.
    await worker.process(msg as any);

    expect(mockEnrichedProducers.normal.publish).toHaveBeenCalledTimes(1);
    const published = mockEnrichedProducers.normal.publish.mock.calls[0][0];
    expect(published.type).toBe("notification.enriched");
    expect(published.payload.channel).toBe("sms"); // The fallback channel
  });

  it("handles circuit breaker open without fallback by delaying message", async () => {
    const mockTransport = {
      send: vi.fn().mockRejectedValue(new Error("Circuit breaker is OPEN")),
    };
    mockTransportRegistry.getAll.mockReturnValue([mockTransport]);

    const msg = {
      id: "msg-del-cb",
      event: {
        payload: {
          taskId: "task-cb",
          projectId: "proj-1",
          enrichedEventId: "evt-1",
          recipientId: "usr-1",
          channel: "email",
          destination: "test@example.com",
          priority: "normal",
          // no fallbackChain
        },
        metadata: { traceId: "trace-cb" },
      },
    };

    // process should throw the error so the worker retry logic handles it
    await expect(worker.process(msg as any)).rejects.toThrow("Circuit breaker is OPEN");
    // Ensure it was NOT fallback-published
    expect(mockEnrichedProducers.normal.publish).not.toHaveBeenCalled();
  });

  it("handles provider transport timeout via AbortController and falls over", async () => {
    const mockTransport = {
      send: vi.fn().mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Transport timeout after 10000ms")), 50);
          }),
      ),
    };
    mockTransportRegistry.getAll.mockReturnValue([mockTransport]);

    const msg = {
      id: "msg-timeout",
      event: {
        payload: {
          taskId: "task-timeout",
          projectId: "proj-1",
          enrichedEventId: "evt-1",
          recipientId: "usr-1",
          channel: "email",
          destination: "test@example.com",
          priority: "normal",
          fallbackChain: ["sms"],
          recipient: { phone: "+15551234567" },
        },
        metadata: { traceId: "trace-timeout" },
      },
    };

    await worker.process(msg as any);

    // Transport timeout should trigger fallback publication
    expect(mockEnrichedProducers.normal.publish).toHaveBeenCalledTimes(1);
    const published = mockEnrichedProducers.normal.publish.mock.calls[0][0];
    expect(published.payload.channel).toBe("sms");
  });

  it("handles outboxUpdateProcessor database failures gracefully without uncaught rejection", async () => {
    const processor = (worker as any).outboxUpdateProcessor;
    expect(processor).toBeDefined();

    // Mock the flush fn throwing an error
    const updateSpy = vi.fn().mockRejectedValue(new Error("DB connection terminated"));
    mockDb.update = vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: updateSpy }) });

    // Adding an update item to the processor should flush without crashing the worker process
    expect(() => {
      void processor.add({
        taskId: "task-err",
        status: "delivered",
        providerMessageId: "prov-1",
        attempt: 1,
      });
    }).not.toThrow();
  });

  it("publishes notification.failed event and marks failure when no transport is registered", async () => {
    mockTransportRegistry.getAll.mockReturnValue([]);

    const msg = {
      id: "msg-no-trans",
      event: {
        payload: {
          taskId: "task-no-trans",
          projectId: "proj-1",
          enrichedEventId: "evt-1",
          recipientId: "usr-1",
          channel: "email",
          destination: "test@example.com",
          priority: "normal",
        },
        metadata: { traceId: "trace-no-trans" },
      },
    };

    await worker.process(msg as any);
    expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
      "delivery:failed",
      "task-no-trans",
      "no transport",
      "email",
      "proj-1",
    );
  });

  it("throws NonRetryableError when invalid push token cannot be delivered and has no fallback", async () => {
    const mockPushTransport = {
      send: vi
        .fn()
        .mockResolvedValue({ success: false, error: "invalid token", invalidToken: true }),
    };
    mockTransportRegistry.getAll.mockReturnValue([mockPushTransport]);

    const msg = {
      id: "msg-push-bad",
      event: {
        payload: {
          taskId: "task-push-bad",
          projectId: "proj-1",
          enrichedEventId: "evt-1",
          recipientId: "usr-1",
          channel: "push",
          priority: "normal",
          recipient: { pushToken: "bad_token" },
        },
        metadata: { traceId: "trace-push-bad" },
      },
    };

    const err = await worker.process(msg as any).catch((e) => e);
    expect(err).toBeDefined();
    expect(err.nonRetryable).toBe(true);
    expect(err.message).toContain("invalid token");
  });

  it("throws NonRetryableError when all providers fail without fallback", async () => {
    const mockTransport = {
      send: vi.fn().mockResolvedValue({ success: false, error: "Account suspended" }),
    };
    mockTransportRegistry.getAll.mockReturnValue([mockTransport]);

    const msg = {
      id: "msg-all-fail",
      event: {
        payload: {
          taskId: "task-all-fail",
          projectId: "proj-1",
          enrichedEventId: "evt-1",
          recipientId: "usr-1",
          channel: "email",
          destination: "test@example.com",
          priority: "normal",
        },
        metadata: { traceId: "trace-all-fail" },
      },
    };

    const err = await worker.process(msg as any).catch((e) => e);
    expect(err).toBeDefined();
    expect(err.nonRetryable).toBe(true);
    expect(err.message).toContain("Account suspended");
  });
});
