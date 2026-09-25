import { describe, it, expect, vi } from "vitest";
import {
  registerCustomCommands,
  RedisClient,
  LUA_CHECK_API_RATE_LIMIT,
  LUA_THROTTLE_PROVIDER,
  LUA_RELEASE_LOCK,
  LUA_RENEW_LOCK,
  LUA_USER_THROTTLE,
  LUA_SCHEDULER_POLL,
} from "@/redis/index.js";
import { throttleProvider } from "@/services/delivery/throttle.js";
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

      expect(definedCommands.has("checkApiRateLimit")).toBe(true);
      expect(definedCommands.get("checkApiRateLimit")?.numberOfKeys).toBe(2);
      expect(definedCommands.get("checkApiRateLimit")?.lua).toBe(LUA_CHECK_API_RATE_LIMIT);

      expect(definedCommands.has("checkApiRateLimit1Key")).toBe(true);
      expect(definedCommands.get("checkApiRateLimit1Key")?.numberOfKeys).toBe(1);
      expect(definedCommands.get("checkApiRateLimit1Key")?.lua).toBe(LUA_CHECK_API_RATE_LIMIT);

      expect(definedCommands.has("throttleProvider")).toBe(true);
      expect(definedCommands.get("throttleProvider")?.numberOfKeys).toBe(1);
      expect(definedCommands.get("throttleProvider")?.lua).toBe(LUA_THROTTLE_PROVIDER);

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
        expect(typeof client.native.checkApiRateLimit).toBe("function");
        expect(typeof client.native.checkApiRateLimit1Key).toBe("function");
        expect(typeof client.native.throttleProvider).toBe("function");
        expect(typeof client.native.releaseLock).toBe("function");
        expect(typeof client.native.renewLock).toBe("function");
        expect(typeof client.native.throttleUser).toBe("function");
        expect(typeof client.native.schedulerPoll).toBe("function");
      } finally {
        void client.disconnect();
      }
    });

    it("validates Lua scripts contain required Redis commands", () => {
      expect(LUA_CHECK_API_RATE_LIMIT).toContain('redis.call("INCR"');
      expect(LUA_CHECK_API_RATE_LIMIT).toContain('redis.call("EXPIRE"');
      expect(LUA_CHECK_API_RATE_LIMIT).toContain("math.floor(prevCount * weight + currentCount)");

      expect(LUA_THROTTLE_PROVIDER).toContain("redis.call('ZREMRANGEBYSCORE'");
      expect(LUA_THROTTLE_PROVIDER).toContain("redis.call('ZCARD'");
      expect(LUA_THROTTLE_PROVIDER).toContain("redis.call('ZADD'");

      expect(LUA_USER_THROTTLE).toContain('redis.call("ZREMRANGEBYSCORE"');
      expect(LUA_USER_THROTTLE).toContain('redis.call("ZCARD"');
      expect(LUA_USER_THROTTLE).toContain('redis.call("ZADD"');

      expect(LUA_RELEASE_LOCK).toContain("redis.call('GET'");
      expect(LUA_RELEASE_LOCK).toContain("redis.call('DEL'");

      expect(LUA_RENEW_LOCK).toContain("redis.call('GET'");
      expect(LUA_RENEW_LOCK).toContain("redis.call('EXPIRE'");

      expect(LUA_SCHEDULER_POLL).toContain("redis.call('ZRANGE'");
      expect(LUA_SCHEDULER_POLL).toContain("redis.call('ZADD'");
    });
  });

  describe("throttleProvider", () => {
    it("uses pre-compiled command when available on Redis", async () => {
      const mockRedis: any = {
        throttleProvider: vi.fn().mockResolvedValue([1, 0]),
        eval: vi.fn(),
      };
      const mockLogger = { warn: vi.fn(), info: vi.fn() };

      const result = await throttleProvider(
        mockRedis,
        "email",
        { limit: 10, windowSeconds: 60 },
        mockLogger,
      );

      expect(mockRedis.throttleProvider).toHaveBeenCalled();
      expect(mockRedis.eval).not.toHaveBeenCalled();
      expect(result.allowed).toBe(true);
    });

    it("calculates retryAfterMs when pre-compiled command returns throttled", async () => {
      const now = Date.now();
      const mockRedis: any = {
        throttleProvider: vi.fn().mockResolvedValue([0, now - 500]),
        eval: vi.fn(),
      };
      const mockLogger = { warn: vi.fn(), info: vi.fn() };

      const result = await throttleProvider(
        mockRedis,
        "sms",
        { limit: 5, windowSeconds: 10 },
        mockLogger,
      );

      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(9000);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it("falls back to redis.eval when pre-compiled command is absent", async () => {
      const mockRedis: any = {
        eval: vi.fn().mockResolvedValue([1, 0]),
      };
      const mockLogger = { warn: vi.fn(), info: vi.fn() };

      const result = await throttleProvider(
        mockRedis,
        "email",
        { limit: 10, windowSeconds: 60 },
        mockLogger,
      );

      expect(mockRedis.eval).toHaveBeenCalled();
      expect(result.allowed).toBe(true);
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

    it("falls back to redis.eval when throttleUser is absent", async () => {
      const mockRedis: any = {
        eval: vi.fn().mockResolvedValue(1),
      };
      const throttle = new UserThrottle({ redis: mockRedis, maxPerHour: 5 });
      const result = await throttle.check("proj_1", "user_1");

      expect(mockRedis.eval).toHaveBeenCalled();
      expect(result.allowed).toBe(true);
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

    it("falls back to pipeline.eval and redis.eval when pre-compiled methods are absent", async () => {
      const pollPipeline = {
        eval: vi.fn(),
        exec: vi.fn().mockResolvedValue(Array.from({ length: 16 }, () => [null, []])),
      };
      const cleanupPipeline = { zrem: vi.fn(), exec: vi.fn().mockResolvedValue([]) };

      let pipelineCount = 0;
      const mockRedis: any = {
        set: vi.fn().mockResolvedValue("OK"),
        pipeline: vi.fn(() => (pipelineCount++ === 0 ? pollPipeline : cleanupPipeline)),
        eval: vi.fn().mockResolvedValue(1),
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
      expect(pollPipeline.eval).toHaveBeenCalledTimes(16);
      expect(mockRedis.eval).toHaveBeenCalled();
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

    it("falls back to eval for releaseLock when releaseLock is absent", async () => {
      const { workflowRegistry } = await import("@/workflows/index.js");
      workflowRegistry.register("flow2", async () => {});

      const mockRedis: any = {
        set: vi.fn().mockResolvedValue("OK"),
        eval: vi.fn().mockResolvedValue(1),
        zadd: vi.fn().mockResolvedValue(1),
      };

      const qb: any = {};
      qb.select = vi.fn().mockReturnValue(qb);
      qb.from = vi.fn().mockReturnValue(qb);
      qb.where = vi.fn().mockReturnValue(qb);
      qb.limit = vi
        .fn()
        .mockResolvedValue([{ id: "inst-2", status: "pending", name: "flow2", input: {} }]);
      qb.update = vi.fn().mockReturnValue(qb);
      qb.set = vi.fn().mockReturnValue(qb);
      qb.then = function (resolve: any) {
        resolve([{ id: "inst-2", status: "pending", name: "flow2", input: {} }]);
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
        id: "msg-2",
        stream: "workflow" as any,
        event: {
          id: "evt-2",
          type: "workflow.triggered",
          name: "workflow.triggered",
          payload: { instanceId: "inst-2", name: "flow2", projectId: "proj-1" },
          metadata: { timestamp: new Date().toISOString() },
        },
      };

      await worker.process(msg as any);

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('GET'"),
        1,
        "lock:workflow:inst-2",
        expect.any(String),
      );
    });
  });
});
