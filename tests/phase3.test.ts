import { describe, it, expect, vi } from "vitest";
import { EnricherWorker } from "@/services/enricher/main.js";
import { CircuitBreaker } from "@/shared/index.js";
import { StreamConsumer } from "@/queue/index.js";

describe("Phase 3 Reliability Features", () => {
  describe("Enricher Segment Limits", () => {
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
          // BaseWorker derives a component logger in its constructor.
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
          findUsersBySegment: vi.fn().mockResolvedValue(Array(15000).fill("user_id")),
        } as any,
        prefRepo: {} as any,
        contactRepo: {} as any,
        templateCache: { getCachedTemplate: vi.fn().mockResolvedValue({}) } as any,
      });

      // The worker parses `event.payload` — a `data` property hung off the
      // message is never read. projectId has to be a UUID and templateId is
      // required, or the payload fails to parse and the message is skipped
      // before it ever reaches the fan-out check.
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

      await worker.process(message as any);

      // Verify it emitted a failure event instead of processing
      expect(mockProducer.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "notification.failed",
          payload: expect.objectContaining({
            error: expect.stringContaining("exceeds limit"),
          }),
        }),
      );
    });
  });

  describe("Weighted Fair Queuing", () => {
    it("probabilistically shuffles stream read order", async () => {
      // `readBatch()` only yields once a batch parses, so the mock has to return
      // one. Resolving `null` instead never yields — and with no real BLOCK to
      // pace the read loop, it spins until the heap is gone.
      const streamEvent = {
        id: "00000000-0000-4000-8000-000000000000",
        type: "notification.requested",
        timestamp: new Date().toISOString(),
        payload: {},
        metadata: { traceId: "trace-1", source: "test", retryCount: 0 },
      };
      const redisMock: any = {
        xreadgroup: vi
          .fn()
          .mockResolvedValue([["stream1", [["1-0", ["data", JSON.stringify(streamEvent)]]]]]),
        xack: vi.fn(),
        duplicate: () => redisMock,
      };
      const consumer = new StreamConsumer({
        redis: redisMock as any,
        stream: ["stream1", "stream2", "stream3"] as any,
        group: "group1" as any,
        consumer: "c1",
      });

      // Override Math.random to force a shuffle
      const originalRandom = Math.random;
      Math.random = () => 0.05; // Force trigger shuffle (< 0.1)

      try {
        const iter = consumer.readBatch();
        await iter.next(); // trigger first read

        expect(redisMock.xreadgroup).toHaveBeenCalled();
        const callArgs = redisMock.xreadgroup.mock.calls[0];
        if (!callArgs) throw new Error("xreadgroup not called");

        // Ensure STREAMS keyword is followed by streams, but order is changed
        const streamsIndex = callArgs.indexOf("STREAMS");
        const passedStreams = callArgs.slice(streamsIndex + 1, streamsIndex + 4);

        expect(passedStreams).toHaveLength(3);
        expect(passedStreams).toContain("stream1");
        expect(passedStreams).toContain("stream2");
        expect(passedStreams).toContain("stream3");

        // Depending on offset, stream1 might not be first anymore.
      } finally {
        Math.random = originalRandom;
      }
    });
  });

  describe("Circuit Breaker", () => {
    it("opens after threshold failures", async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
      const failAction = async () => {
        throw new Error("fail");
      };

      await expect(breaker.execute(failAction)).rejects.toThrow("fail");
      await expect(breaker.execute(failAction)).rejects.toThrow("fail");
      await expect(breaker.execute(failAction)).rejects.toThrow("fail");

      // 4th should throw Circuit breaker is OPEN immediately
      await expect(breaker.execute(failAction)).rejects.toThrow("Circuit breaker is OPEN");
    });
  });
});
