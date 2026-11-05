import { describe, it, expect, vi, beforeEach } from "vitest";
import { UserThrottle, ProjectSettingsCache } from "@/rate-limiter/index.js";
import { ProviderThrottle } from "@/services/delivery/throttle.js";

describe("UserThrottle", () => {
  it("namespaces the throttle key by project", async () => {
    const redis: any = { throttleUser: vi.fn().mockResolvedValue(1) };
    const throttle = new UserThrottle({ redis, maxPerHour: 5 });

    await throttle.check("proj-a", "user-1", "normal");
    await throttle.check("proj-b", "user-1", "normal");

    expect(redis.throttleUser.mock.calls[0][0]).toBe("throttle:proj-a:user:user-1");
    expect(redis.throttleUser.mock.calls[1][0]).toBe("throttle:proj-b:user:user-1");
  });
});

describe("UserThrottle (Priority-Aware Throttling)", () => {
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = {
      throttleUser: vi.fn(),
    };
  });

  it("allows critical priority notifications to bypass throttling", async () => {
    const throttle = new UserThrottle({ redis: mockRedis, maxPerHour: 3 });
    const result = await throttle.check("proj-1", "usr-1", "critical");

    expect(result.allowed).toBe(true);
    expect(mockRedis.throttleUser).not.toHaveBeenCalled();
  });

  it("throttles normal notifications when limit is exceeded", async () => {
    const throttle = new UserThrottle({ redis: mockRedis, maxPerHour: 3 });
    mockRedis.throttleUser.mockResolvedValueOnce(4);

    const result = await throttle.check("proj-1", "usr-1", "normal");

    expect(result.allowed).toBe(false);
    expect(mockRedis.throttleUser).toHaveBeenCalled();
  });

  // throttleUser args: [key, windowStart, limit, targetTime, memberId, ttl]
  const argWindowStart = (call: any[]) => call[1];
  const argLimit = (call: any[]) => call[2];
  const argTargetTime = (call: any[]) => call[3];
  /** Window length the script was actually asked to enforce. */
  const windowMsOf = (call: any[]) => argTargetTime(call) - argWindowStart(call);

  it("counts a message under its own id, so a retry is not counted twice", async () => {
    const throttle = new UserThrottle({ redis: mockRedis, maxPerHour: 3 });
    mockRedis.throttleUser.mockResolvedValue(1);

    await throttle.check("proj-1", "usr-1", "normal", { messageId: "evt-1:usr-1:email" });
    await throttle.check("proj-1", "usr-1", "normal", { messageId: "evt-1:usr-1:email" });

    const members = mockRedis.throttleUser.mock.calls.map((c: any[]) => c[4]);
    expect(members).toEqual(["evt-1:usr-1:email", "evt-1:usr-1:email"]);
  });

  it("applies a per-project limit override in place of the global default", async () => {
    const throttle = new UserThrottle({ redis: mockRedis, maxPerHour: 3 });
    mockRedis.throttleUser.mockResolvedValueOnce(40);

    const result = await throttle.check("proj-1", "usr-1", "normal", { limit: 50 });

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(50);
    expect(argLimit(mockRedis.throttleUser.mock.calls[0])).toBe(50);
  });

  it("applies a per-project window override", async () => {
    const throttle = new UserThrottle({ redis: mockRedis, maxPerHour: 3 });
    mockRedis.throttleUser.mockResolvedValueOnce(1);

    await throttle.check("proj-1", "usr-1", "normal", { windowHours: 24 });

    // The window must span a full 24h, not the default hour.
    expect(windowMsOf(mockRedis.throttleUser.mock.calls[0])).toBe(24 * 3600_000);
  });

  it("falls back to the default when overrides are null or nonsensical", async () => {
    const throttle = new UserThrottle({ redis: mockRedis, maxPerHour: 7, windowHours: 1 });
    mockRedis.throttleUser.mockResolvedValue(1);

    await throttle.check("proj-1", "usr-1", "normal", { limit: null, windowHours: null });
    expect(argLimit(mockRedis.throttleUser.mock.calls[0])).toBe(7);

    // A stored zero or negative window would make the window meaningless.
    await throttle.check("proj-1", "usr-1", "normal", { windowHours: 0 });
    expect(windowMsOf(mockRedis.throttleUser.mock.calls[1])).toBe(3600_000);

    await throttle.check("proj-1", "usr-1", "normal", { windowHours: -5 });
    expect(windowMsOf(mockRedis.throttleUser.mock.calls[2])).toBe(3600_000);
  });

  it("treats a limit of 0 as a deliberate kill switch, not a missing value", async () => {
    const throttle = new UserThrottle({ redis: mockRedis, maxPerHour: 100 });
    mockRedis.throttleUser.mockResolvedValueOnce(1);

    const result = await throttle.check("proj-1", "usr-1", "normal", { limit: 0 });

    expect(argLimit(mockRedis.throttleUser.mock.calls[0])).toBe(0);
    expect(result.allowed).toBe(false);
  });

  it("still lets critical bypass a per-project override", async () => {
    const throttle = new UserThrottle({ redis: mockRedis, maxPerHour: 100 });

    const result = await throttle.check("proj-1", "usr-1", "critical", { limit: 0 });

    expect(result.allowed).toBe(true);
    expect(mockRedis.throttleUser).not.toHaveBeenCalled();
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

describe("ProviderThrottle (leased provider rate limiting)", () => {
  it("leases a chunk of the window and spends it without further round trips", async () => {
    // Mid-window, so the checks cannot straddle a bucket rollover (which
    // rightly starts a new lease).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.500Z"));
    try {
      const redis: any = { leaseApiRateLimit: vi.fn().mockResolvedValue(500) };
      const throttle = new ProviderThrottle(redis);

      for (let i = 0; i < 50; i++) {
        const result = await throttle.check("email", { limit: 1_000_000, windowSeconds: 1 });
        expect(result.allowed).toBe(true);
      }

      expect(redis.leaseApiRateLimit).toHaveBeenCalledTimes(1);
      expect(redis.leaseApiRateLimit.mock.calls[0][0]).toMatch(/^\{rate-limit:provider:email\}:/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("denies with a retry at the end of the current window once the budget is spent", async () => {
    const redis: any = { leaseApiRateLimit: vi.fn().mockResolvedValue(0) };
    const logger = { warn: vi.fn() };
    const throttle = new ProviderThrottle(redis, logger);

    const result = await throttle.check("sms", { limit: 10, windowSeconds: 60 });

    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("keeps channels on separate budgets", async () => {
    const redis: any = { leaseApiRateLimit: vi.fn().mockResolvedValue(1) };
    const throttle = new ProviderThrottle(redis);

    await throttle.check("email", { limit: 10, windowSeconds: 60 });
    await throttle.check("sms", { limit: 10, windowSeconds: 60 });

    const keys = redis.leaseApiRateLimit.mock.calls.map((c: any[]) => c[0]);
    expect(keys[0]).toContain("provider:email");
    expect(keys[1]).toContain("provider:sms");
  });
});
