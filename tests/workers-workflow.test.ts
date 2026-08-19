import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkflowWorker } from "@/services/workflow/main.js";
import { workflowRegistry } from "@/workflows/index.js";
import type { StreamMessage } from "@/queue/index.js";
import { buildStreamEvent } from "@/contracts/index.js";

describe("WorkflowWorker Edge Cases", () => {
  let mockRedis: any;
  let mockDb: any;
  let mockWorkflowProducer: any;
  let mockNotificationProducer: any;
  let worker: WorkflowWorker;

  beforeEach(() => {
    mockRedis = {
      set: vi.fn().mockResolvedValue("OK"),
      eval: vi.fn().mockResolvedValue(null),
      zadd: vi.fn().mockResolvedValue(1),
    };

    const qb: any = {};
    qb.select = vi.fn().mockReturnValue(qb);
    qb.from = vi.fn().mockReturnValue(qb);
    qb.where = vi.fn().mockReturnValue(qb);
    qb.limit = vi
      .fn()
      .mockResolvedValue([{ id: "inst-1", status: "pending", name: "test_flow", input: {} }]);
    qb.insert = vi.fn().mockReturnValue(qb);
    qb.values = vi.fn().mockReturnValue(qb);
    qb.returning = vi
      .fn()
      .mockResolvedValue([{ id: "inst-1", status: "pending", name: "test_flow", input: {} }]);
    qb.update = vi.fn().mockReturnValue(qb);
    qb.set = vi.fn().mockReturnValue(qb);
    qb.then = function (resolve: any) {
      resolve([]);
    };

    mockDb = qb;

    mockWorkflowProducer = {
      publishBatch: vi.fn().mockResolvedValue({ messageIds: ["1", "2"], eventIds: ["a", "b"] }),
    };
    mockNotificationProducer = {
      publishBatch: vi.fn().mockResolvedValue({ messageIds: ["1", "2"], eventIds: ["a", "b"] }),
    };

    worker = new WorkflowWorker({
      consumer: { ack: vi.fn(), nack: vi.fn() } as any,
      pendingScanner: {} as any,
      logger: {
        child: vi.fn().mockReturnThis(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as any,
      concurrency: 1,
      redis: mockRedis,
      db: mockDb,
      workflowProducer: mockWorkflowProducer,
      notificationProducer: mockNotificationProducer,
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await worker.stop();
  });

  it("should ignore events that are not workflow.triggered or resumed", async () => {
    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent("notification.created" as any, {}, "test", "trace") as any,
    };
    await worker.process(msg);
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it("should skip if workflow instance is missing name, instanceId, or projectId", async () => {
    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent("workflow.triggered", { name: "test_flow" }, "test", "trace") as any, // missing instanceId/projectId
    };
    await worker.process(msg);
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it("should skip if no handler found for workflow", async () => {
    mockDb.limit.mockResolvedValueOnce([]); // No dynamic definition found either
    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "workflow.triggered",
        { name: "missing_flow", instanceId: "1", projectId: "p1" },
        "test",
        "trace",
      ) as any,
    };
    await worker.process(msg);
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it("should skip if lock cannot be acquired", async () => {
    workflowRegistry.register("test_flow", async () => {});
    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "workflow.triggered",
        { name: "test_flow", instanceId: "inst-1", projectId: "p1" },
        "test",
        "trace",
      ) as any,
    };
    mockRedis.set.mockResolvedValue(null); // lock acquisition fails
    await worker.process(msg);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("should handle wait step with correct parsing (seconds)", async () => {
    let executed = false;
    workflowRegistry.register("test_flow", async (ctx) => {
      executed = true;
      await ctx.step.wait("5s");
    });

    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "workflow.triggered",
        { name: "test_flow", instanceId: "inst-1", projectId: "p1" },
        "test",
        "trace",
      ) as any,
    };

    mockDb.limit = vi
      .fn()
      .mockResolvedValueOnce([{ id: "inst-1", status: "pending", name: "test_flow", input: {} }])
      .mockResolvedValueOnce([]); // No existing steps

    await worker.process(msg);

    expect(executed).toBe(true);
    expect(mockRedis.zadd).toHaveBeenCalled();
    const args = mockRedis.zadd.mock.calls[0];
    expect(args[0]).toBe("notif:workflow:timers");

    // DB update to pending should be called because of SuspendExecutionError
    expect(mockDb.set).toHaveBeenCalledWith({ status: "pending" });
  });

  it("should handle run step", async () => {
    let executedResult = null;
    workflowRegistry.register("test_flow", async (ctx) => {
      executedResult = await ctx.step.run("custom_logic", async () => {
        return { custom: "result" };
      });
    });

    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "workflow.triggered",
        { name: "test_flow", instanceId: "inst-1", projectId: "p1" },
        "test",
        "trace",
      ) as any,
    };

    mockDb.limit = vi
      .fn()
      .mockResolvedValueOnce([{ id: "inst-1", status: "pending", name: "test_flow", input: {} }])
      .mockResolvedValueOnce([]);

    await worker.process(msg);
    expect(executedResult).toEqual({ custom: "result" });
    expect(mockDb.set).toHaveBeenCalledWith({ status: "completed" });
  });

  it("should fail workflow if handler throws unhandled error", async () => {
    workflowRegistry.register("test_flow", async () => {
      throw new Error("Unhandled crash");
    });

    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "workflow.triggered",
        { name: "test_flow", instanceId: "inst-1", projectId: "p1" },
        "test",
        "trace",
      ) as any,
    };

    mockDb.limit.mockResolvedValueOnce([
      { id: "inst-1", status: "pending", name: "test_flow", input: {} },
    ]);

    await worker.process(msg);
    expect(mockDb.set).toHaveBeenCalledWith({ status: "failed" });
  });

  it("should enforce 24h default timeout for waitForEvent if none provided", async () => {
    let executed = false;
    workflowRegistry.register("test_flow", async (ctx) => {
      executed = true;
      await ctx.step.waitForEvent("payment.succeeded");
    });

    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "workflow.triggered",
        { name: "test_flow", instanceId: "inst-1", projectId: "p1" },
        "test",
        "trace",
      ) as any,
    };

    mockDb.limit = vi
      .fn()
      .mockResolvedValueOnce([{ id: "inst-1", status: "pending", name: "test_flow", input: {} }])
      .mockResolvedValueOnce([]); // No existing steps

    await worker.process(msg);

    expect(executed).toBe(true);
    expect(mockRedis.zadd).toHaveBeenCalled();
    const args = mockRedis.zadd.mock.calls[0];
    expect(args[0]).toBe("notif:workflow:timers");
    // Ensure timeout is approx Date.now() + 24 hours (86400000 ms)
    const score = args[1];
    const expectedScore = Date.now() + 86400000;
    expect(score).toBeGreaterThan(expectedScore - 5000);
    expect(score).toBeLessThan(expectedScore + 5000);
  });

  it("gracefully handles bad template ID in notify step", async () => {
    let executed = false;
    workflowRegistry.register("test_flow", async (ctx) => {
      executed = true;
      await ctx.step.notify({
        template: "missing-template",
        user: "u-1",
        channels: ["email"],
      });
    });

    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "workflow.triggered",
        { name: "test_flow", instanceId: "inst-1", projectId: "p1" },
        "test",
        "trace",
      ) as any,
    };

    mockDb.limit = vi
      .fn()
      .mockResolvedValueOnce([{ id: "inst-1", status: "pending", name: "test_flow", input: {} }])
      .mockResolvedValueOnce([]);

    await worker.process(msg);

    expect(executed).toBe(true);
    // Should publish the request but not crash the workflow
    expect(mockNotificationProducer.publishBatch).toHaveBeenCalledTimes(1);
    expect(mockDb.set).toHaveBeenCalledWith({ status: "completed" });
  });

  it("handles days unit ('7d') in waitForEvent timeout correctly", async () => {
    let executed = false;
    workflowRegistry.register("test_days_flow", async (ctx) => {
      executed = true;
      await ctx.step.waitForEvent("user.login", { timeout: "7d" });
    });

    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "workflow.triggered",
        { name: "test_days_flow", instanceId: "inst-7d", projectId: "p1" },
        "test",
        "trace",
      ) as any,
    };

    mockDb.limit = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "inst-7d", status: "pending", name: "test_days_flow", input: {} },
      ])
      .mockResolvedValueOnce([]);

    await worker.process(msg);

    expect(executed).toBe(true);
    expect(mockRedis.zadd).toHaveBeenCalled();
    const args = mockRedis.zadd.mock.calls[0];
    const score = args[1];
    const expectedScore = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(score).toBeGreaterThan(expectedScore - 5000);
    expect(score).toBeLessThan(expectedScore + 5000);
  });

  it("fails workflow on invalid waitForEvent timeout duration", async () => {
    workflowRegistry.register("test_bad_timeout", async (ctx) => {
      await ctx.step.waitForEvent("user.login", { timeout: "invalid_duration" as any });
    });

    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "workflow.triggered",
        { name: "test_bad_timeout", instanceId: "inst-bad", projectId: "p1" },
        "test",
        "trace",
      ) as any,
    };

    mockDb.limit = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "inst-bad", status: "pending", name: "test_bad_timeout", input: {} },
      ])
      .mockResolvedValueOnce([]);

    await worker.process(msg);

    expect(mockDb.set).toHaveBeenCalledWith({ status: "failed" });
  });

  it("handles dynamic JSON workflow execution from database definitions", async () => {
    // No code-registered handler; fetch from db
    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "workflow.triggered",
        { name: "dynamic_json_flow", instanceId: "inst-dyn", projectId: "p1" },
        "test",
        "trace",
      ) as any,
    };

    mockDb.limit = vi
      .fn()
      // 1. Definition lookup
      .mockResolvedValueOnce([
        {
          projectId: "p1",
          name: "dynamic_json_flow",
          steps: [
            { action: "notify", payload: { user: "u-1", channels: ["email"], template: "tpl-1" } },
            { action: "wait", duration: "10s" },
          ],
        },
      ])
      // 2. Instance lookup
      .mockResolvedValueOnce([
        {
          id: "inst-dyn",
          status: "pending",
          name: "dynamic_json_flow",
          input: { user: { id: "u-1" } },
        },
      ])
      .mockResolvedValueOnce([]);

    await worker.process(msg);

    expect(mockNotificationProducer.publishBatch).toHaveBeenCalledTimes(1);
    expect(mockRedis.zadd).toHaveBeenCalled();
    expect(mockDb.set).toHaveBeenCalledWith({ status: "pending" });
  });

  it("handles concurrent resume collision gracefully when lock is already held", async () => {
    workflowRegistry.register("test_lock_race", async (ctx) => {
      await ctx.step.wait("10s");
    });

    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "workflow.resumed",
        { name: "test_lock_race", instanceId: "inst-locked", projectId: "p1" },
        "test",
        "trace",
      ) as any,
    };

    // Lock acquisition returns null (another process is currently executing)
    mockRedis.set.mockResolvedValueOnce(null);

    await worker.process(msg);

    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("returns null from step.waitForEvent when step output has timedOut: true", async () => {
    let returnedEvent: any = "unset";
    workflowRegistry.register("test_timeout_replay", async (ctx) => {
      returnedEvent = await ctx.step.waitForEvent("payment.received", { timeout: "1h" });
    });

    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "workflow.resumed",
        { name: "test_timeout_replay", instanceId: "inst-timeout-replay", projectId: "p1" },
        "test",
        "trace",
      ) as any,
    };

    mockDb.limit = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "inst-timeout-replay", status: "pending", name: "test_timeout_replay", input: {} },
      ])
      .mockResolvedValueOnce([]);

    // Provide existing step with output = { timedOut: true }
    mockDb.then = function (resolve: any) {
      resolve([
        { id: "step-1", stepIndex: "0", action: "waitForEvent", output: { timedOut: true } },
      ]);
    };

    await worker.process(msg);

    expect(returnedEvent).toBeNull();
    expect(mockDb.set).toHaveBeenCalledWith({ status: "completed" });
  });

  it("handles minutes ('15m') and hours ('3h') units in step.wait correctly", async () => {
    workflowRegistry.register("test_units_flow", async (ctx) => {
      await ctx.step.wait("15m");
    });

    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "workflow.triggered",
        { name: "test_units_flow", instanceId: "inst-units", projectId: "p1" },
        "test",
        "trace",
      ) as any,
    };

    mockDb.limit = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "inst-units", status: "pending", name: "test_units_flow", input: {} },
      ])
      .mockResolvedValueOnce([]);

    await worker.process(msg);

    expect(mockRedis.zadd).toHaveBeenCalled();
    const score = mockRedis.zadd.mock.calls[0]![1];
    const expectedScore = Date.now() + 15 * 60 * 1000;
    expect(score).toBeGreaterThan(expectedScore - 5000);
    expect(score).toBeLessThan(expectedScore + 5000);
  });

  it("fails workflow on invalid step.wait duration format", async () => {
    workflowRegistry.register("test_bad_wait", async (ctx) => {
      await ctx.step.wait("100x" as any);
    });

    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "workflow.triggered",
        { name: "test_bad_wait", instanceId: "inst-bad-wait", projectId: "p1" },
        "test",
        "trace",
      ) as any,
    };

    mockDb.limit = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "inst-bad-wait", status: "pending", name: "test_bad_wait", input: {} },
      ])
      .mockResolvedValueOnce([]);

    await worker.process(msg);

    expect(mockDb.set).toHaveBeenCalledWith({ status: "failed" });
  });

  it("skips step.run execution on replay when step output is already memoized", async () => {
    let runCallCount = 0;
    let finalResult = null;

    workflowRegistry.register("test_memoized_run", async (ctx) => {
      finalResult = await ctx.step.run("calculate_val", async () => {
        runCallCount++;
        return { calculated: 42 };
      });
    });

    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "workflow.resumed",
        { name: "test_memoized_run", instanceId: "inst-memo-run", projectId: "p1" },
        "test",
        "trace",
      ) as any,
    };

    mockDb.limit = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "inst-memo-run", status: "pending", name: "test_memoized_run", input: {} },
      ])
      .mockResolvedValueOnce([]);

    // Provide existing step with output = { calculated: 42 }
    mockDb.then = function (resolve: any) {
      resolve([{ id: "step-1", stepIndex: "0", action: "run", output: { calculated: 42 } }]);
    };

    await worker.process(msg);

    // fn() should never have been invoked because it was memoized!
    expect(runCallCount).toBe(0);
    expect(finalResult).toEqual({ calculated: 42 });
    expect(mockDb.set).toHaveBeenCalledWith({ status: "completed" });
  });

  it("fails workflow if step.run callback throws an error", async () => {
    workflowRegistry.register("test_throw_run", async (ctx) => {
      await ctx.step.run("failing_step", async () => {
        throw new Error("DB connection exploded in step.run");
      });
    });

    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "workflow.triggered",
        { name: "test_throw_run", instanceId: "inst-throw-run", projectId: "p1" },
        "test",
        "trace",
      ) as any,
    };

    mockDb.limit = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "inst-throw-run", status: "pending", name: "test_throw_run", input: {} },
      ])
      .mockResolvedValueOnce([]);

    await worker.process(msg);

    expect(mockDb.set).toHaveBeenCalledWith({ status: "failed" });
  });

  it("handles dynamic JSON workflow with waitForEvent step and unknown actions", async () => {
    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "workflow.triggered",
        { name: "dynamic_wait_flow", instanceId: "inst-dyn-wait", projectId: "p1" },
        "test",
        "trace",
      ) as any,
    };

    mockDb.limit = vi
      .fn()
      // 1. Definition lookup
      .mockResolvedValueOnce([
        {
          projectId: "p1",
          name: "dynamic_wait_flow",
          steps: [
            { action: "unknown_custom_action" },
            { action: "waitForEvent", event: "user.verified", options: { timeout: "2h" } },
          ],
        },
      ])
      // 2. Instance lookup
      .mockResolvedValueOnce([
        { id: "inst-dyn-wait", status: "pending", name: "dynamic_wait_flow", input: {} },
      ])
      .mockResolvedValueOnce([]);

    await worker.process(msg);

    // Waiter inserted and timer scheduled
    expect(mockRedis.zadd).toHaveBeenCalled();
    expect(mockDb.set).toHaveBeenCalledWith({ status: "pending" });
  });

  it("always releases lock via LUA_RELEASE_LOCK in finally block", async () => {
    workflowRegistry.register("test_lock_release", async (ctx) => {
      await ctx.step.notify({ template: "tpl-1", user: "u-1" });
    });

    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "workflow.triggered",
        { name: "test_lock_release", instanceId: "inst-lock-rel", projectId: "p1" },
        "test",
        "trace",
      ) as any,
    };

    mockDb.limit = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "inst-lock-rel", status: "pending", name: "test_lock_release", input: {} },
      ])
      .mockResolvedValueOnce([]);

    await worker.process(msg);

    // Expect eval called with LUA_RELEASE_LOCK
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET'"),
      1,
      "lock:workflow:inst-lock-rel",
      expect.any(String),
    );
  });

  it("skips execution if workflow instance status is not pending", async () => {
    workflowRegistry.register("test_skip_non_pending", async () => {});

    const msg: StreamMessage = {
      id: "1",
      event: buildStreamEvent(
        "workflow.triggered",
        { name: "test_skip_non_pending", instanceId: "inst-completed", projectId: "p1" },
        "test",
        "trace",
      ) as any,
    };

    mockDb.limit = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "inst-completed", status: "completed", name: "test_skip_non_pending", input: {} },
      ]);

    await worker.process(msg);

    // Should NOT update to running
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});
