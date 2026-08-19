import { describe, it, expect, vi, beforeEach } from "vitest";
import { workflowRegistry } from "@/workflows/registry.js";
import { buildStepNotifyPayload } from "@/workflows/sdk.js";
import { NotificationRequestedPayloadSchema } from "@/contracts/events/notification-requested.js";
import type { StreamMessage } from "@/queue/index.js";

const { mockDb, mockRedisNative, mockNotificationProducer, mockWorkflowProducer } = vi.hoisted(
  () => {
    return {
      mockDb: {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        delete: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        then: vi.fn(),
      },
      // The ioredis client the worker actually receives.
      mockRedisNative: {
        zadd: vi.fn(),
        eval: vi.fn(),
        set: vi.fn().mockResolvedValue("OK"),
        del: vi.fn(),
        duplicate: vi.fn(),
      },
      mockNotificationProducer: {
        publish: vi.fn(),
        publishBatch: vi.fn().mockResolvedValue({ messageIds: ["1", "2"], eventIds: ["a", "b"] }),
      },
      mockWorkflowProducer: {
        publish: vi.fn(),
        publishBatch: vi.fn().mockResolvedValue({ messageIds: ["1", "2"], eventIds: ["a", "b"] }),
      },
    };
  },
);

vi.mock("../src/db/index.js", () => ({
  createDatabase: () => ({ db: mockDb, sql: { end: vi.fn() } }),
}));

vi.mock("../src/redis/index.js", () => ({
  RedisClient: vi.fn().mockImplementation(() => ({
    native: mockRedisNative,
    healthCheck: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn(),
  })),
}));

