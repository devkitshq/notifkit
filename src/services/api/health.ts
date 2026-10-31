import type { IncomingMessage, ServerResponse } from "node:http";
import type { RedisClient } from "@/redis/index.js";
import { getAdminSession } from "@/services/auth/index.js";
import { getMetricsRegistry } from "@/metrics/index.js";
import { sendJson, extractAuthToken } from "./http.js";

export interface HealthDeps {
  redis: RedisClient;
  sql: any;
  isAdminApiKey: (token: string) => boolean;
}

/** GET /health, /metrics, /live and /ready. */
export function createHealthHandlers({ redis, sql, isAdminApiKey }: HealthDeps) {
  let cachedHealth: { response: any; statusCode: number; expiresAt: number } | null = null;

  async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (cachedHealth && cachedHealth.expiresAt > Date.now()) {
      sendJson(res, cachedHealth.statusCode, cachedHealth.response);
      return;
    }

    const [redisOk, dbOk] = await Promise.all([redis.healthCheck(), dbHealthCheck()]);

    const workers: Record<string, any> = {};
    let overallOk = redisOk && dbOk;

    if (redisOk) {
      const keys = ["enricher", "engine", "scheduler", "delivery", "ai", "workflow", "events"];
      try {
        const vals = await redis.native.mget(keys.map((k) => `notif:health:${k}`));
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i] as string;
          const val = vals[i];
          if (val) {
            const parsed = JSON.parse(val);
            workers[key] = parsed;
            if (parsed.redis === false || parsed.state === "error") {
              overallOk = false;
            }
          } else {
            workers[key] = { status: "unknown", message: "No report received from worker" };
          }
        }
      } catch (err) {
        for (const key of keys) {
          workers[key] = {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }

    const statusCode = overallOk ? 200 : 503;
    const response = {
      service: "api",
      status: overallOk ? "ok" : "degraded",
      redis: redisOk,
      database: dbOk,
      workers,
    };

    cachedHealth = {
      response,
      statusCode,
      expiresAt: Date.now() + 1000,
    };

    sendJson(res, statusCode, response);
  }

  async function handleMetrics(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const remoteIp = req.socket.remoteAddress ?? "";
    const isLoopback =
      remoteIp === "127.0.0.1" ||
      remoteIp === "::1" ||
      remoteIp === "::ffff:127.0.0.1" ||
      remoteIp === "localhost";

    let authorized = isLoopback;
    if (!authorized) {
      const token = extractAuthToken(req);
      if (token) {
        if (token.startsWith("nk_sess_") && redis?.native) {
          const session = await getAdminSession(redis.native, token);
          if (session) authorized = true;
        } else if (isAdminApiKey(token)) {
          authorized = true;
        }
      }
    }

    if (!authorized) {
      sendJson(res, 401, {
        error: "unauthorized",
        message: "Metrics endpoint requires admin credentials",
      });
      return;
    }

    const registry = getMetricsRegistry();
    res.writeHead(200, { "Content-Type": registry.contentType });
    res.end(await registry.metrics());
  }

  async function handleLive(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    sendJson(res, 200, { status: "ok" });
  }

  async function handleReady(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (cachedHealth && cachedHealth.expiresAt > Date.now()) {
      sendJson(res, cachedHealth.statusCode === 200 ? 200 : 503, {
        status: cachedHealth.statusCode === 200 ? "ready" : "unready",
      });
      return;
    }
    const [redisOk, dbOk] = await Promise.all([redis.healthCheck(), dbHealthCheck()]);
    const isReady = redisOk && dbOk;
    sendJson(res, isReady ? 200 : 503, { status: isReady ? "ready" : "unready" });
  }

  async function dbHealthCheck(): Promise<boolean> {
    try {
      await sql`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  return { handleHealth, handleMetrics, handleLive, handleReady };
}
