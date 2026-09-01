import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadEnv, readBaseConfig } from "@/config/index.js";
import { createLogger } from "@/logger/index.js";
import { RedisClient } from "@/redis/index.js";
import { StreamProducer } from "@/queue/index.js";
import { createDatabase } from "@/db/index.js";
import {
  UserRepository,
  ContactRepository,
  TemplateRepository,
  ProjectRepository,
  WorkflowRepository,
  SegmentRepository,
} from "@/repositories/index.js";
import { STREAMS } from "@/contracts/index.js";
import { readJsonBody, readRawBody, sendJson, HttpError } from "./http.js";
import { Router } from "./router.js";
import { createHandlers } from "./handlers.js";
import { projects, messageLogs, projectApiKeys, suppressions } from "@/db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { LRUCache, normaliseTarget } from "@/shared/index.js";
import type { Redis } from "@/redis/index.js";
import { z } from "zod";
import { getMetricsRegistry } from "@/metrics/index.js";

/** Pub/sub channel used to drop a cached API key across every API process. */
export const API_KEY_INVALIDATION_CHANNEL = "apikey.invalidated";

// ─── Bootstrap ─────────────────────────────────────────────────────────────

loadEnv();
const config = readBaseConfig();

let logger: ReturnType<typeof createLogger>;
let redis: RedisClient;
let sql: any;
let db: any;
let producers: Record<string, StreamProducer>;
let deps: any;
let h: any;
// Short-TTL LRU so a hot key does not hit the DB on every request. Kept small
// and invalidated on key change so a revoked key stops working promptly.
const AUTH_CACHE_TTL_MS = 60_000;
let authCache = new LRUCache<string, string>(1000, AUTH_CACHE_TTL_MS);
let authSubscriber: Redis | null = null;
let router: Router;

export function extractAuthToken(req: Pick<IncomingMessage, "headers">): string | undefined {
  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string") {
    return apiKeyHeader.trim();
  }
  return undefined;
}

async function handleCreateProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = z.object({ name: z.string().min(1) }).safeParse(await readJsonBody(req));
  if (!parsed.success) {
    sendJson(res, 400, { error: "validation_error", issues: parsed.error.issues });
    return;
  }
  const apiKey = `nk_live_${randomBytes(32).toString("hex")}`;
  const apiKeyHash = createHash("sha256").update(apiKey).digest("hex");
  const rows = await db.insert(projects).values({ name: parsed.data.name }).returning();
  const projectId = rows[0]!.id;
  await db.insert(projectApiKeys).values({ projectId, keyHash: apiKeyHash, role: "admin" });
  sendJson(res, 201, { id: projectId, apiKey });
}

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
        workers[key] = { status: "error", error: err instanceof Error ? err.message : String(err) };
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

