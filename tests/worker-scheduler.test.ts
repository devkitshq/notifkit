import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProjectSettingsCache } from "@/rate-limiter/index.js";
import { EngineWorker } from "@/services/engine/main.js";
import { SchedulerWorker, executeSchedulerPoll } from "@/services/scheduler/main.js";
import { registry } from "@/index.js";
import { createMockDb } from "./helpers/mock-db.js";

const logger: any = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

const scheduler = (redis: any) =>
  new SchedulerWorker({
    consumer: { ack: vi.fn(), nack: vi.fn() } as any,
    pendingScanner: {} as any,
    logger,
    registry,
    redis,
  });

describe("SchedulerWorker", () => {
  it("queues a task on the shard picked by its id, on the injected ioredis client", async () => {
    const redis: any = { zadd: vi.fn() };

    await scheduler(redis).process({
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
});

describe("engine → scheduler handoff", () => {
  it("parks a future send and emits a scheduled event the scheduler accepts", async () => {
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
      redis: {} as any,
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

    // The payload is parked in Postgres, and one scheduled event goes out.
    expect(engine["db"].insert).toHaveBeenCalledTimes(1);
    expect(scheduledProducer.publish).toHaveBeenCalledTimes(1);

    const envelope = scheduledProducer.publish.mock.calls[0]![0];
    expect(registry.safeParsePayload("notification.scheduled", envelope.payload).success).toBe(
      true,
    );

    const schedRedis: any = { zadd: vi.fn() };
    await scheduler(schedRedis).process({
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
      schedulerPoll: vi.fn(),
      exec: vi.fn(),
    };
    mockRedis.pipeline = vi.fn().mockReturnValue(mockPipeline);
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.releaseLock = vi.fn().mockResolvedValue(1);

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

    expect(mockPipeline.schedulerPoll).toHaveBeenCalledWith(
      expect.stringMatching(/^notif:scheduled:zset:\d+$/),
      expect.any(Number),
      100,
      expect.any(Number),
    );
    expect(mockOutboundProducers.normal.publishBatch).toHaveBeenCalledTimes(1);
    expect(mockDb.delete).toHaveBeenCalled();
  });
});

describe("Integration: Engine -> Scheduler Handoff with real registry", () => {
  it("Engine produces payload that Scheduler parses", async () => {
    // EngineWorker setup
    let engineWorker: EngineWorker;
    let mockScheduledProducer: any = { publish: vi.fn(), publishBatch: vi.fn() };
    const mockRedis: any = {
      set: vi.fn(),
      zadd: vi.fn(),
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
