import { describe, it, expect, vi } from "vitest";
import {
  registerCustomCommands,
  RedisClient,
  LUA_LEASE_API_RATE_LIMIT,
  LUA_RELEASE_LOCK,
  LUA_RENEW_LOCK,
  LUA_USER_THROTTLE,
  LUA_SCHEDULER_POLL,
} from "@/redis/index.js";
import { UserThrottle } from "@/rate-limiter/index.js";
import { executeSchedulerPoll } from "@/services/scheduler/main.js";
import { WorkflowWorker } from "@/services/workflow/main.js";

describe("Redis Pre-compiled Commands (defineCommand)", () => {
  describe("Registration & Initialization", () => {
    it("registers all custom commands with correct key counts and Lua bodies", () => {
      const definedCommands = new Map<string, { numberOfKeys: number; lua: string }>();
      const mockRedis: any = {
        defineCommand: vi.fn((name, def) => {
          definedCommands.set(name, def);
        }),
      };

      registerCustomCommands(mockRedis);

      expect(definedCommands.has("leaseApiRateLimit")).toBe(true);
      expect(definedCommands.get("leaseApiRateLimit")?.numberOfKeys).toBe(2);
      expect(definedCommands.get("leaseApiRateLimit")?.lua).toBe(LUA_LEASE_API_RATE_LIMIT);

      expect(definedCommands.has("releaseLock")).toBe(true);
      expect(definedCommands.get("releaseLock")?.numberOfKeys).toBe(1);
      expect(definedCommands.get("releaseLock")?.lua).toBe(LUA_RELEASE_LOCK);

      expect(definedCommands.has("renewLock")).toBe(true);
      expect(definedCommands.get("renewLock")?.numberOfKeys).toBe(1);
      expect(definedCommands.get("renewLock")?.lua).toBe(LUA_RENEW_LOCK);

      expect(definedCommands.has("throttleUser")).toBe(true);
      expect(definedCommands.get("throttleUser")?.numberOfKeys).toBe(1);
      expect(definedCommands.get("throttleUser")?.lua).toBe(LUA_USER_THROTTLE);

      expect(definedCommands.has("schedulerPoll")).toBe(true);
      expect(definedCommands.get("schedulerPoll")?.numberOfKeys).toBe(1);
      expect(definedCommands.get("schedulerPoll")?.lua).toBe(LUA_SCHEDULER_POLL);
    });

    it("RedisClient automatically registers all custom commands on native client", () => {
      const client = new RedisClient({
        url: "redis://localhost:6379",
        redisOptions: { lazyConnect: true },
      });
      try {
        expect(typeof client.native.leaseApiRateLimit).toBe("function");
        expect(typeof client.native.releaseLock).toBe("function");
        expect(typeof client.native.renewLock).toBe("function");
        expect(typeof client.native.throttleUser).toBe("function");
        expect(typeof client.native.schedulerPoll).toBe("function");
      } finally {
        void client.disconnect();
      }
    });
  });

  describe("UserThrottle", () => {
    it("uses pre-compiled throttleUser when available", async () => {
      const mockRedis: any = {
        throttleUser: vi.fn().mockResolvedValue(1),
        eval: vi.fn(),
      };
      const throttle = new UserThrottle({ redis: mockRedis, maxPerHour: 5 });
      const result = await throttle.check("proj_1", "user_1");

      expect(mockRedis.throttleUser).toHaveBeenCalled();
      expect(mockRedis.eval).not.toHaveBeenCalled();
      expect(result.allowed).toBe(true);
      expect(result.count).toBe(1);
    });

    it("returns allowed false when throttleUser reports limit exceeded", async () => {
      const mockRedis: any = {
        throttleUser: vi.fn().mockResolvedValue(6),
        eval: vi.fn(),
      };
      const throttle = new UserThrottle({ redis: mockRedis, maxPerHour: 5 });
      const result = await throttle.check("proj_1", "user_1");

      expect(mockRedis.throttleUser).toHaveBeenCalled();
      expect(result.allowed).toBe(false);
      expect(result.count).toBe(6);
    });
  });

  describe("executeSchedulerPoll (schedulerPoll & releaseLock)", () => {
    it("calls pre-compiled schedulerPoll on pipeline and releaseLock on redis", async () => {
      const pollPipeline = {
        schedulerPoll: vi.fn(),
        exec: vi.fn().mockResolvedValue(Array.from({ length: 16 }, () => [])),
      };
      const cleanupPipeline = { zrem: vi.fn(), exec: vi.fn().mockResolvedValue([]) };

      let pipelineCount = 0;
      const mockRedis: any = {
        set: vi.fn().mockResolvedValue("OK"),
        pipeline: vi.fn(() => (pipelineCount++ === 0 ? pollPipeline : cleanupPipeline)),
        releaseLock: vi.fn().mockResolvedValue(1),
        eval: vi.fn(),
      };
      const mockProducers = {
        critical: { publishBatch: vi.fn() },
        normal: { publishBatch: vi.fn() },
        low: { publishBatch: vi.fn() },
      };
      const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const mockDb: any = {};

      const polled = await executeSchedulerPoll(mockRedis, mockProducers, mockLogger, mockDb);

      expect(polled).toBe(false);
      expect(pollPipeline.schedulerPoll).toHaveBeenCalledTimes(16);
      expect(mockRedis.releaseLock).toHaveBeenCalledWith(
        "notif:lock:scheduler:poll",
        expect.any(String),
      );
      expect(mockRedis.eval).not.toHaveBeenCalled();
    });
  });

  describe("WorkflowWorker (releaseLock & renewLock)", () => {
    it("calls pre-compiled releaseLock when available", async () => {
      const { workflowRegistry } = await import("@/workflows/index.js");
      workflowRegistry.register("flow", async () => {});

      const mockRedis: any = {
        set: vi.fn().mockResolvedValue("OK"),
        releaseLock: vi.fn().mockResolvedValue(1),
        renewLock: vi.fn().mockResolvedValue(1),
        eval: vi.fn(),
        zadd: vi.fn().mockResolvedValue(1),
      };

      const qb: any = {};
      qb.select = vi.fn().mockReturnValue(qb);
      qb.from = vi.fn().mockReturnValue(qb);
      qb.where = vi.fn().mockReturnValue(qb);
      qb.limit = vi
        .fn()
        .mockResolvedValue([{ id: "inst-1", status: "pending", name: "flow", input: {} }]);
      qb.update = vi.fn().mockReturnValue(qb);
      qb.set = vi.fn().mockReturnValue(qb);
      qb.returning = vi.fn().mockReturnValue(qb);
      qb.then = function (resolve: any) {
        resolve([{ id: "inst-1", status: "pending", name: "flow", input: {} }]);
      };

      const worker = new WorkflowWorker({
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
        db: qb,
        workflowProducer: {
          publishBatch: vi.fn().mockResolvedValue({ messageIds: [], eventIds: [] }),
        },
        notificationProducer: {
          publishBatch: vi.fn().mockResolvedValue({ messageIds: [], eventIds: [] }),
        },
      });

      const msg = {
        id: "msg-1",
        stream: "workflow" as any,
        event: {
          id: "evt-1",
          type: "workflow.triggered",
          name: "workflow.triggered",
          payload: { instanceId: "inst-1", name: "flow", projectId: "proj-1" },
          metadata: { timestamp: new Date().toISOString() },
        },
      };

      await worker.process(msg as any);

      expect(mockRedis.releaseLock).toHaveBeenCalledWith(
        "lock:workflow:inst-1",
        expect.any(String),
      );
      expect(mockRedis.eval).not.toHaveBeenCalled();
    });
  });
});

describe("RedisClient.shared", () => {
  it("hands every service the same connection and closes it with the last one", async () => {
    const close = vi.spyOn(RedisClient.prototype, "disconnect").mockResolvedValue(undefined);
    const opts = { url: "redis://shared-test:6379", redisOptions: { lazyConnect: true } };

    const a = RedisClient.shared(opts);
    const b = RedisClient.shared(opts);
    expect(a.native).toBe(b.native);

    await a.disconnect();
    await a.disconnect(); // a second release by the same service is a no-op
    expect(close).not.toHaveBeenCalled();

    await b.disconnect();
    expect(close).toHaveBeenCalledTimes(1);

    // A service starting after that gets a fresh connection.
    const c = RedisClient.shared(opts);
    expect(c.native).not.toBe(a.native);
    await c.disconnect();
    close.mockRestore();
    c.native.disconnect();
    a.native.disconnect();
  });
});
