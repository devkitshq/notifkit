import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BaseWorker,
  NonRetryableError,
  LockHeldError,
  type ProcessResult,
} from "@/workers/index.js";
import type { StreamMessage } from "@/queue/index.js";

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

  it("does not ack or nack on failure, leaving message pending in stream", async () => {
    const worker = new TestWorker({
      consumer: mockConsumer,
      pendingScanner: mockPendingScanner,
      logger: mockLogger,
      maxRetriesBeforeDlq: 3,
    });

    const msg: StreamMessage = {
      id: "msg-1",
      deliveryCount: 1,
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

  it("DLQs message and nacks when retry count exceeds max limit", async () => {
    const worker = new TestWorker({
      consumer: mockConsumer,
      pendingScanner: mockPendingScanner,
      logger: mockLogger,
      maxRetriesBeforeDlq: 3,
    });

    const msg: StreamMessage = {
      id: "msg-1",
      deliveryCount: 4,
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

    await (worker as any).processWithTracking(msg);

    expect(mockConsumer.nack).toHaveBeenCalledWith(
      "msg-1",
      msg.event,
      undefined,
      expect.stringContaining("max retries exceeded"),
    );
  });

  it("leaves no pending timer behind after a clean stop", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const stopped = new Promise<void>((r) => (release = r));
      const consumer = {
        ...mockConsumer,
        ensureGroup: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(async () => release()),
        readBatch: async function* () {
          await stopped;
        },
      };
      const worker = new TestWorker({
        consumer,
        pendingScanner: { getPendingCount: vi.fn().mockResolvedValue(0) } as any,
        logger: mockLogger,
      });

      await worker.start();
      await worker.stop();

      // The 30s stop timeout would otherwise keep the process alive.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
      deliveryCount: 1,
      event: {
        id: "evt-perm-1",
        type: "notification.created",
        timestamp: new Date().toISOString(),
        metadata: { traceId: "t-1", source: "test", retryCount: 0 },
        payload: {},
      },
    };

    await (worker as any).processWithTracking(msg);

    expect(mockConsumer.nack).toHaveBeenCalledWith(
      "msg-perm-1",
      msg.event,
      undefined,
      "fatal: recipient account terminated",
    );
  });

  it("processes successfully without touching Redis retry keys on happy path", async () => {
    class SuccessWorker extends BaseWorker {
      protected async process(): Promise<void> {}
    }

    const multiSpy = vi.spyOn(mockRedis, "multi");
    const worker = new SuccessWorker({
      consumer: mockConsumer,
      pendingScanner: mockPendingScanner,
      logger: mockLogger,
      maxRetriesBeforeDlq: 3,
    });

    const msg: StreamMessage = {
      id: "msg-happy-1",
      deliveryCount: 1,
      event: {
        id: "evt-happy-1",
        type: "notification.created",
        timestamp: new Date().toISOString(),
        metadata: { traceId: "t-1", source: "test", retryCount: 0 },
        payload: {},
      },
    };

    await (worker as any).processWithTracking(msg);

    expect(mockConsumer.ack).toHaveBeenCalledWith("msg-happy-1", undefined);
    expect(multiSpy).not.toHaveBeenCalled();
    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  describe("processInline", () => {
    const inlineEvent = {
      id: "evt-inline-1",
      type: "notification.dispatched",
      timestamp: new Date().toISOString(),
      metadata: { traceId: "t-1", source: "engine", retryCount: 0 },
      payload: {},
    };

    it("runs process without acking anything — there is no stream entry", async () => {
      const seen: StreamMessage[] = [];
      class InlineWorker extends BaseWorker {
        protected async process(message: StreamMessage): Promise<void> {
          seen.push(message);
        }
      }
      mockConsumer.deadLetter = vi.fn();
      const worker = new InlineWorker({
        consumer: mockConsumer,
        pendingScanner: mockPendingScanner,
        logger: mockLogger,
      });

      await worker.processInline(inlineEvent);

      expect(seen[0]!.event).toBe(inlineEvent);
      expect(mockConsumer.ack).not.toHaveBeenCalled();
      expect(worker.health().processedCount).toBe(1);
    });

    it("rethrows retryable errors so the caller's stream entry stays pending", async () => {
      class FailingWorker extends BaseWorker {
        protected async process(): Promise<void> {
          throw new Error("provider down");
        }
      }
      mockConsumer.deadLetter = vi.fn();
      const worker = new FailingWorker({
        consumer: mockConsumer,
        pendingScanner: mockPendingScanner,
        logger: mockLogger,
      });

      await expect(worker.processInline(inlineEvent)).rejects.toThrow("provider down");
      expect(mockConsumer.deadLetter).not.toHaveBeenCalled();
    });

    it("dead-letters non-retryable errors itself instead of failing the caller", async () => {
      class PermanentWorker extends BaseWorker {
        protected async process(): Promise<void> {
          throw new NonRetryableError("invalid token");
        }
      }
      mockConsumer.deadLetter = vi.fn().mockResolvedValue(undefined);
      const worker = new PermanentWorker({
        consumer: mockConsumer,
        pendingScanner: mockPendingScanner,
        logger: mockLogger,
      });

      await expect(worker.processInline(inlineEvent)).resolves.toBeUndefined();
      expect(mockConsumer.deadLetter).toHaveBeenCalledWith(inlineEvent, expect.any(String));
      expect(mockConsumer.nack).not.toHaveBeenCalled();
    });

    it("treats a held lock as someone else's work", async () => {
      class LockedWorker extends BaseWorker {
        protected async process(): Promise<void> {
          throw new LockHeldError();
        }
      }
      mockConsumer.deadLetter = vi.fn();
      const worker = new LockedWorker({
        consumer: mockConsumer,
        pendingScanner: mockPendingScanner,
        logger: mockLogger,
      });

      await expect(worker.processInline(inlineEvent)).resolves.toBeUndefined();
      expect(worker.health().errorCount).toBe(0);
    });
  });

  it("does not ack or nack when process returns { ack: false } (leaving message pending in stream)", async () => {
    class SkipWorker extends BaseWorker {
      protected async process(): Promise<ProcessResult> {
        return { ack: false };
      }
    }

    const worker = new SkipWorker({
      consumer: mockConsumer,
      pendingScanner: mockPendingScanner,
      logger: mockLogger,
      maxRetriesBeforeDlq: 3,
    });

    const msg: StreamMessage = {
      id: "msg-skip-1",
      event: {
        id: "evt-skip-1",
        type: "notification.created",
        timestamp: new Date().toISOString(),
        metadata: { traceId: "t-1", source: "test", retryCount: 0 },
        payload: {},
      },
    };

    await (worker as any).processWithTracking(msg);

    expect(mockConsumer.ack).not.toHaveBeenCalled();
    expect(mockConsumer.nack).not.toHaveBeenCalled();
  });

  it("does not ack or nack when process throws LockHeldError (leaving message pending in stream)", async () => {
    class LockHeldWorker extends BaseWorker {
      protected async process(): Promise<ProcessResult> {
        throw new LockHeldError("lock held");
      }
    }

    const worker = new LockHeldWorker({
      consumer: mockConsumer,
      pendingScanner: mockPendingScanner,
      logger: mockLogger,
      maxRetriesBeforeDlq: 3,
    });

    const msg: StreamMessage = {
      id: "msg-lock-1",
      event: {
        id: "evt-lock-1",
        type: "notification.created",
        timestamp: new Date().toISOString(),
        metadata: { traceId: "t-1", source: "test", retryCount: 0 },
        payload: {},
      },
    };

    await (worker as any).processWithTracking(msg);

    expect(mockConsumer.ack).not.toHaveBeenCalled();
    expect(mockConsumer.nack).not.toHaveBeenCalled();
  });
});