async function handleMetrics(_req: IncomingMessage, res: ServerResponse): Promise<void> {
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

// ─── HTTP server ────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;

export async function startApiServer() {
  logger = createLogger({ name: "api", level: config.LOG_LEVEL });
  redis = new RedisClient({ url: config.REDIS_URL, name: "api", logger });
  const dbData = createDatabase({ url: config.DATABASE_URL, applicationName: "api", logger });
  sql = dbData.sql;
  db = dbData.db;

  producers = {
    critical: new StreamProducer({ redis: redis.native, stream: STREAMS.INBOUND_CRITICAL, logger }),
    normal: new StreamProducer({ redis: redis.native, stream: STREAMS.INBOUND_NORMAL, logger }),
    low: new StreamProducer({ redis: redis.native, stream: STREAMS.INBOUND_LOW, logger }),
    workflow: new StreamProducer({ redis: redis.native, stream: STREAMS.WORKFLOW_INBOUND, logger }),
    events: new StreamProducer({ redis: redis.native, stream: STREAMS.EVENTS_INBOUND, logger }),
  };

  deps = {
    logger,
    redis,
    producers,
    userRepo: new UserRepository(db),
    contactRepo: new ContactRepository(db),
    templateRepo: new TemplateRepository(db),
    projectRepo: new ProjectRepository(db),
    workflowRepo: new WorkflowRepository(db),
    segmentRepo: new SegmentRepository(db),
    db,
  };
  h = createHandlers(deps);

  router = new Router();
  router
    .put("/v1/templates", h.syncTemplates)
    .get("/v1/templates", h.listTemplates)
    .get("/v1/templates/:id", h.getTemplate)
    .delete("/v1/templates/:id", h.deleteTemplate)
    .post("/v1/users", h.addUser)
    .get("/v1/users", h.listUsers)
    .get("/v1/users/:id", h.getUser)
    .get("/v1/users/:id/details", h.getUserDetails)
    .patch("/v1/users/:id", h.updateUser)
    .delete("/v1/users/:id", h.deleteUser)
    .post("/v1/users/:id/contacts", h.addContact)
    .get("/v1/users/:id/contacts", h.getUserContacts)
    .delete("/v1/users/:id/contacts/:channel/:target", h.deleteContact)
    .get("/v1/users/:id/preferences", h.getUserPreferences)
    .patch("/v1/users/:id/preferences", h.updateUserPreferences)
    .post("/v1/notify", h.notify)
    .get("/v1/notifications/scheduled", h.getScheduledMessages)
    .get("/v1/notifications/logs", h.getNotificationLogs)
    .get("/v1/notifications/:taskId", h.getNotificationStatus)
    .delete("/v1/notifications/:taskId", h.cancelNotification)
    .get("/v1/unsubscribe", h.unsubscribePage)
    .post("/v1/unsubscribe", h.unsubscribe)
    .get("/v1/campaigns", h.listCampaigns)
    .get("/v1/campaigns/:campaign/stats", h.getCampaignStats)
    .get("/v1/suppressions", h.listSuppressions)
    .post("/v1/suppressions", h.createSuppression)
    .delete("/v1/suppressions/:channel/:target", h.deleteSuppression)
    .get("/v1/system/health", h.getSystemHealth)
    .get("/v1/system/metrics", h.getSystemMetrics)
    .get("/v1/dlq", h.getDLQMessages)
    .post("/v1/dlq/replay", h.replayDLQMessage)
    .delete("/v1/dlq/:id", h.deleteDLQMessage)
    .post("/v1/workflows", h.createWorkflow)
    .get("/v1/workflows", h.listWorkflows)
    .get("/v1/workflows/instances/:id", h.getWorkflow)
    .delete("/v1/workflows/instances/:id", h.cancelWorkflow)
    .post("/v1/workflows/trigger", h.triggerWorkflow)
    .get("/v1/segments", h.listSegments)
    .post("/v1/events", h.ingestEvent)
    .get("/v1/events/stream", h.getEventsStream)
    .get("/v1/projects", h.listProjects)
    .post("/v1/projects", handleCreateProject)
    .delete("/v1/projects/:id", h.deleteProject)
    .patch("/v1/projects/:id", h.updateProject)
    .post("/v1/projects/:id/keys", h.createProjectKey)
    .get("/v1/projects/:id/keys", h.listProjectKeys)
    .delete("/v1/projects/:id/keys/:keyId", h.deleteProjectKey)
    .get("/health", handleHealth)
    .get("/metrics", handleMetrics)
    .get("/live", handleLive)
    .get("/ready", handleReady);

  server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Add CORS headers for browser clients (like the Next.js dashboard)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-api-key, x-project-id",
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    let projectId: string | undefined = undefined;
    let projectRateLimitRpm = 600;
    let keyRole: "admin" | "read_only" = "admin";

    const isProjectManagement =
      url.pathname === "/v1/projects" || url.pathname.startsWith("/v1/projects/");

    // Unsubscribe is reached from a mail client, which has no API key and never
    // will. The signed token in the URL is the credential, and it authorises
    // exactly one action for one address.
    const isPublicUnsubscribe = url.pathname === "/v1/unsubscribe";

    if (url.pathname.startsWith("/v1/") && !isProjectManagement && !isPublicUnsubscribe) {
      let token = extractAuthToken(req);
      if (!token && url.searchParams.has("token")) {
        token = url.searchParams.get("token") || undefined;
      }

      if (!token) {
        sendJson(res, 401, { error: "unauthorized", message: "Invalid or missing API key" });
        return;
      }

      let isAdminToken = false;
      if (config.ADMIN_API_KEY) {
        const expectedBuffer = Buffer.from(config.ADMIN_API_KEY);
        const providedBuffer = Buffer.from(token);
        if (
          expectedBuffer.length === providedBuffer.length &&
          timingSafeEqual(expectedBuffer, providedBuffer)
        ) {
          isAdminToken = true;
        }
      }

      if (isAdminToken) {
        const headerProjectId =
          (req.headers["x-project-id"] as string | undefined) ||
          url.searchParams.get("projectId") ||
          undefined;
        if (!headerProjectId) {
          sendJson(res, 400, {
            error: "bad_request",
            message: "x-project-id header or projectId query param required when using admin token",
          });
          return;
        }
        projectId = headerProjectId;
        projectRateLimitRpm = 6000;
        keyRole = "admin";
      } else {
        const tokenHash = createHash("sha256").update(token).digest("hex");
        const cached = authCache.get(tokenHash);
        if (cached) {
          const parts = cached.split(":");
          projectId = parts[0];
          projectRateLimitRpm = parseInt(parts[1] || "600", 10);
          keyRole = parts[2] as "admin" | "read_only";
        } else {
          const rows = await db
            .select({
              id: projects.id,
              rateLimitRpm: projects.rateLimitRpm,
              role: projectApiKeys.role,
            })
            .from(projectApiKeys)
            .innerJoin(projects, eq(projects.id, projectApiKeys.projectId))
            .where(eq(projectApiKeys.keyHash, tokenHash))
            .limit(1);
          if (!rows.length) {
            sendJson(res, 401, { error: "unauthorized", message: "Invalid or missing API key" });
            return;
          }
          projectId = rows[0]!.id;
          projectRateLimitRpm = rows[0]!.rateLimitRpm ?? 600;
          keyRole = rows[0]!.role;
          authCache.set(tokenHash, `${projectId}:${projectRateLimitRpm}:${keyRole}`);
        }
      }

      // Role Check
      if (keyRole === "read_only") {
        const isMutating = req.method !== "GET" && req.method !== "OPTIONS";
        if (isMutating) {
          sendJson(res, 403, { error: "forbidden", message: "API key is read-only" });
          return;
        }
      }

      // Project rate limit - Sliding Window
      const LUA_LIMIT = `
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local window = tonumber(ARGV[2])
        local maxReqs = tonumber(ARGV[3])
        local cutoff = now - window
        redis.call("ZREMRANGEBYSCORE", key, "-inf", cutoff)
        local count = redis.call("ZCARD", key)
        if count < maxReqs then
          redis.call("ZADD", key, now, now .. "-" .. ARGV[4])
          redis.call("EXPIRE", key, math.ceil(window / 1000))
          return count + 1
        end
        return -1
      `;
      const rlKey = `rate-limit:api:req:${projectId}`;
      const nowMs = Date.now();
      const count = (await redis.native.eval(
        LUA_LIMIT,
        1,
        rlKey,
        nowMs,
        60000,
        projectRateLimitRpm,
        randomBytes(4).toString("hex"),
      )) as number;
      if (count === -1) {
        if (!res.headersSent) {
          res.setHeader("Retry-After", "60");
          sendJson(res, 429, {
            error: "too_many_requests",
            message: `Project rate limit exceeded (max ${projectRateLimitRpm} req/min)`,
          });
        }
        return;
      }
    } else if (isProjectManagement) {
      const token = extractAuthToken(req);

      if (!config.ADMIN_API_KEY) {
        sendJson(res, 403, {
          error: "forbidden",
          message: "Project management disabled (no ADMIN_API_KEY set)",
        });
        return;
      }
      if (!token) {
        sendJson(res, 401, { error: "unauthorized", message: "Missing admin token" });
        return;
      }

      const expectedBuffer = Buffer.from(config.ADMIN_API_KEY);
      const providedBuffer = Buffer.from(token);
      if (
        expectedBuffer.length !== providedBuffer.length ||
        !timingSafeEqual(expectedBuffer, providedBuffer)
      ) {
        sendJson(res, 401, { error: "unauthorized", message: "Invalid admin token" });
        return;
      }
    }

    // The unsubscribe routes skip the block above, and with it the per-project
    // rate limit — they are public by necessity. Cap them per client instead so
    // an open endpoint cannot be used to hammer the process. Generous, because
    // a shared corporate egress IP can legitimately produce a burst.
    if (isPublicUnsubscribe) {
      const clientIp =
        (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
        req.socket.remoteAddress ||
        "unknown";
      try {
        const key = `rate-limit:api:unsub:${clientIp}`;
        const count = await redis.native.incr(key);
        if (count === 1) await redis.native.expire(key, 60);
        if (count > 60) {
          res.setHeader("Retry-After", "60");
          sendJson(res, 429, { error: "too_many_requests" });
          return;
        }
      } catch (err) {
        // Redis being down must not stop someone unsubscribing — failing open
        // here is the lesser evil against a recipient who cannot opt out.
        logger.warn({ err }, "unsubscribe rate limit unavailable — allowing request");
      }
    }

    const route = router.match(req.method ?? "GET", url.pathname);

    if (!route) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const ctx = { params: route.params, query: url.searchParams, projectId, role: keyRole };

    void Promise.resolve(route.handler(req, res, ctx)).catch((err: unknown) => {
      if (err instanceof HttpError) {
        if (!res.headersSent) sendJson(res, err.status, { error: err.code, message: err.message });
        return;
      }
      logger.error({ err, path: url.pathname }, "unhandled request error");
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    });
  }

  // Let key rotation take effect immediately instead of waiting out the TTL.
  authSubscriber = redis.native.duplicate();
  await authSubscriber.subscribe(API_KEY_INVALIDATION_CHANNEL);
  authSubscriber.on("message", (channel: string, tokenHash: string) => {
    if (channel !== API_KEY_INVALIDATION_CHANNEL) return;
    if (tokenHash === "*") authCache.clear();
    else authCache.delete(tokenHash);
    logger.info({ tokenHash }, "api key cache invalidated");
  });

  const { transportRegistry } = await import("../../transport/index.js");
  for (const channel of transportRegistry.registeredChannels()) {
    const transport = transportRegistry.get(channel as any);
    if (!transport?.webhookPath) continue;

    if (transport.verifyWebhookChallenge) {
      router.get(transport.webhookPath, async (_req, res, ctx) => {
        try {
          const challenge = await transport.verifyWebhookChallenge!(ctx.query);
          if (challenge === undefined) {
            res.writeHead(403, { "Content-Type": "text/plain" });
            res.end("Forbidden");
            return;
          }
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(challenge);
        } catch (err) {
          logger.error({ err, channel }, "webhook verification challenge error");
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("internal_error");
          }
        }
      });
      logger.info(`Mounted webhook verification GET for ${channel} at ${transport.webhookPath}`);
    }

    if (transport.parseWebhook) {
      router.post(transport.webhookPath, async (req, res) => {
        try {
          await Promise.race([
            (async () => {
              const rawBody = await readRawBody(req);
              if (!transport.verifyWebhook) {
                if (!res.headersSent)
                  sendJson(res, 501, {
                    error: "not_implemented",
                    message: "Webhook signature verification is not implemented for this provider",
                  });
                return;
              }

              const isValid = await transport.verifyWebhook(rawBody, req.headers);
              if (!isValid) {
                if (!res.headersSent)
                  sendJson(res, 401, {
                    error: "unauthorized",
                    message: "Invalid webhook signature",
                  });
                return;
              }
              let body;
              try {
                body = rawBody ? JSON.parse(rawBody) : {};
              } catch {
                body = {};
              }
              const events = await transport.parseWebhook!(body, rawBody, req.headers);

              if (events.length > 0) {
                const providerIds = events
                  .map((e) => e.providerMessageId)
                  .filter(Boolean) as string[];
                const logsToProject = new Map<string, string>();
                const logsToTask = new Map<string, string>();
                const logsToCampaign = new Map<string, string | null>();
                if (providerIds.length > 0) {
                  const existing = await db
                    .select({
                      providerMessageId: messageLogs.providerMessageId,
                      projectId: messageLogs.projectId,
                      taskId: messageLogs.taskId,
                      campaignId: messageLogs.campaignId,
                    })
                    .from(messageLogs)
                    .where(inArray(messageLogs.providerMessageId, providerIds));
                  for (const row of existing) {
                    if (row.providerMessageId) {
                      logsToProject.set(row.providerMessageId, row.projectId);
                      logsToTask.set(row.providerMessageId, row.taskId);
                      // Inherit the campaign from the delivery this event is
                      // about, or an open never counts toward the send that
                      // earned it.
                      logsToCampaign.set(row.providerMessageId, row.campaignId);
                    }
                  }
                }

                // Only record events we can attribute to a real message. An
                // unresolvable providerMessageId used to be written against a
                // zero-UUID project, which is unjoinable and leaks across tenants.
                const attributable = events.filter(
                  (e) => e.providerMessageId && logsToProject.has(e.providerMessageId),
                );

                const rows = attributable.map((e) => ({
                  projectId: logsToProject.get(e.providerMessageId)!,
                  taskId: logsToTask.get(e.providerMessageId)!,
                  providerMessageId: e.providerMessageId,
                  channel: transport.channel,
                  // Engagement events are not delivery attempts.
                  attempt: 0,
                  kind: e.status,
                  status: e.status,
                  campaignId: logsToCampaign.get(e.providerMessageId) ?? null,
                  metadata: e.metadata ?? null,
                }));

                const skipped = events.length - rows.length;
                if (skipped > 0) {
                  logger.warn(
                    { channel, skipped },
                    "webhook events skipped: unknown providerMessageId",
                  );
                }

                if (rows.length > 0) {
                  // Providers retry on any non-2xx, so redelivery of an event we have
                  // already recorded must be a no-op rather than a constraint error.
                  await db.insert(messageLogs).values(rows).onConflictDoNothing();
                }

                // An unsubscribe, a spam complaint, or a permanently dead
                // address must stop future sends — logging it is not enough.
                // Soft bounces are excluded: the address is still good.
                const suppressionRows = attributable
                  .filter(
                    (e) =>
                      e.recipient &&
                      (e.status === "unsubscribed" ||
                        e.status === "complained" ||
                        (e.status === "bounced" && e.bounceType === "hard")),
                  )
                  .map((e) => ({
                    projectId: logsToProject.get(e.providerMessageId)!,
                    channel: transport.channel,
                    target: normaliseTarget(e.recipient!),
                    reason: e.status,
                    source: channel,
                    taskId: logsToTask.get(e.providerMessageId)!,
                  }));

                if (suppressionRows.length > 0) {
                  // First reason wins: a later bounce should not overwrite the
                  // record that the person actively unsubscribed.
                  await db.insert(suppressions).values(suppressionRows).onConflictDoNothing();
                  logger.info(
                    { channel, count: suppressionRows.length },
                    "addresses suppressed from provider webhook",
                  );
                }

                const unsuppressable = attributable.filter(
                  (e) =>
                    !e.recipient &&
                    (e.status === "unsubscribed" ||
                      e.status === "complained" ||
                      e.status === "bounced"),
                ).length;
                if (unsuppressable > 0) {
                  // Worth shouting about: the event arrived, we logged it, and
                  // we still cannot stop mailing the person.
                  logger.warn(
                    { channel, count: unsuppressable },
                    "suppression events carried no recipient address — transport must set WebhookEvent.recipient",
                  );
                }
              }
              if (!res.headersSent) sendJson(res, 200, { success: true });
            })(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Webhook processing timeout")), 15000),
            ),
          ]);
        } catch (err: any) {
          logger.error({ err, channel }, "webhook processing error or timeout");
          if (!res.headersSent) {
            sendJson(res, 500, { error: "internal_error", message: err.message });
          }
        }
      });
      logger.info(`Mounted webhook for ${channel} at ${transport.webhookPath}`);
    }
  }

  server.listen(config.PORT, config.HOST, () => {
    logger.info(
      { port: config.PORT, host: config.HOST, env: config.NODE_ENV },
      "api server listening",
    );
  });
}

// ─── Shutdown ──────────────────────────────────────────────────────────────

export async function stopApiServer(): Promise<void> {
  logger?.info("api shutdown initiated");
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    server.closeIdleConnections?.();
    server = null as any;
  }
  if (authSubscriber) {
    authSubscriber.disconnect();
    authSubscriber = null;
  }
  // These are module-scoped, so a restart in the same process must not inherit
  // the previous instance's cached auth or health.
  authCache = new LRUCache<string, string>(1000, AUTH_CACHE_TTL_MS);
  cachedHealth = null;
  if (sql) await sql.end();
  if (redis) await redis.disconnect();
  logger?.info("api stopped");
}
