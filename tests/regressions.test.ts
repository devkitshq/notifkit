import { describe, it, expect, vi } from "vitest";
import { renderWithTemplate } from "@/templates/render.js";
import { UserThrottle, ProjectSettingsCache } from "@/rate-limiter/index.js";
import { PendingMessageScanner } from "@/queue/index.js";
import { isRetryableAiError, PermanentAiError } from "@/services/ai/main.js";
import { LUA_SCHEDULER_POLL } from "@/shared/index.js";
import { EngineWorker } from "@/services/engine/main.js";
import { SchedulerWorker } from "@/services/scheduler/main.js";
import { registry } from "@/index.js";
import { createMockDb } from "./helpers/mock-db.js";

// Each test here pins a bug that shipped to main. See CODE_REVIEW_2.txt.

describe("renderWithTemplate (P1-5: template injection / JSON break)", () => {
  it("does not break when a variable contains a double quote", () => {
    const template = { content: { subject: "Hi {{name}}", text: "Welcome {{name}}" } };
    const out = renderWithTemplate(template, { name: 'John "JD" Smith' });

    expect(out.content.subject).toBe('Hi John "JD" Smith');
    expect(out.content.text).toBe('Welcome John "JD" Smith');
  });

  it("does not let a variable forge sibling template fields", () => {
    const template = { content: { subject: "Hi {{name}}", text: "hello" } };
    // Payload crafted to close the JSON string and inject htmlBody.
    const out = renderWithTemplate(template, {
      name: '","htmlBody":"<script>alert(1)</script>","x":"',
    });

    expect(out.content).not.toHaveProperty("htmlBody");
    expect(out.content).not.toHaveProperty("x");
    expect(Object.keys(out.content).sort()).toEqual(["subject", "text"]);
  });

  it("HTML-escapes values landing in html fields but not in text fields", () => {
    const template = { content: { html: "<p>{{bio}}</p>", text: "{{bio}}" } };
    const out = renderWithTemplate(template, { bio: "<script>x</script>" });

    expect(out.content.html).toBe("<p>&lt;script&gt;x&lt;/script&gt;</p>");
    expect(out.content.text).toBe("<script>x</script>");
  });

  it("strips CR/LF from header fields to prevent header injection", () => {
    const template = { content: { subject: "Order {{ref}}" } };
    const out = renderWithTemplate(template, { ref: "A1\r\nBcc: victim@example.com" });

    expect(out.content.subject).toBe("Order A1 Bcc: victim@example.com");
    expect(out.content.subject).not.toContain("\n");
  });

  it("interpolates nested objects and arrays", () => {
    const template = { content: { blocks: [{ title: "{{a}}" }], meta: { k: "{{b}}" } } };
    const out = renderWithTemplate(template, { a: "one", b: "two" });

    expect(out.content).toEqual({ blocks: [{ title: "one" }], meta: { k: "two" } });
  });
});

describe("UserThrottle (P1-8: tenant isolation)", () => {
  it("namespaces the throttle key by project", async () => {
    const redis: any = { eval: vi.fn().mockResolvedValue(1) };
    const throttle = new UserThrottle({ redis, maxPerHour: 5 });

    await throttle.check("proj-a", "user-1", "normal");
    await throttle.check("proj-b", "user-1", "normal");

    const keyA = redis.eval.mock.calls[0][2];
    const keyB = redis.eval.mock.calls[1][2];

    expect(keyA).toBe("throttle:proj-a:user:user-1");
    expect(keyB).toBe("throttle:proj-b:user:user-1");
    expect(keyA).not.toBe(keyB);
  });
});

