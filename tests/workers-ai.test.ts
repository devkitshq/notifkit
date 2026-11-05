import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AiWorker, isRetryableAiError, PermanentAiError } from "@/services/ai/main.js";
import { registry } from "@/contracts/index.js";
import type { StreamMessage } from "@/queue/index.js";
import { buildStreamEvent, setAiConfig } from "@/index.js";
import { globalEmitter } from "@/shared/index.js";

describe("AiWorker Edge Cases", () => {
  let mockRedis: any;
  let mockIdempotency: any;
  let mockScheduledProducer: any;
  let mockOutboundProducers: any;
  let mockGenerateAiContent: any;
  let mockTemplateCache: any;
  let mockDb: any;
  let worker: AiWorker;

  beforeEach(() => {
    mockRedis = {};
    mockIdempotency = {
      checkAndMark: vi.fn().mockResolvedValue(true),
      unmark: vi.fn().mockResolvedValue(true),
    };
    mockScheduledProducer = { publish: vi.fn().mockResolvedValue(undefined) };
    mockOutboundProducers = {
      critical: { publish: vi.fn().mockResolvedValue(undefined) },
      normal: { publish: vi.fn().mockResolvedValue(undefined) },
    };
    mockGenerateAiContent = vi.fn().mockResolvedValue("generated_text");
    mockTemplateCache = { getCachedTemplate: vi.fn().mockResolvedValue(null) };
    mockDb = {
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    };

    worker = new AiWorker({
      consumer: { ack: vi.fn(), nack: vi.fn() } as any,
      pendingScanner: {} as any,
      logger: {
        child: vi.fn().mockReturnThis(),
        info: vi.fn(),
        warn: vi.fn((...args) => console.log("WARN", JSON.stringify(args))),
        error: vi.fn(),
        debug: vi.fn(),
      } as any,
      concurrency: 1,
      registry,
      idempotency: mockIdempotency,
      redis: mockRedis,
      generateAiContent: mockGenerateAiContent,
      templateCache: mockTemplateCache,
      scheduledProducer: mockScheduledProducer,
      outboundProducers: mockOutboundProducers,
      db: mockDb,
    });

    vi.spyOn(globalEmitter, "emit").mockImplementation(() => true);
    setAiConfig({ aiModel: "test-model" } as any);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await worker.stop();
  });

  it("should drop message on invalid payload", async () => {
    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "notification.ai_pending",
        { invalid: "yes" } as any,
        "test",
        "trace",
      ) as any,
    };
    await worker.process(msg);
    expect(mockIdempotency.checkAndMark).not.toHaveBeenCalled();
  });

  it("should skip duplicate messages (idempotency)", async () => {
    mockIdempotency.checkAndMark.mockResolvedValueOnce(false);
    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "notification.ai_pending",
        {
          projectId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          enrichedEventId: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22",
          recipientId: "usr1",
          channel: "email",
          priority: "normal",
          recipient: { id: "usr1", email: "a@example.com", preferences: {} },
          aiPrompts: { test: "Hello" },
          templateVariables: {},
        } as any,
        "test",
        "trace",
      ) as any,
    };
    await worker.process(msg);
    expect(mockGenerateAiContent).not.toHaveBeenCalled();
  });

  it("should cap the number of prompts per notification", async () => {
    setAiConfig({ aiModel: "test-model", maxPromptsPerNotification: 1 } as any);
    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "notification.ai_pending",
        {
          projectId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          enrichedEventId: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22",
          recipientId: "usr1",
          channel: "email",
          priority: "normal",
          recipient: { id: "usr1", email: "a@example.com", preferences: {} },
          aiPrompts: { one: "p1", two: "p2" },
          templateVariables: {},
        } as any,
        "test",
        "trace",
      ) as any,
    };
    await worker.process(msg);
    expect(mockGenerateAiContent).toHaveBeenCalledTimes(1);
    expect(mockOutboundProducers.normal.publish).toHaveBeenCalled();
  });

  it("should route to scheduled producer if scheduledAt is in the future", async () => {
    const future = Date.now() + 10000;
    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "notification.ai_pending",
        {
          projectId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          enrichedEventId: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22",
          recipientId: "usr1",
          channel: "email",
          priority: "normal",
          recipient: { id: "usr1", email: "a@example.com", preferences: {} },
          aiPrompts: { test: "p1" },
          scheduledAt: new Date(future).toISOString(),
          templateVariables: {},
        } as any,
        "test",
        "trace",
      ) as any,
    };
    await worker.process(msg);
    expect(mockScheduledProducer.publish).toHaveBeenCalled();
    expect(mockOutboundProducers.normal.publish).not.toHaveBeenCalled();
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("should handle PermanentAiError and drop the notification without retry", async () => {
    mockGenerateAiContent.mockRejectedValueOnce(new PermanentAiError("Invalid prompt"));
    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "notification.ai_pending",
        {
          projectId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          enrichedEventId: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22",
          recipientId: "usr1",
          channel: "email",
          priority: "normal",
          recipient: { id: "usr1", email: "a@example.com", preferences: {} },
          aiPrompts: { test: "p1" },
          templateVariables: {},
        } as any,
        "test",
        "trace",
      ) as any,
    };

    await worker.process(msg);
    expect(globalEmitter.emit).toHaveBeenCalledWith(
      "notification:failed",
      "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22",
      "Invalid prompt",
      "email",
    );
    expect(mockIdempotency.unmark).toHaveBeenCalled();
  });

  it("should re-throw transient AI errors for retry", async () => {
    const transientError = new Error("Network timeout");
    transientError.name = "TimeoutError";
    mockGenerateAiContent.mockRejectedValueOnce(transientError);

    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "notification.ai_pending",
        {
          projectId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          enrichedEventId: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22",
          recipientId: "usr1",
          channel: "email",
          priority: "normal",
          recipient: { id: "usr1", email: "a@example.com", preferences: {} },
          aiPrompts: { test: "p1" },
          templateVariables: {},
        } as any,
        "test",
        "trace",
      ) as any,
    };

    await expect(worker.process(msg)).rejects.toThrow("Network timeout");
    expect(mockIdempotency.unmark).toHaveBeenCalled();
  });

  it("should resolve destination to undefined for push channel without explicit token", async () => {
    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "notification.ai_pending",
        {
          projectId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          enrichedEventId: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22",
          recipientId: "usr1",
          channel: "push",
          priority: "normal",
          recipient: { id: "usr1", preferences: {} },
          aiPrompts: { test: "p1" },
          templateVariables: {},
        } as any,
        "test",
        "trace",
      ) as any,
    };

    await worker.process(msg);
    expect(mockOutboundProducers.normal.publish).toHaveBeenCalled();
    const published = mockOutboundProducers.normal.publish.mock.calls[0]![0];
    expect(published.payload.destination).toBeUndefined();
  });

  it("should forward recipient pushToken as destination when channel is push and token is present", async () => {
    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "notification.ai_pending",
        {
          projectId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          enrichedEventId: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22",
          recipientId: "usr1",
          channel: "push",
          priority: "normal",
          recipient: { id: "usr1", pushToken: "token_abc123", preferences: {} },
          aiPrompts: { test: "p1" },
          templateVariables: {},
        } as any,
        "test",
        "trace",
      ) as any,
    };

    await worker.process(msg);
    expect(mockOutboundProducers.normal.publish).toHaveBeenCalled();
    const published = mockOutboundProducers.normal.publish.mock.calls[0]![0];
    expect(published.payload.destination).toBe("token_abc123");
  });

  describe("isRetryableAiError", () => {
    it("should return false for PermanentAiError", () => {
      expect(isRetryableAiError(new PermanentAiError("fail"))).toBe(false);
    });

    it("should return true for TimeoutError", () => {
      const err = new Error("timeout");
      err.name = "TimeoutError";
      expect(isRetryableAiError(err)).toBe(true);
    });

    it("should return false for 400 Bad Request", () => {
      expect(isRetryableAiError({ statusCode: 400 })).toBe(false);
    });

    it("should return true for 429 Too Many Requests", () => {
      expect(isRetryableAiError({ statusCode: 429 })).toBe(true);
    });

    it("should return true for 500 Internal Server Error", () => {
      expect(isRetryableAiError({ status: 500 })).toBe(true);
    });

    it("should return true for unknown generic errors", () => {
      expect(isRetryableAiError(new Error("socket hang up"))).toBe(true);
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
