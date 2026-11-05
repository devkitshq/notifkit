import { describe, it, expect, vi, beforeEach } from "vitest";
import { globalEmitter } from "@/shared/index.js";
import { EnricherWorker } from "@/services/enricher/main.js";

describe("EnricherWorker segment limit", () => {
  it("rejects segments larger than SEGMENT_MAX_USERS", async () => {
    const mockProducer = { publish: vi.fn(), publishBatch: vi.fn() };
    const worker = new EnricherWorker({
      consumer: { ack: vi.fn(), nack: vi.fn() } as any,
      pendingScanner: {} as any,
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        child: vi.fn().mockReturnThis(),
      } as any,
      maxRetriesBeforeDlq: 5,
      producers: { normal: mockProducer } as any,
      idempotency: {
        checkAndMark: vi.fn().mockResolvedValue(true),
        markProcessed: vi.fn().mockResolvedValue(true),
        unmark: vi.fn().mockResolvedValue(true),
      } as any,
      userRepo: {
        findUsersBySegment: vi.fn().mockResolvedValue(Array(150_000).fill("user_id")),
      } as any,
      prefRepo: {} as any,
      contactRepo: {} as any,
      templateCache: { getCachedTemplate: vi.fn().mockResolvedValue({}) } as any,
    });

    // projectId must be a UUID and templateId is required, or the payload is
    // skipped before it reaches the fan-out check.
    const message = {
      id: "msg-1",
      event: {
        id: "evt-1",
        type: "notification.requested",
        metadata: { traceId: "trace-1" },
        payload: {
          projectId: "11111111-1111-4111-8111-111111111111",
          target: { type: "segment", segment: "all_users" },
          templateId: "welcome",
        },
      },
    };

    const failures: unknown[][] = [];
    const onFailed = (...args: unknown[]) => failures.push(args);
    globalEmitter.on("notification:failed", onFailed);
    try {
      await worker.process(message as any);
    } finally {
      globalEmitter.off("notification:failed", onFailed);
    }

    expect(failures).toHaveLength(1);
    expect(String(failures[0]![1])).toContain("exceeds limit");
    expect(mockProducer.publish).not.toHaveBeenCalled();
    expect(mockProducer.publishBatch).not.toHaveBeenCalled();
  });
});

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

  it("emits one event per address, naming the contact so the engine need not look it up", async () => {
    (worker as any).contactRepo.findActiveByUserIds.mockResolvedValue(
      new Map([
        [
          "usr-1",
          [
            { id: "c-1", channel: "email", target: "one@example.com" },
            { id: "c-2", channel: "email", target: "two@example.com" },
          ],
        ],
      ]),
    );

    await worker.process({
      id: "msg-2",
      event: {
        id: "evt-2",
        type: "notification.requested",
        timestamp: new Date().toISOString(),
        metadata: { traceId: "trace-2", source: "test" },
        payload: {
          projectId: "123e4567-e89b-12d3-a456-426614174000",
          target: { type: "user", userId: "usr-1" },
          channels: ["email"],
          templateId: "welcome",
        },
      },
    } as any);

    const events = mockProducers.normal.publishBatch.mock.calls[0][0];
    expect(events.map((e: any) => [e.payload.contactId, e.payload.destination])).toEqual([
      ["c-1", "one@example.com"],
      ["c-2", "two@example.com"],
    ]);
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

  it("resolves multi-channel contacts (e.g. slack, webhook) from contactRepo", async () => {
    (worker as any).contactRepo.findActiveByUserIds = vi.fn().mockResolvedValue(
      new Map([
        [
          "usr-1",
          [
            { channel: "slack", target: "U12345", enabled: true },
            { channel: "webhook", target: "https://hook.site/test", enabled: true },
          ],
        ],
      ]),
    );

    const msg = {
      id: "msg-dynamic-channels",
      event: {
        id: "evt-dynamic-channels",
        type: "notification.requested",
        timestamp: new Date().toISOString(),
        metadata: { traceId: "trace-dc" },
        payload: {
          projectId: "123e4567-e89b-12d3-a456-426614174000",
          target: { type: "user", userId: "usr-1" },
          channels: ["slack", "webhook"],
          templateId: "welcome_alert",
        },
      },
    };

    await worker.process(msg as any);

    expect(mockProducers.normal.publishBatch).toHaveBeenCalled();
    const publishedEvents = mockProducers.normal.publishBatch.mock.calls[0][0];
    const channels = publishedEvents.map((e: any) => e.payload.channel);
    expect(channels).toContain("slack");
    expect(channels).toContain("webhook");
  });
});