vi.mock("../src/logger/index.js", () => ({
  createLogger: () => ({
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../src/queue/index.js", () => ({
  StreamConsumer: vi.fn(),
  PendingMessageScanner: vi.fn(),
  StreamProducer: vi.fn().mockImplementation((opts) => {
    if (opts.stream.includes("workflow")) return mockWorkflowProducer;
    return mockNotificationProducer;
  }),
}));

// Import after mocks
import { WorkflowWorker, __injectForTests } from "@/services/workflow/main.js";

describe("Workflow Engine Edge Cases", () => {
  let worker: WorkflowWorker;
  const mockConsumer = { redis: mockRedisNative, ack: vi.fn(), nack: vi.fn() } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new WorkflowWorker({
      consumer: mockConsumer,
      pendingScanner: {} as any,
      logger: {
        child: vi.fn().mockReturnThis(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as any,
      maxRetriesBeforeDlq: 5,
      redis: mockRedisNative as any,
      db: mockDb,
      workflowProducer: mockWorkflowProducer,
      notificationProducer: mockNotificationProducer,
    });
    __injectForTests(mockRedisNative, mockDb, mockWorkflowProducer, mockNotificationProducer);

    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.limit.mockReturnThis();
    mockDb.insert.mockReturnThis();
    mockDb.values.mockReturnThis();
    mockDb.returning.mockReturnThis();
    mockDb.update.mockReturnThis();
    mockDb.set.mockReturnThis();
    mockDb.delete.mockReturnThis();
    mockDb.orderBy.mockReturnThis();
    // Default then resolving to empty array
    mockDb.then.mockImplementation((resolve) => {
      resolve([]);
    });
  });

  it("suspends execution on step.wait and schedules a timeout", async () => {
    workflowRegistry.register("test-wait", async ({ step }) => {
      await step.notify({ channels: ["email"], template: "t1" });
      await step.wait("2h");
      await step.notify({ channels: ["sms"], template: "t2" });
    });

    const msg: StreamMessage = {
      id: "1-0",
      event: {
        id: "evt-1",
        type: "workflow.triggered",
        payload: {
          name: "test-wait",
          instanceId: "inst-1",
          projectId: "00000000-0000-0000-0000-000000000000",
          input: { user: { id: "user-1" } },
        },
        metadata: { traceId: "t-1", source: "api", retryCount: 0 },
        timestamp: new Date().toISOString(),
      },
    };

    // 1st run: new instance, no steps
    mockDb.then.mockImplementationOnce((res) => res([])); // instance query
    mockDb.returning.mockResolvedValueOnce([
      { id: "inst-1", name: "test-wait", status: "pending", input: { user: { id: "user-1" } } },
    ]); // insert returning — the row stores the trigger input, so it carries the user
    mockDb.then.mockImplementationOnce((res) => res()); // For the update to running
    mockDb.then.mockImplementationOnce((res) => res([])); // steps query

    await worker.process(msg);

    // Should have published 1 notification
    expect(mockNotificationProducer.publishBatch).toHaveBeenCalledTimes(1);
    // Should have inserted 2 steps (notify, wait)
    expect(mockDb.insert).toHaveBeenCalledTimes(3); // 1 instance + 2 steps
    // Should have scheduled timeout in redis
    expect(mockRedisNative.zadd).toHaveBeenCalledWith(
      "notif:workflow:timers",
      expect.any(Number),
      expect.stringContaining("inst-1"),
    );
  });

  it("replays deterministically and skips executed steps", async () => {
    // 2nd run: waking up from wait
    const msg: StreamMessage = {
      id: "2-0",
      event: {
        id: "evt-2",
        type: "workflow.resumed",
        payload: {
          name: "test-wait",
          instanceId: "inst-1",
          projectId: "00000000-0000-0000-0000-000000000000",
          input: { user: { id: "user-1" } },
        },
        metadata: { traceId: "t-2", source: "scheduler", retryCount: 0 },
        timestamp: new Date().toISOString(),
      },
    };

    // Existing instance
    mockDb.then.mockImplementationOnce((res) =>
      res([
        { id: "inst-1", name: "test-wait", status: "pending", input: { user: { id: "user-1" } } },
      ]),
    );
    mockDb.then.mockImplementationOnce((res) => res()); // For the update to running

    // Existing steps: notify and wait
    mockDb.then.mockImplementationOnce((res) =>
      res([
        { stepIndex: "0", action: "notify", output: { success: true } },
        { stepIndex: "1", action: "wait", output: { scheduledAt: 12345 } },
      ]),
    );

    await worker.process(msg);

    // Should NOT have published the first notification again, only the SECOND notification
    expect(mockNotificationProducer.publishBatch).toHaveBeenCalledTimes(1);
    // Should have inserted 1 step (the final notify)
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    // Should have marked workflow as completed
    expect(mockDb.update).toHaveBeenCalled();
    expect(mockDb.set).toHaveBeenLastCalledWith({ status: "completed" });
  });

  it("handles step.waitForEvent successfully", async () => {
    workflowRegistry.register("test-wait-event", async ({ step }) => {
      const evt = await step.waitForEvent("user.action", {
        timeout: "1h",
        match: { userId: "user-1" },
      });
      if (evt) {
        await step.notify({ channels: ["push"], template: "success" });
      }
    });

    const msg: StreamMessage = {
      id: "3-0",
      event: {
        id: "evt-3",
        type: "workflow.triggered",
        payload: {
          name: "test-wait-event",
          instanceId: "inst-2",
          projectId: "00000000-0000-0000-0000-000000000000",
          input: { user: { id: "user-1" } },
        },
        metadata: { traceId: "t-3", source: "api", retryCount: 0 },
        timestamp: new Date().toISOString(),
      },
    };

    mockDb.then.mockImplementationOnce((res) => res([])); // instance
    mockDb.returning.mockResolvedValueOnce([
      {
        id: "inst-2",
        name: "test-wait-event",
        status: "pending",
        input: { user: { id: "user-1" } },
      },
    ]);
    mockDb.then.mockImplementationOnce((res) => res([])); // steps

    await worker.process(msg);

    // Should have registered waiter and pending step, and ZSET
    expect(mockDb.insert).toHaveBeenCalledTimes(3); // instance, waiter, step
    expect(mockRedisNative.zadd).toHaveBeenCalled();

    // Now simulate resume with event
    const resumeMsg: StreamMessage = {
      id: "4-0",
      event: {
        id: "evt-4",
        type: "workflow.resumed",
        payload: {
          name: "test-wait-event",
          instanceId: "inst-2",
          projectId: "00000000-0000-0000-0000-000000000000",
          input: { user: { id: "user-1" } },
        },
        metadata: { traceId: "t-4", source: "events", retryCount: 0 },
        timestamp: new Date().toISOString(),
      },
    };

    mockDb.then.mockImplementationOnce((res) =>
      res([
        {
          id: "inst-2",
          name: "test-wait-event",
          status: "pending",
          input: { user: { id: "user-1" } },
        },
      ]),
    );
    mockDb.then.mockImplementationOnce((res) => res()); // For the update to running
    // Steps now contain the event output injected by EventWorker
    mockDb.then.mockImplementationOnce((res) =>
      res([{ stepIndex: "0", action: "waitForEvent", output: { action: "clicked" } }]),
    );

    await worker.process(resumeMsg);

    // Should have published the success notification (since evt was truthy)
    expect(mockNotificationProducer.publishBatch).toHaveBeenCalledTimes(1);
    expect(mockDb.update).toHaveBeenCalled();
    expect(mockDb.set).toHaveBeenLastCalledWith({ status: "completed" });
  });

  it("handles step.waitForEvent timeout (returns null)", async () => {
    // 3rd run: waking up from waitForEvent timeout
    const msg: StreamMessage = {
      id: "5-0",
      event: {
        id: "evt-5",
        type: "workflow.resumed",
        payload: {
          name: "test-wait-event",
          instanceId: "inst-2",
          projectId: "00000000-0000-0000-0000-000000000000",
          input: { user: { id: "user-1" } },
        },
        metadata: { traceId: "t-5", source: "scheduler", retryCount: 0 },
        timestamp: new Date().toISOString(),
      },
    };

    mockDb.then.mockImplementationOnce((res) =>
      res([
        {
          id: "inst-2",
          name: "test-wait-event",
          status: "pending",
          input: { user: { id: "user-1" } },
        },
      ]),
    );
    mockDb.then.mockImplementationOnce((res) => res()); // For the update to running
    // Steps contain NO output (null) because EventWorker didn't inject anything, the scheduler woke it up
    mockDb.then.mockImplementationOnce((res) =>
      res([{ stepIndex: "0", action: "waitForEvent", output: null }]),
    );

    await worker.process(msg);

    // Should NOT have published the success notification
    expect(mockNotificationProducer.publish).not.toHaveBeenCalled();
    // But should have completed
    expect(mockDb.update).toHaveBeenCalled();
    // Wait, mockDb.set could be called multiple times now (first running, then completed)
    // We expect the LAST call to be completed
    expect(mockDb.set).toHaveBeenLastCalledWith({ status: "completed" });
  });

  it("handles step.waitForEvent when persisted step output is { timedOut: true }", async () => {
    const msg: StreamMessage = {
      id: "6-0",
      event: {
        id: "evt-6",
        type: "workflow.resumed",
        payload: {
          name: "test-wait-event",
          instanceId: "inst-2",
          projectId: "00000000-0000-0000-0000-000000000000",
          input: { user: { id: "user-1" } },
        },
        metadata: { traceId: "t-6", source: "scheduler", retryCount: 0 },
        timestamp: new Date().toISOString(),
      },
    };

    mockDb.then.mockImplementationOnce((res) =>
      res([
        {
          id: "inst-2",
          name: "test-wait-event",
          status: "pending",
          input: { user: { id: "user-1" } },
        },
      ]),
    );
    mockDb.then.mockImplementationOnce((res) => res()); // For the update to running
    // Persisted step records timedOut: true
    mockDb.then.mockImplementationOnce((res) =>
      res([{ stepIndex: "0", action: "waitForEvent", output: { timedOut: true } }]),
    );

    await worker.process(msg);

    // Should NOT have published the success notification
    expect(mockNotificationProducer.publish).not.toHaveBeenCalled();
    expect(mockDb.set).toHaveBeenLastCalledWith({ status: "completed" });
  });
});

describe("step.notify payload", () => {
  const projectId = "00000000-0000-0000-0000-000000000000";
  const instanceInput = { user: { id: "user-1" }, plan: "pro" };

  it("produces an event the enricher accepts", () => {
    // The enricher validates notification.requested and drops what fails, so a
    // payload that does not parse here is a notification nobody ever receives.
    const built = buildStepNotifyPayload(
      {
        template: "welcome",
        channels: ["email"],
        data: { a: 1 },
        sendAt: "2026-09-01T09:00:00.000Z",
      },
      instanceInput,
      projectId,
    );

    expect(NotificationRequestedPayloadSchema.safeParse(built).success).toBe(true);
    expect(built.templateId).toBe("welcome");
    expect(built.scheduledAt).toBe("2026-09-01T09:00:00.000Z");
    expect(built).not.toHaveProperty("template");
    expect(built).not.toHaveProperty("sendAt");
  });

  it("inherits the instance user when the step names no target", () => {
    const built = buildStepNotifyPayload({ template: "t" }, instanceInput, projectId);
    expect(built.target).toEqual({ type: "user", userId: "user-1" });
  });

  it("lets the step payload override the instance user", () => {
    const built = buildStepNotifyPayload(
      { template: "t", user: "user-9" },
      instanceInput,
      projectId,
    );
    expect(built.target).toEqual({ type: "user", userId: "user-9" });
  });

  it("accepts an inline user object", () => {
    const built = buildStepNotifyPayload(
      { template: "t", user: { id: "user-9", email: "a@b.co" } },
      instanceInput,
      projectId,
    );
    expect(built.target).toEqual({ type: "user", userId: "user-9" });
  });

  it("targets a segment, so one instance can fan out", () => {
    const built = buildStepNotifyPayload(
      { template: "t", segment: "beta" },
      instanceInput,
      projectId,
    );
    expect(built.target).toEqual({ type: "segment", segment: "beta" });
  });

  it("targets a topic", () => {
    const built = buildStepNotifyPayload(
      { template: "t", topic: "outages" },
      instanceInput,
      projectId,
    );
    expect(built.target).toEqual({ type: "topic", topic: "outages" });
  });

  it("throws when no target can be resolved at all", () => {
    expect(() => buildStepNotifyPayload({ template: "t" }, {}, projectId)).toThrow(/no target/);
  });

  it("refuses a list of users rather than silently sending to one", () => {
    expect(() =>
      buildStepNotifyPayload({ template: "t", user: ["a", "b"] }, instanceInput, projectId),
    ).toThrow(/single `user`/);
  });
});
