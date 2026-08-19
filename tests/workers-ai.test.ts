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
    mockDb = { insert: vi.fn().mockReturnThis(), values: vi.fn().mockReturnThis() };

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
          projectId: "00000000-0000-0000-0000-000000000001",
          enrichedEventId: "00000000-0000-0000-0000-000000000002",
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
          projectId: "00000000-0000-0000-0000-000000000001",
          enrichedEventId: "00000000-0000-0000-0000-000000000002",
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
          projectId: "00000000-0000-0000-0000-000000000001",
          enrichedEventId: "00000000-0000-0000-0000-000000000002",
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
          projectId: "00000000-0000-0000-0000-000000000001",
          enrichedEventId: "00000000-0000-0000-0000-000000000002",
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
      "00000000-0000-0000-0000-000000000002",
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
          projectId: "00000000-0000-0000-0000-000000000001",
          enrichedEventId: "00000000-0000-0000-0000-000000000002",
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
          projectId: "00000000-0000-0000-0000-000000000001",
          enrichedEventId: "00000000-0000-0000-0000-000000000002",
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
          projectId: "00000000-0000-0000-0000-000000000001",
          enrichedEventId: "00000000-0000-0000-0000-000000000002",
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
