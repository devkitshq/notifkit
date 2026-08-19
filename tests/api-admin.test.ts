import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHandlers } from "@/services/api/handlers.js";
import { globalEmitter } from "@/shared/index.js";
import { STREAMS } from "@/contracts/index.js";

/**
 * Covers the operational surface of the API — system health, metrics, DLQ
 * inspection/replay, workflow definitions and the SSE delivery stream. These
 * handlers reach for `db` query chains and raw redis commands, so the doubles
 * here are richer than the ones in api.test.ts.
 */

/** A drizzle-ish chain where every builder method returns itself and awaiting resolves `rows`. */
function queryChain(rows: any) {
  const chain: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject);
        }
        return () => chain;
      },
    },
  );
  return chain;
}

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    written: [] as string[],
    setHeader: vi.fn((k: string, v: string) => {
      res.headers[k] = v;
    }),
    writeHead: vi.fn((code: number, headers?: any) => {
      res.statusCode = code;
      Object.assign(res.headers, headers || {});
      return res;
    }),
    write: vi.fn((chunk: string) => {
      res.written.push(chunk);
      return true;
    }),
    end: vi.fn((data?: string) => {
      if (data) res.body = data;
    }),
  } as any;
  return res;
}

function createMockReq(body?: any) {
  return {
    on: vi.fn((event: string, cb: any) => {
      if (event === "data" && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
      if (event === "end") cb();
    }),
    headers: {},
  } as any;
}

const ctx = (over: any = {}) =>
  ({
    projectId: "proj_1",
    params: {},
    query: new URLSearchParams(),
    ...over,
  }) as any;

const parse = (res: any) => JSON.parse(res.body);

describe("API operational handlers", () => {
  let deps: any;
  let handlers: ReturnType<typeof createHandlers>;
  /** Rows handed to successive `db.select()` calls, in order. */
  let selectRows: any[];

  beforeEach(() => {
    selectRows = [];
    deps = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      producers: { normal: { publish: vi.fn(), publishBatch: vi.fn() } },
      userRepo: { findRecordById: vi.fn().mockResolvedValue({ id: "usr_1", language: "en" }) },
      contactRepo: { findByUserId: vi.fn().mockResolvedValue([{ channel: "email" }]) },
      templateRepo: {},
      projectRepo: {},
      workflowRepo: { cancelInstance: vi.fn().mockResolvedValue(true) },
      segmentRepo: {},
      db: {
        select: vi.fn(() => queryChain(selectRows.length ? selectRows.shift() : [])),
        insert: vi.fn(() => ({
          values: () => ({ onConflictDoUpdate: () => Promise.resolve() }),
        })),
        execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
        transaction: vi.fn(async (cb: any) => cb({})),
      },
      redis: {
        native: {
          ping: vi.fn().mockResolvedValue("PONG"),
          mget: vi.fn().mockResolvedValue([]),
          xlen: vi.fn().mockResolvedValue(3),
          xrevrange: vi.fn().mockResolvedValue([]),
          xrange: vi.fn().mockResolvedValue([]),
          xadd: vi.fn().mockResolvedValue("1-0"),
          xdel: vi.fn().mockResolvedValue(1),
          publish: vi.fn(),
        },
      },
    };
    handlers = createHandlers(deps);
  });

  describe("getSystemHealth", () => {
    it("reports healthy when redis and db both answer", async () => {
      const res = createMockRes();
      await handlers.getSystemHealth(createMockReq(), res, ctx());

      const body = parse(res);
      expect(body.status).toBe("healthy");
      expect(body.redis.ok).toBe(true);
      expect(body.db.ok).toBe(true);
    });

    it("degrades when redis is unreachable and skips the heartbeat read", async () => {
      deps.redis.native.ping.mockRejectedValue(new Error("ECONNREFUSED"));
      const res = createMockRes();
      await handlers.getSystemHealth(createMockReq(), res, ctx());

      const body = parse(res);
      expect(body.status).toBe("degraded");
      expect(body.redis.ok).toBe(false);
      expect(deps.redis.native.mget).not.toHaveBeenCalled();
    });

    it("degrades when the database query throws", async () => {
      deps.db.execute.mockRejectedValue(new Error("db down"));
      const res = createMockRes();
      await handlers.getSystemHealth(createMockReq(), res, ctx());

      expect(parse(res).status).toBe("degraded");
      expect(parse(res).db.ok).toBe(false);
    });

    it("parses worker heartbeats and marks silent workers unknown", async () => {
      deps.redis.native.mget.mockResolvedValue([
        JSON.stringify({ status: "ok", pid: 1 }),
        null,
        null,
        null,
        null,
        null,
        null,
      ]);
      const res = createMockRes();
      await handlers.getSystemHealth(createMockReq(), res, ctx());

      const { workers } = parse(res);
      expect(workers.enricher).toEqual({ status: "ok", pid: 1 });
      expect(workers.engine).toEqual({ status: "unknown", message: "No heartbeat" });
    });

    it("marks every worker errored when the heartbeat read fails", async () => {
      deps.redis.native.mget.mockRejectedValue(new Error("mget exploded"));
      const res = createMockRes();
      await handlers.getSystemHealth(createMockReq(), res, ctx());

      const { workers } = parse(res);
      expect(workers.enricher).toEqual({ status: "error", error: "mget exploded" });
      expect(workers.events).toEqual({ status: "error", error: "mget exploded" });
    });
  });

  describe("getSystemMetrics", () => {
    it("returns stream depths and a computed success rate", async () => {
      selectRows = [[{ count: 10 }], [{ count: 5 }]];
      const res = createMockRes();
      await handlers.getSystemMetrics(createMockReq(), res, ctx());

      const body = parse(res);
      expect(body.streams.INBOUND_NORMAL).toBe(3);
      expect(body.deliveryStats).toMatchObject({ total: 10, delivered: 5, successRate: 50 });
    });

    it("treats an unreadable stream as depth zero", async () => {
      deps.redis.native.xlen.mockRejectedValue(new Error("no such key"));
      selectRows = [[{ count: 0 }], [{ count: 0 }]];
      const res = createMockRes();
      await handlers.getSystemMetrics(createMockReq(), res, ctx());

      expect(parse(res).streams.INBOUND_NORMAL).toBe(0);
    });

    it("reports 100% success when nothing has been sent", async () => {
      selectRows = [[], []];
      const res = createMockRes();
      await handlers.getSystemMetrics(createMockReq(), res, ctx());

      expect(parse(res).deliveryStats).toMatchObject({ total: 0, successRate: 100 });
    });
  });

  describe("DLQ", () => {
    it("maps raw stream entries into messages", async () => {
      deps.redis.native.xrevrange.mockResolvedValue([
        [
          "1-0",
          [
            "eventType",
            "notification.requested",
            "payload",
            JSON.stringify({ a: 1 }),
            "error",
            "boom",
            "timestamp",
            "2026-01-01T00:00:00.000Z",
          ],
        ],
      ]);
      const res = createMockRes();
      await handlers.getDLQMessages(createMockReq(), res, ctx());

      expect(parse(res).messages[0]).toEqual({
        id: "1-0",
        eventType: "notification.requested",
        payload: { a: 1 },
        error: "boom",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
    });

    it("falls back across the alternate field names", async () => {
      deps.redis.native.xrevrange.mockResolvedValue([
        ["2-0", ["event_type", "legacy.event", "reason", "legacy reason"]],
      ]);
      const res = createMockRes();
      await handlers.getDLQMessages(createMockReq(), res, ctx());

      const msg = parse(res).messages[0];
      expect(msg.eventType).toBe("legacy.event");
      expect(msg.error).toBe("legacy reason");
      // With no `payload` field the whole field map stands in for it.
      expect(msg.payload).toMatchObject({ event_type: "legacy.event" });
    });

    it("returns an empty list when the stream read fails", async () => {
      deps.redis.native.xrevrange.mockRejectedValue(new Error("no stream"));
      const res = createMockRes();
      await handlers.getDLQMessages(createMockReq(), res, ctx());

      expect(parse(res).messages).toEqual([]);
    });

    it("replay rejects a request with no id", async () => {
      const res = createMockRes();
      await handlers.replayDLQMessage(createMockReq({}), res, ctx());

      expect(res.statusCode).toBe(400);
      expect(parse(res).error).toBe("missing_message_id");
    });

    it("replay 404s when the entry is gone", async () => {
      deps.redis.native.xrange.mockResolvedValue([]);
      const res = createMockRes();
      await handlers.replayDLQMessage(createMockReq({ id: "1-0" }), res, ctx());

      expect(res.statusCode).toBe(404);
      expect(parse(res).error).toBe("dlq_message_not_found");
    });

    it("replay re-publishes onto the priority stream and drops the DLQ entry", async () => {
      deps.redis.native.xrange.mockResolvedValue([
        ["1-0", ["priority", "critical", "payload", "{}"]],
      ]);
      const res = createMockRes();
      await handlers.replayDLQMessage(createMockReq({ id: "1-0" }), res, ctx());

      expect(res.statusCode).toBe(200);
      expect(parse(res)).toEqual({ success: true, replayedId: "1-0" });
      expect(deps.redis.native.xadd).toHaveBeenCalledWith(
        STREAMS.INBOUND_CRITICAL,
        "*",
        "priority",
        "critical",
        "payload",
        "{}",
      );
      expect(deps.redis.native.xdel).toHaveBeenCalledWith(STREAMS.DEAD_LETTER, "1-0");
    });

    it("replay defaults to the normal stream when no priority is recorded", async () => {
      deps.redis.native.xrange.mockResolvedValue([["1-0", ["payload", "{}"]]]);
      const res = createMockRes();
      await handlers.replayDLQMessage(createMockReq({ id: "1-0" }), res, ctx());

      expect(deps.redis.native.xadd).toHaveBeenCalledWith(
        STREAMS.INBOUND_NORMAL,
        "*",
        "payload",
        "{}",
      );
    });

    it("replay surfaces a redis failure as a 500", async () => {
      deps.redis.native.xrange.mockRejectedValue(new Error("redis gone"));
      const res = createMockRes();
      await handlers.replayDLQMessage(createMockReq({ id: "1-0" }), res, ctx());

      expect(res.statusCode).toBe(500);
      expect(parse(res)).toMatchObject({ error: "replay_failed", message: "redis gone" });
    });

    it("delete removes the entry", async () => {
      const res = createMockRes();
      await handlers.deleteDLQMessage(createMockReq(), res, ctx({ params: { id: "1-0" } }));

      expect(parse(res)).toEqual({ success: true });
      expect(deps.redis.native.xdel).toHaveBeenCalledWith(STREAMS.DEAD_LETTER, "1-0");
    });

    it("delete rejects a missing id", async () => {
      const res = createMockRes();
      await handlers.deleteDLQMessage(createMockReq(), res, ctx({ params: {} }));

      expect(res.statusCode).toBe(400);
      expect(parse(res).error).toBe("missing_id");
    });

    it("delete surfaces a redis failure as a 500", async () => {
      deps.redis.native.xdel.mockRejectedValue(new Error("redis gone"));
      const res = createMockRes();
      await handlers.deleteDLQMessage(createMockReq(), res, ctx({ params: { id: "1-0" } }));

      expect(res.statusCode).toBe(500);
      expect(parse(res)).toMatchObject({ error: "delete_failed" });
    });
  });

  describe("workflow definitions", () => {
    it("createWorkflow upserts the definition and returns 201", async () => {
      const res = createMockRes();
      await handlers.createWorkflow(
        createMockReq({ name: "onboarding", steps: [{ action: "wait", duration: "1h" }] }),
        res,
        ctx(),
      );

      expect(res.statusCode).toBe(201);
      expect(parse(res)).toEqual({ name: "onboarding" });
    });

    it("createWorkflow rejects an invalid definition", async () => {
      const res = createMockRes();
      await handlers.createWorkflow(createMockReq({ steps: [] }), res, ctx());

      expect(res.statusCode).toBe(400);
      expect(parse(res).error).toBe("validation_error");
    });

    it("createWorkflow reports a write failure as a 500", async () => {
      deps.db.insert = vi.fn(() => ({
        values: () => ({ onConflictDoUpdate: () => Promise.reject(new Error("constraint")) }),
      }));
      const res = createMockRes();
      await handlers.createWorkflow(
        createMockReq({ name: "onboarding", steps: [{ action: "wait", duration: "1h" }] }),
        res,
        ctx(),
      );

      expect(res.statusCode).toBe(500);
      expect(parse(res)).toMatchObject({ error: "internal_error", message: "constraint" });
      expect(deps.logger.error).toHaveBeenCalled();
    });

    it("cancelWorkflow returns 204 once the instance is canceled", async () => {
      const res = createMockRes();
      await handlers.cancelWorkflow(createMockReq(), res, ctx({ params: { id: "wf_1" } }));

      expect(res.statusCode).toBe(204);
      expect(deps.workflowRepo.cancelInstance).toHaveBeenCalledWith("proj_1", "wf_1");
    });

    it("cancelWorkflow 400s when the instance cannot be canceled", async () => {
      deps.workflowRepo.cancelInstance.mockResolvedValue(false);
      const res = createMockRes();
      await handlers.cancelWorkflow(createMockReq(), res, ctx({ params: { id: "wf_1" } }));

      expect(res.statusCode).toBe(400);
      expect(parse(res)).toMatchObject({ error: "workflow_not_cancelable", id: "wf_1" });
    });
  });

  describe("getScheduledMessages", () => {
    it("returns the project's scheduled payloads", async () => {
      selectRows = [[{ id: "sched_1" }]];
      const res = createMockRes();
      await handlers.getScheduledMessages(createMockReq(), res, ctx());

      expect(parse(res)).toEqual({ scheduled: [{ id: "sched_1" }], nextCursor: null });
    });
  });

  describe("getUserDetails", () => {
    it("merges the profile with its contacts and recent logs", async () => {
      selectRows = [[{ taskId: "t1" }]];
      const res = createMockRes();
      await handlers.getUserDetails(createMockReq(), res, ctx({ params: { id: "usr_1" } }));

      expect(parse(res)).toMatchObject({
        id: "usr_1",
        contacts: [{ channel: "email" }],
        logs: [{ taskId: "t1" }],
      });
    });

    it("404s for an unknown user", async () => {
      deps.userRepo.findRecordById.mockResolvedValue(null);
      const res = createMockRes();
      await handlers.getUserDetails(createMockReq(), res, ctx({ params: { id: "nope" } }));

      expect(res.statusCode).toBe(404);
      expect(parse(res)).toMatchObject({ error: "user_not_found", id: "nope" });
    });
  });

  describe("getEventsStream", () => {
    it("opens an SSE stream and forwards delivery events for the project", async () => {
      const req = createMockReq();
      const res = createMockRes();
      await handlers.getEventsStream(req, res, ctx());

      expect(res.headers["Content-Type"]).toBe("text/event-stream");
      expect(res.written[0]).toBe("retry: 10000\n\n");

      globalEmitter.emit("delivery:delivered", "task-1", "prov-1", "email", "proj_1");
      globalEmitter.emit("delivery:failed", "task-2", "boom", "sms", "proj_1");

      const stream = res.written.join("");
      expect(stream).toContain("event: delivery:delivered");
      expect(stream).toContain('"taskId":"task-1"');
      expect(stream).toContain("event: delivery:failed");
      expect(stream).toContain('"error":"boom"');

      // Detach so the listeners do not leak into the next test.
      const close = req.on.mock.calls.find((c: any[]) => c[0] === "close")![1];
      close();
    });

    it("ignores events belonging to another project", async () => {
      const req = createMockReq();
      const res = createMockRes();
      await handlers.getEventsStream(req, res, ctx());
      const before = res.written.length;

      globalEmitter.emit("delivery:delivered", "task-1", "prov-1", "email", "other_project");
      globalEmitter.emit("delivery:failed", "task-2", "boom", "sms", "other_project");

      expect(res.written.length).toBe(before);

      const close = req.on.mock.calls.find((c: any[]) => c[0] === "close")![1];
      close();
    });

    it("unsubscribes when the client disconnects", async () => {
      const req = createMockReq();
      const res = createMockRes();
      await handlers.getEventsStream(req, res, ctx());

      const close = req.on.mock.calls.find((c: any[]) => c[0] === "close")![1];
      close();

      const before = res.written.length;
      globalEmitter.emit("delivery:delivered", "task-1", "prov-1", "email", "proj_1");
      expect(res.written.length).toBe(before);
    });
  });
});
