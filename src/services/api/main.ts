import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadEnv, readBaseConfig } from "@/config/index.js";
import { createLogger } from "@/logger/index.js";
import { RedisClient } from "@/redis/index.js";
import { StreamProducer } from "@/queue/index.js";
import { createDatabase, type Db, type Sql } from "@/db/index.js";
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
import { readJsonBody, sendJson, HttpError, extractAuthToken } from "./http.js";
import { Router } from "./router.js";
import { createHandlers, type Deps } from "./handlers.js";
import { handleAdminRequest } from "./admin-static.js";
import { RedisLiveDeliveryEvents } from "./live-events.js";
import { createHealthHandlers } from "./health.js";
import { createWebhookHandler } from "./webhooks.js";
import { getAdminSession, hashPassword } from "@/services/auth/index.js";
import { projects, projectApiKeys } from "@/db/schema.js";
import { eq } from "drizzle-orm";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { LRUCache } from "@/shared/index.js";
import { transportRegistry } from "@/transport/index.js";
import type { Redis } from "@/redis/index.js";
import { z } from "zod";
import { ApiRateLimiter } from "@/rate-limiter/index.js";

export { extractAuthToken };

export const API_KEY_INVALIDATION_CHANNEL = "apikey.invalidated";

export const API_RATE_LIMIT_WINDOW_MS = 60_000;

loadEnv();
const config = readBaseConfig();

let logger: ReturnType<typeof createLogger>;
let redis: RedisClient;
let sql: Sql;
let db: Db;
let producers: Record<string, StreamProducer>;
let deps: Deps;
let h: ReturnType<typeof createHandlers>;
// Revoked keys are also dropped via pub/sub, so the TTL only bounds a missed message.
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

function isAdminApiKey(token: string): boolean {
  if (!config.ADMIN_API_KEY) return false;
  const expectedBuffer = Buffer.from(config.ADMIN_API_KEY);
  const providedBuffer = Buffer.from(token);
  return (
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

/** `admin_users.role` is free text, so anything but a known writer role is read-only. */
export function sessionKeyRole(role: string): "admin" | "read_only" {
  return role === "superadmin" || role === "admin" ? "admin" : "read_only";
}

/**
 * Each trusted proxy appends the address it saw to X-Forwarded-For, so the
 * client is `trustedHops` back from the peer. Entries further left are
 * client-written.
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
  // Created per start, so a restart in the same process starts with no cached health.
  const { handleHealth, handleMetrics, handleLive, handleReady } = createHealthHandlers({
    redis,
    sql,
    isAdminApiKey,
  });

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
    // URL is parsed only if something reads the query.
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

    // Reached from a mail client; the signed token in the URL is the credential.
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
      } else if (isAdminApiKey(token)) {
        isAdminToken = true;
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
            // Cleared together so every cached token stays revocable by hash.
            tokenHashToToken.clear();
            authCache.clear();
          }
        }
      }

      // Logging out only ends the caller's own session, so read-only users may.
      if (keyRole === "read_only" && pathname !== "/v1/auth/logout") {
        const isMutating = req.method !== "GET" && req.method !== "OPTIONS";
        if (isMutating) {
          sendJson(res, 403, { error: "forbidden", message: "API key is read-only" });
          return;
        }
      }

      if (!(await apiRateLimiter.check(projectId || "global", projectRateLimitRpm))) {
        res.setHeader("Retry-After", "60");
        sendJson(res, 429, {
          error: "too_many_requests",
          message: `Project rate limit exceeded (max ${projectRateLimitRpm} req/min)`,
        });
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
          // Minting keys hands out admin credentials, so read-only sessions may only look.
          if (sessionKeyRole(session.role) === "read_only" && req.method !== "GET") {
            sendJson(res, 403, { error: "forbidden", message: "Session is read-only" });
            return;
          }
          authorized = true;
        }
      } else if (isAdminApiKey(token)) {
        authorized = true;
      }

      if (!authorized) {
        sendJson(res, 401, { error: "unauthorized", message: "Invalid admin token" });
        return;
      }
      isAdminToken = true;
    }

    // Public, so capped per client instead of per project; generous for shared corporate IPs.
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
        // Fail open: a recipient who cannot opt out is worse than an unthrottled endpoint.
        logger.warn({ err }, "unsubscribe rate limit unavailable — allowing request");
      }
    }

    // Per-IP cap against brute force; each attempt also costs a scrypt hash.
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
      router.post(transport.webhookPath, createWebhookHandler(transport, channel, { db, logger }));
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
  // Module-scoped, so a restart in the same process must not inherit cached auth.
  authCache = new LRUCache<string, CachedAuthKey>(1000, AUTH_CACHE_TTL_MS);
  tokenHashToToken.clear();
  if (sql) await sql.end();
  if (redis) await redis.disconnect();
  logger?.info("api stopped");
}
