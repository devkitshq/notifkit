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
  AdminUserRepository,
} from "@/repositories/index.js";
import { STREAMS } from "@/contracts/index.js";
import { readJsonBody, readRawBody, sendJson, HttpError } from "./http.js";
import { Router } from "./router.js";
import { createHandlers } from "./handlers.js";
import { handleAdminRequest } from "./admin-static.js";
import { RedisLiveDeliveryEvents } from "./live-events.js";
import { getAdminSession, hashPassword } from "@/services/auth/index.js";
import { projects, messageLogs, projectApiKeys, suppressions } from "@/db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { LRUCache, normaliseTarget } from "@/shared/index.js";
import { transportRegistry } from "@/transport/index.js";
import type { Redis } from "@/redis/index.js";
import { z } from "zod";
import { getMetricsRegistry } from "@/metrics/index.js";
import { ApiRateLimiter } from "@/rate-limiter/index.js";

/** Pub/sub channel used to drop a cached API key across every API process. */
export const API_KEY_INVALIDATION_CHANNEL = "apikey.invalidated";

/** Default window length in milliseconds for API rate limiting (1 minute). */
export const API_RATE_LIMIT_WINDOW_MS = 60_000;

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
interface CachedAuthKey {
  projectId: string;
  projectRateLimitRpm: number;
  keyRole: "admin" | "read_only";
  tokenHash: string;
}

const AUTH_CACHE_TTL_MS = 60_000;
let authCache = new LRUCache<string, CachedAuthKey>(1000, AUTH_CACHE_TTL_MS);
let tokenHashToToken = new Map<string, string>();
let authSubscriber: Redis | null = null;
let router: Router;
let liveEvents: RedisLiveDeliveryEvents | null = null;
let apiRateLimiter: ApiRateLimiter;

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

/**
 * What a dashboard user's role may do. `admin_users.role` is free text (the
 * create-admin script takes any value), so only the roles known to grant
 * writes do; anything else, `read_only` included, is read-only.
 */
export function sessionKeyRole(role: string): "admin" | "read_only" {
  return role === "superadmin" || role === "admin" ? "admin" : "read_only";
}

/**
 * Resolves the client address, given how many proxies (TRUST_PROXY) are in
 * front of the API. Each one appends the address it saw to X-Forwarded-For,
 * so the client is `trustedHops` back from the connecting peer. The leftmost
 * entry is the one a client can write itself, so it is used only when the
 * chain is shorter than the configured hops.
 */
