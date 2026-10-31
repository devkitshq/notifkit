import type { IncomingMessage, ServerResponse } from "node:http";
import { STREAMS, CONSUMER_GROUPS } from "@/contracts/index.js";
import { readJsonBody, sendJson } from "../http.js";
import type { RouteContext } from "../router.js";
import { getPriorityBucket } from "@/shared/index.js";
import { eq, and, sql } from "drizzle-orm";
import { messageLogs } from "@/db/schema.js";
import { type Deps, type DlqEntry, parseDlqEntry } from "./shared.js";

export function createSystemHandlers(deps: Deps) {
  const { logger } = deps;

  async function getSystemHealth(
    _req: IncomingMessage,
    res: ServerResponse,
    _ctx: RouteContext,
  ): Promise<void> {
    const keys = ["enricher", "engine", "scheduler", "delivery", "ai", "workflow", "events"];
    const workers: Record<string, any> = {};
    let redisOk = false;
    let dbOk = false;
    let redisLatency = 0;
    let dbLatency = 0;

    const startRedis = Date.now();
    try {
      await deps.redis.native.ping();
      redisOk = true;
      redisLatency = Date.now() - startRedis;
    } catch {
      redisOk = false;
    }

    const startDb = Date.now();
    try {
      await deps.db.execute(sql`SELECT 1`);
      dbOk = true;
      dbLatency = Date.now() - startDb;
    } catch {
      dbOk = false;
    }

    if (redisOk) {
      try {
        const vals = await deps.redis.native.mget(keys.map((k) => `notif:health:${k}`));
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i] as string;
          const val = vals[i];
          if (val) {
            workers[key] = JSON.parse(val);
          } else {
            workers[key] = { status: "unknown", message: "No heartbeat" };
          }
        }
      } catch (err: any) {
        for (const key of keys) {
          workers[key] = { status: "error", error: err.message };
        }
      }
    }

    sendJson(res, 200, {
      status: redisOk && dbOk ? "healthy" : "degraded",
      redis: { ok: redisOk, latencyMs: redisLatency },
      db: { ok: dbOk, latencyMs: dbLatency },
      workers,
    });
  }

  // Helper to resolve true unconsumed backlog (consumer group lag + pending entries)
  async function getStreamBacklog(
    redis: any,
    streamKey: string,
    targetGroup?: string,
  ): Promise<number> {
    if (!targetGroup) {
      return await redis.xlen(streamKey);
    }

    if (typeof redis.xinfo === "function") {
      try {
        const groups = await redis.xinfo("GROUPS", streamKey);
        if (Array.isArray(groups) && groups.length > 0) {
          for (const item of groups) {
            const groupData: Record<string, any> = {};
            if (Array.isArray(item)) {
              for (let i = 0; i < item.length; i += 2) {
                groupData[String(item[i])] = item[i + 1];
              }
            } else if (item && typeof item === "object") {
              Object.assign(groupData, item);
            }

            if (groupData.name === targetGroup) {
              const pending = typeof groupData.pending === "number" ? groupData.pending : 0;
              if (typeof groupData.lag === "number") {
                return groupData.lag + pending;
              }
              if (groupData["last-delivered-id"] === "0-0") {
                const totalLen = await redis.xlen(streamKey);
                return totalLen + pending;
              }
              return pending;
            }
          }
        }
      } catch {
        // Group or stream may not exist yet, fallback to xlen
      }
    }

    return await redis.xlen(streamKey);
  }

  async function getSystemMetrics(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const streamMap: Record<string, { key: string; group?: string }> = {
      INBOUND_CRITICAL: { key: STREAMS.INBOUND_CRITICAL, group: CONSUMER_GROUPS.ENRICHER },
      INBOUND_NORMAL: { key: STREAMS.INBOUND_NORMAL, group: CONSUMER_GROUPS.ENRICHER },
      INBOUND_LOW: { key: STREAMS.INBOUND_LOW, group: CONSUMER_GROUPS.ENRICHER },
      ENRICHED_NORMAL: { key: STREAMS.ENRICHED_NORMAL, group: CONSUMER_GROUPS.ENGINE },
      OUTBOUND_CRITICAL: { key: STREAMS.OUTBOUND_CRITICAL, group: CONSUMER_GROUPS.DELIVERY },
      OUTBOUND_NORMAL: { key: STREAMS.OUTBOUND_NORMAL, group: CONSUMER_GROUPS.DELIVERY },
      OUTBOUND_LOW: { key: STREAMS.OUTBOUND_LOW, group: CONSUMER_GROUPS.DELIVERY },
      WORKFLOW_INBOUND: { key: STREAMS.WORKFLOW_INBOUND, group: CONSUMER_GROUPS.WORKFLOW },
      EVENTS_INBOUND: { key: STREAMS.EVENTS_INBOUND, group: CONSUMER_GROUPS.EVENTS },
      DEAD_LETTER: { key: STREAMS.DEAD_LETTER },
    };

    const streamDepths: Record<string, number> = {};
    if (ctx.isAdmin !== false) {
      for (const [key, { key: realRedisKey, group }] of Object.entries(streamMap)) {
        try {
          const depth = await getStreamBacklog(deps.redis.native, realRedisKey, group);
          streamDepths[key] = depth;
        } catch {
          streamDepths[key] = 0;
        }
      }
    }

    // Scoped to the caller's project if provided, otherwise aggregate across all projects
    let total = 0;
    let delivered = 0;

    if (ctx.projectId) {
      const totalTasksRes = await deps.db
        .select({ count: sql<number>`count(distinct ${messageLogs.taskId})` })
        .from(messageLogs)
        .where(eq(messageLogs.projectId, ctx.projectId));
      const deliveredTasksRes = await deps.db
        .select({ count: sql<number>`count(distinct ${messageLogs.taskId})` })
        .from(messageLogs)
        .where(and(eq(messageLogs.projectId, ctx.projectId), eq(messageLogs.status, "delivered")));

      total = Number(totalTasksRes[0]?.count ?? 0);
      delivered = Number(deliveredTasksRes[0]?.count ?? 0);
    } else {
      const totalTasksRes = await deps.db
        .select({ count: sql<number>`count(distinct ${messageLogs.taskId})` })
        .from(messageLogs);
      const deliveredTasksRes = await deps.db
        .select({ count: sql<number>`count(distinct ${messageLogs.taskId})` })
        .from(messageLogs)
        .where(eq(messageLogs.status, "delivered"));

      total = Number(totalTasksRes[0]?.count ?? 0);
      delivered = Number(deliveredTasksRes[0]?.count ?? 0);
    }

    // Project-scoped calls compute failure against their own task count;
    // cluster-wide administrative calls read the global dead letter queue length.
    const failed = ctx.projectId ? Math.max(0, total - delivered) : streamDepths.DEAD_LETTER || 0;
    const successRate = total > 0 ? Number(((delivered / total) * 100).toFixed(2)) : 100;

    sendJson(res, 200, {
      streams: streamDepths,
      deliveryStats: {
        total,
        delivered,
        failed,
        successRate,
      },
    });
  }

  async function getDLQMessages(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    try {
      const rawEntries = await deps.redis.native.xrevrange(
        STREAMS.DEAD_LETTER,
        "+",
        "-",
        "COUNT",
        "100",
      );
      const allMessages = (rawEntries || []).map(([id, fields]: [string, string[]]) =>
        parseDlqEntry(id, fields),
      );

      const messages = ctx.projectId
        ? allMessages.filter((m) => m.projectId === ctx.projectId)
        : allMessages;

      sendJson(res, 200, {
        messages: messages.slice(0, 50).map((m) => ({
          id: m.id,
          eventType: m.eventType,
          payload: m.payload,
          error: m.error,
          timestamp: m.timestamp,
          originalStream: m.originalStream,
        })),
      });
    } catch {
      sendJson(res, 200, { messages: [] });
    }
  }

  /** The entry, or null when it does not exist or belongs to another project. */
  async function findDlqEntry(ctx: RouteContext, messageId: string): Promise<DlqEntry | null> {
    // Redis rejects a malformed stream id rather than matching nothing.
    if (!/^\d+-\d+$/.test(messageId)) return null;
    const rawEntries = await deps.redis.native.xrange(STREAMS.DEAD_LETTER, messageId, messageId);
    if (!rawEntries || rawEntries.length === 0 || !rawEntries[0]) return null;
    const entry = parseDlqEntry(rawEntries[0][0], rawEntries[0][1]);
    if (ctx.projectId && entry.projectId !== ctx.projectId) return null;
    return entry;
  }

  async function replayDLQMessage(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const body = (await readJsonBody(req)) as any;
    const messageId = body?.id;

    if (!messageId) {
      sendJson(res, 400, { error: "missing_message_id" });
      return;
    }

    try {
      const entry = await findDlqEntry(ctx, messageId);
      if (!entry) {
        sendJson(res, 404, { error: "dlq_message_not_found" });
        return;
      }

      // Back onto the stream it failed on: a failed send belongs with delivery,
      // not at the start of the pipeline, where its payload does not parse.
      const replayable = new Set<string>(Object.values(STREAMS));
      replayable.delete(STREAMS.DEAD_LETTER);
      const inbound =
        STREAMS[
          `INBOUND_${getPriorityBucket(entry.payload?.priority ?? entry.fields.priority).toUpperCase()}` as keyof typeof STREAMS
        ] ?? STREAMS.INBOUND_NORMAL;
      const targetStream =
        entry.originalStream && replayable.has(entry.originalStream)
          ? entry.originalStream
          : inbound;

      const xaddArgs: string[] = [];
      if (entry.event) {
        xaddArgs.push("data", JSON.stringify(entry.event));
      } else {
        for (const [k, v] of Object.entries(entry.fields)) xaddArgs.push(k, v);
      }
      await deps.redis.native.xadd(targetStream, "*", ...xaddArgs);
      await deps.redis.native.xdel(STREAMS.DEAD_LETTER, messageId);

      sendJson(res, 200, { success: true, replayedId: messageId, stream: targetStream });
    } catch (err) {
      logger.error({ err, messageId }, "DLQ replay failed");
      sendJson(res, 500, { error: "replay_failed" });
    }
  }

  async function deleteDLQMessage(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const messageId = ctx.params.id;
    if (!messageId) return sendJson(res, 400, { error: "missing_id" });

    try {
      if (!(await findDlqEntry(ctx, messageId))) {
        sendJson(res, 404, { error: "dlq_message_not_found" });
        return;
      }
      await deps.redis.native.xdel(STREAMS.DEAD_LETTER, messageId);
      sendJson(res, 200, { success: true });
    } catch (err) {
      logger.error({ err, messageId }, "DLQ delete failed");
      sendJson(res, 500, { error: "delete_failed" });
    }
  }

  return {
    getSystemHealth,
    getSystemMetrics,
    getDLQMessages,
    replayDLQMessage,
    deleteDLQMessage,
  };
}