describe("PendingMessageScanner (P2-13: cross-stream claims)", () => {
  it("claims each pending id against the stream it is actually pending on", async () => {
    const xpending = vi.fn().mockImplementation(async (stream: string) => {
      if (stream === "stream-1") return [["1-0", "c", 99_999, 1]];
      if (stream === "stream-2") return [["2-0", "c", 99_999, 1]];
      return [];
    });
    const xclaim = vi.fn().mockResolvedValue([]);
    const redis: any = { xpending, xclaim };

    const scanner = new PendingMessageScanner({
      redis,
      stream: ["stream-1", "stream-2"] as any,
      group: "g" as any,
      consumer: "c",
    });

    await scanner.autoclaim(1, 10);

    // Ids gathered from stream-1 must never be claimed against stream-2.
    for (const call of xclaim.mock.calls) {
      const [stream, , , , ...ids] = call;
      if (stream === "stream-1") expect(ids).toEqual(["1-0"]);
      if (stream === "stream-2") expect(ids).toEqual(["2-0"]);
    }
    expect(xclaim).toHaveBeenCalledTimes(2);
  });

  it("tags pending entries with their stream", async () => {
    const redis: any = {
      xpending: vi
        .fn()
        .mockImplementation(async (stream: string) =>
          stream === "stream-1" ? [["1-0", "c", 5, 1]] : [["2-0", "c", 5, 1]],
        ),
    };
    const scanner = new PendingMessageScanner({
      redis,
      stream: ["stream-1", "stream-2"] as any,
      group: "g" as any,
      consumer: "c",
    });

    const entries = await scanner.getPendingEntries(10);
    expect(entries.map((e) => e.stream)).toEqual(["stream-1", "stream-2"]);
  });
});

describe("LUA_SCHEDULER_POLL (P0-3: missing visibility timeout)", () => {
  it("defaults the visibility timeout so a 3-arg call cannot error", () => {
    expect(LUA_SCHEDULER_POLL).toContain("tonumber(ARGV[3]) or 0");
  });
});

describe("AI error classification (P1-11: no re-billing on permanent errors)", () => {
  it("treats a PermanentAiError as non-retryable", () => {
    expect(isRetryableAiError(new PermanentAiError("bad prompt"))).toBe(false);
  });

  it("retries timeouts, rate limits and 5xx", () => {
    expect(isRetryableAiError({ name: "TimeoutError" })).toBe(true);
    expect(isRetryableAiError({ statusCode: 429 })).toBe(true);
    expect(isRetryableAiError({ statusCode: 503 })).toBe(true);
  });

  it("does not retry client errors", () => {
    expect(isRetryableAiError({ statusCode: 400 })).toBe(false);
    expect(isRetryableAiError({ statusCode: 401 })).toBe(false);
  });
});