export function getClientIp(req: IncomingMessage, trustedHops: number): string {
  const peer = req.socket.remoteAddress || "unknown";
  const forwarded = req.headers["x-forwarded-for"];
  if (trustedHops <= 0 || typeof forwarded !== "string") return peer;

  const chain = [
    ...forwarded
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    peer,
  ];
  return chain[Math.max(chain.length - 1 - trustedHops, 0)]!;
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
      } else if (config.ADMIN_API_KEY) {
        const expectedBuffer = Buffer.from(config.ADMIN_API_KEY);
        const providedBuffer = Buffer.from(token);
        if (
          expectedBuffer.length === providedBuffer.length &&
          timingSafeEqual(expectedBuffer, providedBuffer)
        ) {
          authorized = true;
        }
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

// ─── HTTP server ────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;

export async function startApiServer() {
  logger = createLogger({ name: "api", level: config.LOG_LEVEL });

  if (config.NODE_ENV === "production" && !config.UNSUBSCRIBE_SECRET) {
    logger.fatal(
      "UNSUBSCRIBE_SECRET is required in production. Without it, all unsubscribe links " +
        "return 400 and opt-outs are silently dropped. Set a random string of 32+ characters and restart.",
    );
    process.exit(1);
  }

  redis = RedisClient.shared({ url: config.REDIS_URL, name: "api", logger });
  apiRateLimiter = new ApiRateLimiter({
    redis: redis.native,
    windowMs: API_RATE_LIMIT_WINDOW_MS,
    logger,
  });
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

  const adminUserRepo = new AdminUserRepository(db);

  if (config.ADMIN_EMAIL && config.ADMIN_PASSWORD) {
    try {
      const existing = await adminUserRepo.findByEmailOrUsername(config.ADMIN_EMAIL);
      if (!existing) {
        const passwordHash = await hashPassword(config.ADMIN_PASSWORD);
        await adminUserRepo.create({
          email: config.ADMIN_EMAIL,
          username: config.ADMIN_USERNAME,
          passwordHash,
          role: "superadmin",
        });
        logger.info({ email: config.ADMIN_EMAIL }, "Bootstrapped initial admin user");
      }
    } catch (err) {
      logger.error({ err }, "Failed to bootstrap default admin user");
    }
  }

  liveEvents = new RedisLiveDeliveryEvents(redis.native, logger);
  deps = {
    logger,
    redis,
    liveEvents,
    producers,
    userRepo: new UserRepository(db),
    contactRepo: new ContactRepository(db),
    templateRepo: new TemplateRepository(db),
    projectRepo: new ProjectRepository(db),
    workflowRepo: new WorkflowRepository(db),
    segmentRepo: new SegmentRepository(db),
    adminUserRepo,
    db,
  };
  h = createHandlers(deps);

  router = new Router();
  router
    .post("/v1/auth/login", h.login)
    .post("/v1/auth/logout", h.logout)
    .get("/v1/auth/me", h.getMe)
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
    void handleRequest(req, res).catch((err) => {
      logger.error({ err }, "unhandled api request error");
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error" });
      }
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Fast pathname extraction: avoid allocating a full WHATWG URL object on every
    // request. `new URL()` parses scheme, host, port, path, and query — most of
    // which we never use on the hot path. URLSearchParams is built lazily and only
    // materialises when a handler or the auth block actually needs it.
    const rawUrl = req.url ?? "/";
    const qIdx = rawUrl.indexOf("?");
    const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
    let _lazyUrl: URL | null = null;
    const getUrl = (): URL => (_lazyUrl ??= new URL(rawUrl, "http://n"));
    const searchParams = (): URLSearchParams => getUrl().searchParams;
    const origin = req.headers["origin"] as string | undefined;
    const allowedOrigins = (config.CORS_ORIGIN ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const isSessionRoute =
      pathname.startsWith("/v1/auth/") ||
      pathname === "/v1/projects" ||
      pathname.startsWith("/v1/projects/") ||
      pathname.startsWith("/v1/system/") ||
      pathname.startsWith("/v1/dlq");

    if (isSessionRoute) {
      if (origin && allowedOrigins.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }

    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-api-key, x-project-id, x-idempotency-key",
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      const handled = await handleAdminRequest(req, res, getUrl());
      if (handled) return;
    }

    let projectId: string | undefined = undefined;
    let projectRateLimitRpm = 600;
    let keyRole: "admin" | "read_only" = "admin";
    let isAdminToken = false;

    const isProjectManagement = pathname === "/v1/projects" || pathname.startsWith("/v1/projects/");

    // Unsubscribe is reached from a mail client, which has no API key and never
    // will. The signed token in the URL is the credential, and it authorises
    // exactly one action for one address.
    const isPublicUnsubscribe = pathname === "/v1/unsubscribe";
    const isPublicAuth = pathname === "/v1/auth/login";

    if (
      pathname.startsWith("/v1/") &&
      !isProjectManagement &&
      !isPublicUnsubscribe &&
      !isPublicAuth
    ) {
      let token = extractAuthToken(req);
      if (!token && searchParams().has("token")) {
        token = searchParams().get("token") || undefined;
      }

      if (!token) {
        sendJson(res, 401, { error: "unauthorized", message: "Invalid or missing API key" });
        return;
      }

      if (token.startsWith("nk_sess_")) {
        const session = await getAdminSession(redis.native, token);
        if (session) {
          isAdminToken = true;
          keyRole = sessionKeyRole(session.role);
        }
      } else if (config.ADMIN_API_KEY) {
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
          searchParams().get("projectId") ||
          undefined;
        const isProjectAgnostic =
          pathname.startsWith("/v1/auth/") ||
          pathname.startsWith("/v1/system/") ||
          pathname.startsWith("/v1/dlq");
        if (!headerProjectId && !isProjectAgnostic) {
          sendJson(res, 400, {
            error: "bad_request",
            message: "x-project-id header or projectId query param required when using admin token",
          });
          return;
        }
        projectId = headerProjectId;
        projectRateLimitRpm = 6000;
        if (!token.startsWith("nk_sess_")) {
          keyRole = "admin";
        }
      } else {
        const cached = authCache.get(token);
        if (cached) {
          projectId = cached.projectId;
          projectRateLimitRpm = cached.projectRateLimitRpm;
          keyRole = cached.keyRole;
        } else {
          const tokenHash = createHash("sha256").update(token).digest("hex");
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
          const matchedProjectId = rows[0]!.id;
          projectId = matchedProjectId;
          projectRateLimitRpm = rows[0]!.rateLimitRpm ?? 600;
          keyRole = rows[0]!.role;
          authCache.set(token, {
            projectId: matchedProjectId,
            projectRateLimitRpm,
            keyRole,
            tokenHash,
          });
          tokenHashToToken.set(tokenHash, token);
          if (tokenHashToToken.size > 2000) {
            tokenHashToToken.clear();
          }
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

      // Project rate limit - In-Memory Token Leasing with Redis Sliding Window
      if (!apiRateLimiter && redis?.native) {
        apiRateLimiter = new ApiRateLimiter({
          redis: redis.native,
          windowMs: API_RATE_LIMIT_WINDOW_MS,
          logger,
        });
      }

      const allowed = apiRateLimiter
        ? await apiRateLimiter.check(projectId || "global", projectRateLimitRpm)
        : true;

      if (!allowed) {
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

      if (!token) {
        sendJson(res, 401, { error: "unauthorized", message: "Missing admin token" });
        return;
      }

      let authorized = false;
      if (token.startsWith("nk_sess_")) {
        const session = await getAdminSession(redis.native, token);
        if (session) {
          // Creating projects and minting keys hands out admin credentials, so
          // a read-only dashboard user gets to look and nothing more.
          if (sessionKeyRole(session.role) === "read_only" && req.method !== "GET") {
            sendJson(res, 403, { error: "forbidden", message: "Session is read-only" });
            return;
          }
          authorized = true;
        }
      } else if (config.ADMIN_API_KEY) {
        const expectedBuffer = Buffer.from(config.ADMIN_API_KEY);
        const providedBuffer = Buffer.from(token);
        if (
          expectedBuffer.length === providedBuffer.length &&
          timingSafeEqual(expectedBuffer, providedBuffer)
        ) {
          authorized = true;
        }
      }

      if (!authorized) {
        sendJson(res, 401, { error: "unauthorized", message: "Invalid admin token" });
        return;
      }
      isAdminToken = true;
    }

    // The unsubscribe routes skip the block above, and with it the per-project
    // rate limit — they are public by necessity. Cap them per client instead so
    // an open endpoint cannot be used to hammer the process. Generous, because
    // a shared corporate egress IP can legitimately produce a burst.
    if (isPublicUnsubscribe) {
      const clientIp = getClientIp(req, config.TRUST_PROXY);
      try {
        const key = `rate-limit:api:unsub:${clientIp}`;
        const count = await redis.native.countRequest(key, 60);
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

    // The login route is unauthenticated and CPU-intensive due to password hashing (scrypt).
    // Throttle login attempts per IP to prevent credential brute-forcing and CPU exhaustion.
    if (isPublicAuth) {
      const clientIp = getClientIp(req, config.TRUST_PROXY);
      try {
        const key = `rate-limit:api:auth:${clientIp}`;
        const count = await redis.native.countRequest(key, 60);
        if (count > 10) {
          res.setHeader("Retry-After", "60");
          sendJson(res, 429, {
            error: "too_many_requests",
            message: "Too many login attempts. Please try again later.",
          });
          return;
        }
      } catch (err) {
        logger.warn({ err }, "auth rate limit unavailable — allowing request");
      }
    }

    const route = router.match(req.method ?? "GET", pathname);

    if (!route) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const ctx = {
      params: route.params,
      query: searchParams(),
      projectId,
      role: keyRole,
      isAdmin: isAdminToken,
    };

    void Promise.resolve(route.handler(req, res, ctx)).catch((err: unknown) => {
      if (err instanceof HttpError) {
        if (!res.headersSent) sendJson(res, err.status, { error: err.code, message: err.message });
        return;
      }
      logger.error({ err, path: pathname }, "unhandled request error");
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    });
  }

  // Let key rotation take effect immediately instead of waiting out the TTL.
  authSubscriber = redis.native.duplicate({ enableAutoPipelining: false });
  await authSubscriber.subscribe(API_KEY_INVALIDATION_CHANNEL);
  authSubscriber.on("message", (channel: string, tokenHash: string) => {
    if (channel !== API_KEY_INVALIDATION_CHANNEL) return;
    if (tokenHash === "*") {
      authCache.clear();
      tokenHashToToken.clear();
      apiRateLimiter?.clear();
    } else {
      const token = tokenHashToToken.get(tokenHash);
      if (token) {
        authCache.delete(token);
        tokenHashToToken.delete(tokenHash);
      }
      authCache.delete(tokenHash);
    }
    logger.info({ tokenHash }, "api key cache invalidated");
  });

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
  await liveEvents?.close();
  liveEvents = null;
  // These are module-scoped, so a restart in the same process must not inherit
  // the previous instance's cached auth or health.
  authCache = new LRUCache<string, CachedAuthKey>(1000, AUTH_CACHE_TTL_MS);
  tokenHashToToken.clear();
  cachedHealth = null;
  if (sql) await sql.end();
  if (redis) await redis.disconnect();
  logger?.info("api stopped");
}
