import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  it("logs the whole error, stack included, when a flush fails", async () => {
    const failure = new Error("stream unavailable");
    mockWorkflowProducer.publishBatch.mockRejectedValue(failure);
    const msg = {
      id: "msg-flush-fail",
      event: {
        id: "evt-flush-fail",
        type: "event.received",
        metadata: { traceId: "trace-flush-fail" },
        payload: { projectId: "proj-1", eventName: "page_view", payload: { url: "/home" } },
      },
    };

    const processPromise = worker.process(msg as any).catch(() => {});
    await (worker as any).flushLogs();
    await processPromise;

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: failure }),
      "failed to flush delivery logs — dropping batch",
    );
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

  it("writes both the dispatched and the outcome row from a combined entry", async () => {
    const values = vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn() });
    mockDbConn.insert = vi.fn().mockReturnValue({ values });

    const run = worker.process({
      id: "msg-c",
      event: {
        id: "evt-c",
        type: "notification.delivered",
        payload: {
          projectId: "proj-1",
          taskId: "task-c",
          channel: "email",
          providerMessageId: "p-1",
          attempt: 1,
          dispatchedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    } as any);
    await (worker as any).flushLogs();
    await run;

    const rows = values.mock.calls[0]![0];
    expect(rows.map((r: any) => [r.kind, r.status])).toEqual([
      ["dispatched", "dispatched"],
      ["attempt", "delivered"],
    ]);
    expect(rows[0].timestamp).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(rows[0].providerMessageId).toBeNull();
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