describe("Worker redis wiring (P0-2: .native.native)", () => {
  // These workers are handed the ioredis client, exactly as the bootstraps do.
  // Passing a RedisClient wrapper here would resolve to undefined at call time.
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };

  it("SchedulerWorker calls zadd directly on the injected client", async () => {
    const redis: any = { zadd: vi.fn() };
    const worker = new SchedulerWorker({
      consumer: { ack: vi.fn(), nack: vi.fn() } as any,
      pendingScanner: {} as any,
      logger,
      registry,
      redis,
    });

    await worker.process({
      id: "m1",
      event: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        type: "notification.scheduled",
        timestamp: new Date().toISOString(),
        metadata: { traceId: "t", source: "test", retryCount: 0 },
        payload: {
          projectId: "11111111-1111-4111-8111-111111111111",
          enrichedEventId: "22222222-2222-4222-8222-222222222222",
          taskId: "33333333-3333-4333-8333-333333333333",
          scheduledAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    } as any);

    expect(redis.zadd).toHaveBeenCalledTimes(1);
    expect(redis.zadd.mock.calls[0][0]).toBe("notif:scheduled:zset:3");
  });

  it("EngineWorker caches the scheduled payload directly on the injected client", async () => {
    const mockSet = vi.fn().mockReturnThis();
    const redis: any = {
      set: vi.fn(),
      pipeline: vi.fn().mockReturnValue({
        set: mockSet,
        zadd: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      }),
    };
    const scheduledProducer = { publish: vi.fn(), publishBatch: vi.fn() };

    const worker = new EngineWorker({
      consumer: { ack: vi.fn(), nack: vi.fn() } as any,
      pendingScanner: {} as any,
      logger,
      registry,
      idempotency: {
        checkAndMark: vi.fn().mockResolvedValue(true),
        markProcessed: vi.fn().mockResolvedValue(true),
        unmark: vi.fn().mockResolvedValue(undefined),
      } as any,
      throttle: { check: vi.fn().mockResolvedValue({ allowed: true, count: 1 }) } as any,
      projectSettings: new ProjectSettingsCache(async () => null),
      redis,
      templateCache: { getCachedTemplate: vi.fn().mockResolvedValue(null) } as any,
      aiPendingProducer: { publish: vi.fn() } as any,
      scheduledProducer: scheduledProducer as any,
      outboundProducers: { normal: { publish: vi.fn() } } as any,
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

    await worker.process({
      id: "m1",
      event: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        type: "notification.enriched",
        timestamp: new Date().toISOString(),
        metadata: { traceId: "t", source: "test", retryCount: 0 },
        payload: {
          projectId: "11111111-1111-4111-8111-111111111111",
          rawEventId: "22222222-2222-4222-8222-222222222222",
          recipientId: "usr-1",
          channel: "email",
          priority: "normal",
          templateVariables: {},
          recipient: {
            id: "usr-1",
            locale: "en",
            timezone: "UTC",
            preferences: { optedOut: false, channels: [] },
          },
          scheduledAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    } as any);

    expect(worker["db"].insert).toHaveBeenCalledTimes(1);
    expect(scheduledProducer.publish).toHaveBeenCalledTimes(1);
  });
});

describe("Engine → Scheduler contract (P0-2 + P0-4 regression)", () => {
  it("the scheduled event the engine emits is accepted by the real schema", async () => {
    const logger: any = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };
    const mockSet = vi.fn().mockReturnThis();
    const engineRedis: any = {
      set: vi.fn(),
      pipeline: vi.fn().mockReturnValue({
        set: mockSet,
        zadd: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      }),
    };
    const scheduledProducer = { publish: vi.fn(), publishBatch: vi.fn() };

    const engine = new EngineWorker({
      consumer: { ack: vi.fn(), nack: vi.fn() } as any,
      pendingScanner: {} as any,
      logger,
      registry,
      idempotency: {
        checkAndMark: vi.fn().mockResolvedValue(true),
        markProcessed: vi.fn().mockResolvedValue(true),
        unmark: vi.fn().mockResolvedValue(undefined),
      } as any,
      throttle: { check: vi.fn().mockResolvedValue({ allowed: true, count: 1 }) } as any,
      projectSettings: new ProjectSettingsCache(async () => null),
      redis: engineRedis,
      templateCache: { getCachedTemplate: vi.fn().mockResolvedValue(null) } as any,
      aiPendingProducer: { publish: vi.fn() } as any,
      scheduledProducer: scheduledProducer as any,
      outboundProducers: { normal: { publish: vi.fn() } } as any,
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

    await engine.process({
      id: "m1",
      event: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        type: "notification.enriched",
        timestamp: new Date().toISOString(),
        metadata: { traceId: "t", source: "test", retryCount: 0 },
        payload: {
          projectId: "11111111-1111-4111-8111-111111111111",
          rawEventId: "22222222-2222-4222-8222-222222222222",
          recipientId: "usr-1",
          channel: "email",
          priority: "normal",
          templateVariables: {},
          recipient: {
            id: "usr-1",
            locale: "en",
            timezone: "UTC",
            preferences: { optedOut: false, channels: [] },
          },
          scheduledAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    } as any);

    const envelope = scheduledProducer.publish.mock.calls[0]![0];
    const parsed = registry.safeParsePayload("notification.scheduled", envelope.payload);
    expect(parsed.success).toBe(true);

    // And the scheduler accepts it end to end.
    const schedRedis: any = { zadd: vi.fn() };
    const scheduler = new SchedulerWorker({
      consumer: { ack: vi.fn(), nack: vi.fn() } as any,
      pendingScanner: {} as any,
      logger,
      registry,
      redis: schedRedis,
    });

    await scheduler.process({
      id: "m2",
      event: {
        ...envelope,
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        timestamp: new Date().toISOString(),
      },
    } as any);
    expect(schedRedis.zadd).toHaveBeenCalledTimes(1);
  });
});
