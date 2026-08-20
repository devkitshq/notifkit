import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "@/logger/index.js";
import type { RedisClient } from "@/redis/index.js";
import type { StreamProducer } from "@/queue/index.js";
import type {
  UserRepository,
  ContactRepository,
  TemplateRepository,
  ProjectRepository,
  WorkflowRepository,
  SegmentRepository,
} from "@/repositories/index.js";
import type { Preferences } from "@/contracts/index.js";
import {
  AddUserSchema,
  UpdateUserSchema,
  AddContactSchema,
  SyncTemplatesSchema,
  NotifyRequestSchema,
  ContactChannelSchema,
  PreferencesSchema,
  type NotificationRequestedPayload,
  type NotificationTarget,
  buildStreamEvent,
  CreateWorkflowSchema,
  TriggerWorkflowSchema,
  STREAMS,
  PUBSUB_CHANNELS,
} from "@/contracts/index.js";
import { readJsonBody, sendJson, sendNoContent, sendValidationError } from "./http.js";
import type { RouteContext } from "./router.js";
import { globalEmitter, getPriorityBucket, normaliseTarget } from "@/shared/index.js";
import { metrics } from "@/metrics/index.js";
import { eq, desc, and, lt, lte, gte, sql, like, or, isNotNull } from "drizzle-orm";
import {
  messageLogs,
  workflowDefinitions,
  scheduledPayloads,
  suppressions,
  users as dbUsers,
  userTopicPreferences,
} from "@/db/schema.js";
import { readBaseConfig } from "@/config/index.js";
import { verifyUnsubscribeToken } from "@/unsubscribe/index.js";
import type { Db } from "@/db/index.js";
import { z } from "zod";

const IngestEventSchema = z.object({
  name: z.string().min(1),
  properties: z.record(z.string(), z.unknown()),
});

export interface Deps {
  logger: Logger;
  redis: RedisClient;
  producers: Record<string, StreamProducer>;
  userRepo: UserRepository;
  contactRepo: ContactRepository;
  templateRepo: TemplateRepository;
  projectRepo: ProjectRepository;
  workflowRepo: WorkflowRepository;
  segmentRepo: SegmentRepository;
  db: Db;
}

// Inline user shape (email/phone/pushToken already normalised to string[] by Zod).
interface InlineUserLike {
  id: string;
  language?: string;
  timezone?: string;
  email?: string[];
  phone?: string[];
  pushToken?: string[];
  segments?: string[];
  preferences?: Preferences;
}

/** Map an inline user's contact arrays into (channel, target) pairs. */
function contactsOf(user: InlineUserLike): { channel: "email" | "sms" | "push"; target: string }[] {
  return [
    ...(user.email ?? []).map((target) => ({ channel: "email" as const, target })),
    ...(user.phone ?? []).map((target) => ({ channel: "sms" as const, target })),
    ...(user.pushToken ?? []).map((target) => ({ channel: "push" as const, target })),
  ];
}

/** Persist user records + their contacts in bulk. Shared by addUser and inline notify. */
async function persistUsers(deps: Deps, users: InlineUserLike[], projectId: string): Promise<void> {
  const usersList = users.map((u) => ({
    userId: u.id,
    language: u.language ?? "en",
    timezone: u.timezone ?? "UTC",
    email: u.email?.[0] ?? null,
    segments: u.segments ?? [],
    preferences: u.preferences ?? {},
  }));

  const contactsList: any[] = [];
  for (const u of users) {
    for (const c of contactsOf(u)) {
      contactsList.push({
        userId: u.id,
        channel: c.channel,
        target: c.target,
        preferences: {},
      });
    }
  }

  await deps.db.transaction(async (tx) => {
    const txUserRepo =
      deps.userRepo.constructor.name === "Object"
        ? deps.userRepo
        : new (deps.userRepo.constructor as any)(tx);
    const txContactRepo =
      deps.contactRepo.constructor.name === "Object"
        ? deps.contactRepo
        : new (deps.contactRepo.constructor as any)(tx);
    await txUserRepo.upsertManyFull(projectId, usersList);
    await txContactRepo.upsertMany(projectId, contactsList);
  });
}

function getQueryParam(ctx: RouteContext, key: string): string | undefined {
  if (!ctx.query) return undefined;
  if (typeof ctx.query.get === "function") {
    return ctx.query.get(key) ?? undefined;
  }
  return (ctx.query as any)[key] ?? undefined;
}

export function createHandlers(deps: Deps) {
  const { logger } = deps;

  // ── PUT /v1/templates — initializeApp({ templates }) ──────────────────────
  async function syncTemplates(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const parsed = SyncTemplatesSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const synced = await deps.templateRepo.upsertMany(
      ctx.projectId!,
      parsed.data.templates.map((t) => ({
        id: t.id,
        channel: t.channel,
        topics: t.topic ?? [],
        content: t.content,
        aiPrompts: (t as any).aiPrompts,
      })),
    );

    // Invalidate caches
    for (const t of parsed.data.templates) {
      await deps.redis.native.publish("template.invalidated", `${ctx.projectId}:${t.id}`);
    }

    logger.info({ synced }, "templates synced");
    sendJson(res, 200, { synced });
  }

  // ── POST /v1/users — addUser ──────────────────────────────────────────────
  async function addUser(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const parsed = AddUserSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) return sendValidationError(res, parsed.error);

    await persistUsers(deps, [parsed.data], ctx.projectId!);
    logger.info({ userId: parsed.data.id }, "user upserted");
    sendJson(res, 201, { id: parsed.data.id });
  }

  // ── PATCH /v1/users/:id — updateUser ──────────────────────────────────────
  async function updateUser(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const userId = ctx.params.id!;
    const parsed = UpdateUserSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const patch = parsed.data;

    const updated = await deps.userRepo.updatePartial(ctx.projectId!, userId, {
      language: patch.language,
      timezone: patch.timezone,
      email: patch.email?.[0],
      segments: patch.segments,
      preferences: patch.preferences,
    });
    if (!updated) return sendJson(res, 404, { error: "user_not_found", id: userId });

    // New contact values in the patch are added (existing ones are kept).
    for (const c of contactsOf({ id: userId, ...patch })) {
      await deps.contactRepo.upsert(ctx.projectId!, userId, c.channel, c.target);
    }
    logger.info({ userId }, "user updated");
    sendJson(res, 200, { id: userId });
  }

  // ── DELETE /v1/users/:id — deleteUser ─────────────────────────────────────
  async function deleteUser(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const userId = ctx.params.id!;
    const deleted = await deps.userRepo.delete(ctx.projectId!, userId);
    if (!deleted) return sendJson(res, 404, { error: "user_not_found", id: userId });
    logger.info({ userId }, "user deleted");
    sendNoContent(res);
  }

  // ── POST /v1/users/:id/contacts — addUserContact ──────────────────────────
  async function addContact(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const userId = ctx.params.id!;
    const parsed = AddContactSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const user = await deps.userRepo.findById(ctx.projectId!, userId);
    if (!user) return sendJson(res, 404, { error: "user_not_found", id: userId });

    await deps.contactRepo.upsert(
      ctx.projectId!,
      userId,
      parsed.data.channel,
      parsed.data.target,
      parsed.data.preferences ?? {},
    );
    logger.info({ userId, channel: parsed.data.channel }, "contact added");
    sendJson(res, 201, { userId, channel: parsed.data.channel, target: parsed.data.target });
  }

  // ── DELETE /v1/users/:id/contacts/:channel/:target — deleteUserContact ────
  async function deleteContact(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const userId = ctx.params.id!;
    const channelResult = ContactChannelSchema.safeParse(ctx.params.channel);
    if (!channelResult.success)
      return sendJson(res, 400, { error: "invalid_channel", channel: ctx.params.channel });

    const deleted = await deps.contactRepo.delete(
      ctx.projectId!,
      userId,
      channelResult.data,
      ctx.params.target!,
    );
    if (!deleted) return sendJson(res, 404, { error: "contact_not_found" });
    logger.info({ userId, channel: channelResult.data }, "contact deleted");
    sendNoContent(res);
  }

  // ── POST /v1/notify — notify ──────────────────────────────────────────────
  async function notify(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const parsed = NotifyRequestSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const body = parsed.data;

    // Resolve the (unresolved) target. Inline users are synced first.
    let targets: NotificationTarget[] = [];
    if (body.user !== undefined) {
      const users = Array.isArray(body.user) ? body.user : [body.user];
      const inlineUsersToSync: InlineUserLike[] = [];
      for (const u of users) {
        if (typeof u === "string") {
          targets.push({ type: "user", userId: u });
        } else {
          inlineUsersToSync.push(u);
          targets.push({ type: "user", userId: u.id });
        }
      }

      if (inlineUsersToSync.length > 0) {
        try {
          await persistUsers(deps, inlineUsersToSync, ctx.projectId!);
        } catch (err) {
          deps.logger.error({ err }, "inline user bulk sync failed");
        }
      }
    } else if (body.segment !== undefined) {
      targets.push({ type: "segment", segment: body.segment });
    } else {
      targets.push({ type: "topic", topic: body.topic! });
    }

    const baseNotificationId = (req.headers["x-idempotency-key"] as string) || randomUUID();

    const priority = body.priority ?? "normal";
    const p = getPriorityBucket(priority);
    const producer = deps.producers[p] ?? deps.producers.normal!;

    const messageIds: string[] = [];
    let lastNotificationId = "";

    const CHUNK_SIZE = 1000;
    for (let chunkStart = 0; chunkStart < targets.length; chunkStart += CHUNK_SIZE) {
      const chunk = targets.slice(chunkStart, chunkStart + CHUNK_SIZE);

      const events = chunk.map((target, idx) => {
        const i = chunkStart + idx;
        const notificationId =
          targets.length > 1 ? `${baseNotificationId}-${i}` : baseNotificationId;
        lastNotificationId = notificationId;

        const payload: NotificationRequestedPayload = {
          projectId: ctx.projectId!,
          target,
          templateId: body.template,
          priority,
          channels: body.channels,
          data: body.data ?? {},
          aiPrompts: body.aiPrompts,
          fallback: body.fallback ?? false,
          scheduledAt: body.sendAt,
          idempotencyKey: notificationId,
          campaignId: body.campaign,
        };

        return buildStreamEvent(
          "notification.requested",
          payload as Record<string, unknown>,
          "api",
          notificationId,
        );
      });

      const { messageIds: chunkMessageIds } = await producer.publishBatch(events);
      messageIds.push(...chunkMessageIds);
    }

    logger.info({ count: targets.length, priority: p }, "notification requested");
    metrics.messagesPublished.inc({ channel: "api", priority: p }, targets.length);

    if (targets.length === 1) {
      sendJson(res, 202, {
        messageId: messageIds[0],
        notificationId: lastNotificationId,
        target: targets[0],
        ...(body.campaign ? { campaign: body.campaign } : {}),
      });
    } else {
      sendJson(res, 202, {
        messageIds,
        notificationIdsBase: baseNotificationId,
        batchSize: targets.length,
        ...(body.campaign ? { campaign: body.campaign } : {}),
      });
    }
  }

  // ── DELETE /v1/notifications/:taskId — cancelNotification ─────────────────
  async function cancelNotification(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const { taskId } = ctx.params;
    if (!taskId) return sendJson(res, 400, { error: "missing_task_id" });

    const rows = await deps.db
      .select({ payload: scheduledPayloads.payload })
      .from(scheduledPayloads)
      .where(eq(scheduledPayloads.taskId, taskId))
      .limit(1);

    if (rows.length === 0) {
      return sendJson(res, 404, {
        error: "not_found",
        message: "Task not found or already processed",
      });
    }

    const payload = rows[0]!.payload as any;
    if (payload.projectId !== ctx.projectId) {
      return sendJson(res, 404, {
        error: "not_found",
        message: "Task not found or already processed",
      });
    }

    const deletedRows = await deps.db
      .delete(scheduledPayloads)
      .where(eq(scheduledPayloads.taskId, taskId))
      .returning({ taskId: scheduledPayloads.taskId });

    if (deletedRows.length > 0) {
      globalEmitter.emit("notification:canceled", { projectId: ctx.projectId, taskId });
      sendJson(res, 200, { success: true });
    } else {
      sendJson(res, 404, { error: "not_found", message: "Task not found or already processed" });
    }
  }

  // ── POST /v1/workflows/trigger — triggerWorkflow ──────────────────────────
  async function triggerWorkflow(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const parsed = TriggerWorkflowSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const input: Record<string, unknown> = { ...(parsed.data.input ?? {}) };
    if (parsed.data.user) {
      if (typeof parsed.data.user === "string") {
        input.user = {
          id: parsed.data.user,
          ...(typeof input.user === "object" && input.user
            ? (input.user as Record<string, unknown>)
            : {}),
        };
      } else {
        try {
          await persistUsers(deps, [parsed.data.user], ctx.projectId!);
        } catch (err) {
          deps.logger.error({ err }, "inline user sync for workflow failed");
        }
        input.user = {
          id: parsed.data.user.id,
          ...(typeof input.user === "object" && input.user
            ? (input.user as Record<string, unknown>)
            : {}),
        };
      }
    }

    const instanceId = randomUUID();
    const messageId = await deps.producers.workflow!.publish(
      buildStreamEvent(
        "workflow.triggered",
        {
          projectId: ctx.projectId!,
          instanceId,
          name: parsed.data.name,
          input,
        },
        "api",
        instanceId,
      ),
    );
    logger.info({ messageId, instanceId, workflowName: parsed.data.name }, "workflow triggered");
    sendJson(res, 202, { messageId, instanceId });
  }

  // ── POST /v1/events — ingestEvent ─────────────────────────────────────────
  async function ingestEvent(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const tsStr = req.headers["x-timestamp"];
    const expiryStr = req.headers["x-expiry"];

    if (tsStr && expiryStr) {
      const now = Date.now();
      const eventTime = new Date(tsStr as string).getTime();
      const expMs = parseInt(expiryStr as string, 10) * 1000;

      if (now > eventTime + expMs) {
        sendJson(res, 400, { error: "event_expired", message: "Webhook event is expired" });
        return;
      }
    }

    const parsed = IngestEventSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const eventId = randomUUID();
    const messageId = await deps.producers.events!.publish(
      buildStreamEvent(
        "event.received",
        {
          projectId: ctx.projectId!,
          eventName: parsed.data.name,
          payload: parsed.data.properties,
        },
        "api",
        eventId,
      ),
    );
    logger.info({ messageId, eventId, eventName: parsed.data.name }, "event received");
    sendJson(res, 202, { messageId, eventId });
  }
  // ── GET /v1/events/stream — getEventsStream ──────────────────────────────────
  async function getEventsStream(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 10000\n\n");

    const onDelivered = (
      taskId: string,
      providerMessageId: string,
      channel: string,
      eventProjectId: string,
    ) => {
      if (eventProjectId && eventProjectId !== ctx.projectId) return;
      res.write(`event: delivery:delivered\n`);
      res.write(`data: ${JSON.stringify({ taskId, providerMessageId, channel })}\n\n`);
    };

    const onFailed = (taskId: string, error: string, channel: string, eventProjectId: string) => {
      if (eventProjectId && eventProjectId !== ctx.projectId) return;
      res.write(`event: delivery:failed\n`);
      res.write(`data: ${JSON.stringify({ taskId, error, channel })}\n\n`);
    };

    globalEmitter.on("delivery:delivered", onDelivered);
    globalEmitter.on("delivery:failed", onFailed);

    req.on("close", () => {
      globalEmitter.off("delivery:delivered", onDelivered);
      globalEmitter.off("delivery:failed", onFailed);
    });
  }

  // ── GET /v1/notifications/logs — getNotificationLogs ────────────────────
  async function getNotificationLogs(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const limitParam = parseInt(ctx.query.get("limit") || "50", 10);
    const limit = isNaN(limitParam) ? 50 : Math.min(limitParam, 100);
    const cursor = ctx.query.get("cursor");

    const templateId = getQueryParam(ctx, "templateId");
    const workflowInstanceId = getQueryParam(ctx, "workflowInstanceId");
    const channel = getQueryParam(ctx, "channel");
    const status = getQueryParam(ctx, "status");
    const taskId = getQueryParam(ctx, "taskId");
    const campaign = getQueryParam(ctx, "campaign") || getQueryParam(ctx, "campaignId");
    const search = getQueryParam(ctx, "search");

    const conditions = [eq(messageLogs.projectId, ctx.projectId!)];
    if (templateId) conditions.push(eq(messageLogs.templateId, templateId));
    if (workflowInstanceId) conditions.push(eq(messageLogs.workflowInstanceId, workflowInstanceId));
    if (channel) conditions.push(eq(messageLogs.channel, channel as any));
    if (status) conditions.push(eq(messageLogs.status, status as any));
    if (taskId) conditions.push(eq(messageLogs.taskId, taskId));
    if (campaign) conditions.push(eq(messageLogs.campaignId, campaign));
    if (search) {
      conditions.push(
        or(
          like(messageLogs.taskId, `%${search}%`),
          like(messageLogs.templateId, `%${search}%`),
          like(messageLogs.providerMessageId, `%${search}%`),
          like(messageLogs.campaignId, `%${search}%`),
        )!,
      );
    }

    if (cursor) {
      const cursorDate = new Date(parseInt(cursor, 10));
      conditions.push(lt(messageLogs.timestamp, cursorDate));
    }

    const logs = await deps.db
      .select()
      .from(messageLogs)
      .where(and(...conditions))
      .orderBy(desc(messageLogs.timestamp))
      .limit(limit * 2);

    // Deduplicate by taskId preserving the latest status per taskId
    const deduplicatedMap = new Map<string, (typeof logs)[0]>();
    for (const log of logs) {
      if (!deduplicatedMap.has(log.taskId)) {
        deduplicatedMap.set(log.taskId, log);
      } else {
        const existing = deduplicatedMap.get(log.taskId)!;
        if (existing.status === "dispatched" && log.status !== "dispatched") {
          deduplicatedMap.set(log.taskId, log);
        }
      }
    }
    const deduplicatedLogs = Array.from(deduplicatedMap.values()).slice(0, limit);

    const nextCursor =
      logs.length === limit * 2 ? logs[logs.length - 1]!.timestamp.getTime().toString() : null;

    sendJson(res, 200, { logs: deduplicatedLogs, nextCursor });
  }

  // ── GET /v1/notifications/:taskId — getNotificationStatus ───────────────
  async function getNotificationStatus(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const { taskId } = ctx.params;
    if (!taskId) return sendJson(res, 400, { error: "missing_task_id" });

    const logs = await deps.db
      .select()
      .from(messageLogs)
      .where(and(eq(messageLogs.taskId, taskId), eq(messageLogs.projectId, ctx.projectId!)))
      .orderBy(desc(messageLogs.timestamp));

    if (logs.length === 0) {
      // It might still be pending in Redis or scheduled
      return sendJson(res, 404, {
        error: "not_found",
        message: "Task not found or not processed yet",
      });
    }

    // Newest first, so `status` is the latest known state rather than whichever
    // row Postgres happened to return first.
    sendJson(res, 200, { status: logs[0]?.status, logs });
  }

  // ── GET /v1/users/:id — getUser ───────────────────────────────────────────
  async function getUser(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const userId = ctx.params.id!;
    const user = await deps.userRepo.findRecordById(ctx.projectId!, userId);
    if (!user) return sendJson(res, 404, { error: "user_not_found", id: userId });

    const contacts = await deps.contactRepo.findByUserId(ctx.projectId!, userId);
    sendJson(res, 200, { ...user, contacts });
  }

  // ── GET /v1/users/:id/preferences — getUserPreferences ────────────────────
  async function getUserPreferences(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const userId = ctx.params.id!;
    const user = await deps.userRepo.findRecordById(ctx.projectId!, userId);
    if (!user) return sendJson(res, 404, { error: "user_not_found", id: userId });

    sendJson(res, 200, user.preferences);
  }

  // ── PATCH /v1/users/:id/preferences — updateUserPreferences ───────────────
  async function updateUserPreferences(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const userId = ctx.params.id!;
    const parsed = PreferencesSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const updated = await deps.userRepo.updatePartial(ctx.projectId!, userId, {
      preferences: parsed.data,
    });
    if (!updated) return sendJson(res, 404, { error: "user_not_found", id: userId });

    logger.info({ userId }, "user preferences updated");
    sendJson(res, 200, { id: userId, preferences: parsed.data });
  }

  // ── POST /v1/workflows — createWorkflow ───────────────────────────────────
  async function createWorkflow(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const body = await readJsonBody(req);
    const parsed = CreateWorkflowSchema.safeParse(body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const input = parsed.data;

    try {
      await deps.db
        .insert(workflowDefinitions)
        .values({
          projectId: ctx.projectId!,
          name: input.name,
          steps: input.steps,
        })
        .onConflictDoUpdate({
          target: [workflowDefinitions.projectId, workflowDefinitions.name],
          set: {
            steps: input.steps,
          },
        });
      sendJson(res, 201, { name: input.name });
    } catch (error: any) {
      deps.logger.error({ err: error }, "Failed to create workflow definition");
      sendJson(res, 500, { error: "internal_error", message: error.message });
    }
  }

  // ── GET /v1/templates — listTemplates ─────────────────────────────────────
  async function listTemplates(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const limitParam = getQueryParam(ctx, "limit");
    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : undefined;
    const channel = getQueryParam(ctx, "channel");
    const topic = getQueryParam(ctx, "topic");
    let templates = await deps.templateRepo.list(ctx.projectId!);
    if (channel) {
      templates = templates.filter((t: any) => t.channel === channel);
    }
    if (topic) {
      templates = templates.filter((t: any) => t.topics?.includes(topic));
    }
    if (limit) {
      templates = templates.slice(0, limit);
    }
    sendJson(res, 200, { templates });
  }

  // ── GET /v1/templates/:id — getTemplate ───────────────────────────────────
  async function getTemplate(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const templateId = ctx.params.id!;
    const template = await deps.templateRepo.findById(ctx.projectId!, templateId);
    if (!template) return sendJson(res, 404, { error: "template_not_found", id: templateId });

    sendJson(res, 200, template);
  }

  // ── DELETE /v1/templates/:id — deleteTemplate ───────────────────────────
  async function deleteTemplate(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const templateId = ctx.params.id!;
    const deleted = await deps.templateRepo.delete(ctx.projectId!, templateId);
    if (!deleted) return sendJson(res, 404, { error: "template_not_found", id: templateId });

    await deps.redis.native.publish("template.invalidated", `${ctx.projectId}:${templateId}`);
    logger.info({ templateId }, "template deleted");
    sendNoContent(res);
  }

  // ── GET /v1/workflows — listWorkflows ─────────────────────────────────────
  async function listWorkflows(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const limitParam = getQueryParam(ctx, "limit");
    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : undefined;
    const search = getQueryParam(ctx, "search")?.trim().toLowerCase();
    let workflows = await deps.workflowRepo.listDefinitions(ctx.projectId!);
    if (search) {
      workflows = workflows.filter((w: any) => w.name?.toLowerCase().includes(search));
    }
    if (limit) {
      workflows = workflows.slice(0, limit);
    }
    sendJson(res, 200, { workflows });
  }

  // ── GET /v1/workflows/instances/:id — getWorkflow ─────────────────────────
  async function getWorkflow(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const instanceId = ctx.params.id!;
    const workflow = await deps.workflowRepo.getInstance(ctx.projectId!, instanceId);
    if (!workflow) return sendJson(res, 404, { error: "workflow_not_found", id: instanceId });

    sendJson(res, 200, workflow);
  }

  // ── DELETE /v1/workflows/instances/:id — cancelWorkflow ───────────────────
  async function cancelWorkflow(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const instanceId = ctx.params.id!;
    const canceled = await deps.workflowRepo.cancelInstance(ctx.projectId!, instanceId);
    if (!canceled) return sendJson(res, 400, { error: "workflow_not_cancelable", id: instanceId });

    logger.info({ instanceId }, "workflow canceled");
    sendNoContent(res);
  }

  // ── GET /v1/users — listUsers ─────────────────────────────────────────────
  async function listUsers(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const limitParam = parseInt(getQueryParam(ctx, "limit") || "50", 10);
    const limit = isNaN(limitParam) ? 50 : Math.min(limitParam, 100);
    const cursor = getQueryParam(ctx, "cursor");
    const search = getQueryParam(ctx, "search");
    const segment = getQueryParam(ctx, "segment");
    const language = getQueryParam(ctx, "language");
    const timezone = getQueryParam(ctx, "timezone");
    const channel = getQueryParam(ctx, "channel");

    const filters =
      search || segment || language || timezone || channel
        ? { search, segment, language, timezone, channel }
        : undefined;

    const result = await deps.userRepo.list(ctx.projectId!, limit, cursor, filters);
    sendJson(res, 200, result);
  }

  // ── GET /v1/users/:id/contacts — getUserContacts ──────────────────────────
  async function getUserContacts(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const userId = ctx.params.id!;
    const contacts = await deps.contactRepo.findByUserId(ctx.projectId!, userId);
    sendJson(res, 200, { contacts });
  }

  // ── GET /v1/segments — listSegments ───────────────────────────────────────
  async function listSegments(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const segments = await deps.segmentRepo.listSegments(ctx.projectId!);
    sendJson(res, 200, { segments });
  }

  // ── GET /v1/projects — listProjects ───────────────────────────────────────
  async function listProjects(
    req: IncomingMessage,
    res: ServerResponse,
    _ctx: RouteContext,
  ): Promise<void> {
    const projects = await deps.projectRepo.list();
    sendJson(res, 200, { projects });
  }

  // ── DELETE /v1/projects/:id — deleteProject ───────────────────────────────
  async function deleteProject(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const id = ctx.params.id!;
    const deleted = await deps.projectRepo.delete(id);
    if (!deleted) return sendJson(res, 404, { error: "project_not_found" });

    sendNoContent(res);
  }

  // ── PATCH /v1/projects/:id — updateProject ────────────────────────────────
  async function updateProject(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const id = ctx.params.id!;
    const parsed = z
      .object({
        rateLimitRpm: z.number().nullable().optional(),
        throttleLimit: z.number().nullable().optional(),
        throttleWindowHours: z.number().nullable().optional(),
      })
      .safeParse(await readJsonBody(req));

    if (!parsed.success) return sendValidationError(res, parsed.error);

    const updated = await deps.projectRepo.updateSettings(id, parsed.data);
    if (!updated) return sendJson(res, 404, { error: "project_not_found" });

    // Drop the engine's cached throttle overrides so the change applies to the
    // next notification instead of waiting out the cache TTL.
    await deps.redis.native.publish(PUBSUB_CHANNELS.PROJECT_INVALIDATED, id);

    // rateLimitRpm is read through the API's auth cache, which is keyed by token
    // hash rather than project — dropping the whole cache is the only way to
    // pick up a new limit promptly. Project updates are rare admin operations.
    if (parsed.data.rateLimitRpm !== undefined) {
      await deps.redis.native.publish(PUBSUB_CHANNELS.API_KEY_INVALIDATED, "*");
    }

    logger.info({ projectId: id }, "project settings updated");
    sendJson(res, 200, { id });
  }

  // ── POST /v1/projects/:id/keys — createProjectKey ───────────────────
  async function createProjectKey(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const id = ctx.params.id!;
    const parsed = z
      .object({ role: z.enum(["admin", "read_only"]).default("admin") })
      .safeParse(await readJsonBody(req));
    const role = parsed.success ? parsed.data.role : "admin";

    const { randomBytes, createHash } = await import("node:crypto");
    const apiKey = `nk_live_${randomBytes(32).toString("hex")}`;
    const apiKeyHash = createHash("sha256").update(apiKey).digest("hex");

    const key = await deps.projectRepo.createApiKey(id, apiKeyHash, role);
    sendJson(res, 201, { id: key.id, apiKey, role });
  }

  // ── GET /v1/projects/:id/keys — listProjectKeys ─────────────────────
  async function listProjectKeys(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const id = ctx.params.id!;
    const keys = await deps.projectRepo.listApiKeys(id);
    sendJson(res, 200, { keys });
  }

  // ── DELETE /v1/projects/:id/keys/:keyId — deleteProjectKey ──────────
  async function deleteProjectKey(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const { id, keyId } = ctx.params;
    const deleted = await deps.projectRepo.deleteApiKey(id!, keyId!);
    if (!deleted) return sendJson(res, 404, { error: "key_not_found" });

    await deps.redis.native.publish("apikey.invalidated", "*");
    sendJson(res, 204, {});
  }

  // ── GET /v1/system/health — getSystemHealth ──────────────────────────────
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

  // ── GET /v1/system/metrics — getSystemMetrics ────────────────────────────
  async function getSystemMetrics(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const streamMap: Record<string, string> = {
      INBOUND_CRITICAL: STREAMS.INBOUND_CRITICAL,
      INBOUND_NORMAL: STREAMS.INBOUND_NORMAL,
      INBOUND_LOW: STREAMS.INBOUND_LOW,
      ENRICHED_NORMAL: STREAMS.ENRICHED_NORMAL,
      OUTBOUND_CRITICAL: STREAMS.OUTBOUND_CRITICAL,
      OUTBOUND_NORMAL: STREAMS.OUTBOUND_NORMAL,
      OUTBOUND_LOW: STREAMS.OUTBOUND_LOW,
      WORKFLOW_INBOUND: STREAMS.WORKFLOW_INBOUND,
      EVENTS_INBOUND: STREAMS.EVENTS_INBOUND,
      DEAD_LETTER: STREAMS.DEAD_LETTER,
    };

    const streamDepths: Record<string, number> = {};
    for (const [key, realRedisKey] of Object.entries(streamMap)) {
      try {
        const len = await deps.redis.native.xlen(realRedisKey);
        streamDepths[key] = len;
      } catch {
        streamDepths[key] = 0;
      }
    }

    // Scoped to the caller's project: an unscoped count reports every tenant's
    // traffic to whoever asks.
    const totalTasksRes = await deps.db
      .select({ count: sql<number>`count(distinct ${messageLogs.taskId})` })
      .from(messageLogs)
      .where(eq(messageLogs.projectId, ctx.projectId!));
    const deliveredTasksRes = await deps.db
      .select({ count: sql<number>`count(distinct ${messageLogs.taskId})` })
      .from(messageLogs)
      .where(and(eq(messageLogs.projectId, ctx.projectId!), eq(messageLogs.status, "delivered")));

    const total = Number(totalTasksRes[0]?.count ?? 0);
    const delivered = Number(deliveredTasksRes[0]?.count ?? 0);
    const failed = streamDepths.DEAD_LETTER || 0;
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

  // ── GET /v1/dlq — getDLQMessages ─────────────────────────────────────────
  async function getDLQMessages(
    _req: IncomingMessage,
    res: ServerResponse,
    _ctx: RouteContext,
  ): Promise<void> {
    try {
      const rawEntries = await deps.redis.native.xrevrange(
        STREAMS.DEAD_LETTER,
        "+",
        "-",
        "COUNT",
        "50",
      );
      const messages = (rawEntries || []).map(([id, fields]: [string, string[]]) => {
        const fieldMap: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          fieldMap[fields[i]!] = fields[i + 1]!;
        }
        return {
          id,
          eventType: fieldMap.eventType || fieldMap.event_type || "unknown",
          payload: fieldMap.payload ? JSON.parse(fieldMap.payload) : fieldMap,
          error: fieldMap.error || fieldMap.reason || "Dead letter payload",
          timestamp: fieldMap.timestamp || new Date().toISOString(),
        };
      });
      sendJson(res, 200, { messages });
    } catch {
      sendJson(res, 200, { messages: [] });
    }
  }

  // ── POST /v1/dlq/replay — replayDLQMessage ────────────────────────────────
  async function replayDLQMessage(
    req: IncomingMessage,
    res: ServerResponse,
    _ctx: RouteContext,
  ): Promise<void> {
    const body = (await readJsonBody(req).catch(() => ({}))) as any;
    const messageId = body?.id;

    if (!messageId) {
      sendJson(res, 400, { error: "missing_message_id" });
      return;
    }

    try {
      const rawEntries = await deps.redis.native.xrange(STREAMS.DEAD_LETTER, messageId, messageId);
      if (!rawEntries || rawEntries.length === 0 || !rawEntries[0]) {
        sendJson(res, 404, { error: "dlq_message_not_found" });
        return;
      }

      const fields = rawEntries[0][1];
      const fieldMap: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fieldMap[fields[i]!] = fields[i + 1]!;
      }

      const priority = fieldMap.priority || "normal";
      const p = getPriorityBucket(priority);
      const targetStream =
        STREAMS[`INBOUND_${p.toUpperCase()}` as keyof typeof STREAMS] || STREAMS.INBOUND_NORMAL;

      const xaddArgs: string[] = [];
      for (const [k, v] of Object.entries(fieldMap)) {
        xaddArgs.push(k, v);
      }
      await deps.redis.native.xadd(targetStream, "*", ...xaddArgs);
      await deps.redis.native.xdel(STREAMS.DEAD_LETTER, messageId);

      sendJson(res, 200, { success: true, replayedId: messageId });
    } catch (err: any) {
      sendJson(res, 500, { error: "replay_failed", message: err.message });
    }
  }

  // ── DELETE /v1/dlq/:id — deleteDLQMessage ────────────────────────────────
  async function deleteDLQMessage(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const messageId = ctx.params.id;
    if (!messageId) return sendJson(res, 400, { error: "missing_id" });

    try {
      await deps.redis.native.xdel(STREAMS.DEAD_LETTER, messageId);
      sendJson(res, 200, { success: true });
    } catch (err: any) {
      sendJson(res, 500, { error: "delete_failed", message: err.message });
    }
  }

  // ── GET /v1/notifications/scheduled — getScheduledMessages ──────────────
  async function getScheduledMessages(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const limitParam = getQueryParam(ctx, "limit");
    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : 50;
    const cursor = getQueryParam(ctx, "cursor");
    const channel = getQueryParam(ctx, "channel");

    const conditions = [sql`(payload->>'projectId') = ${ctx.projectId!}`];
    if (cursor) {
      conditions.push(sql`task_id > ${cursor}`);
    }
    if (channel) {
      conditions.push(sql`(payload->>'channel') = ${channel}`);
    }

    const rows = await deps.db
      .select()
      .from(scheduledPayloads)
      .where(and(...conditions))
      .orderBy(scheduledPayloads.taskId)
      .limit(limit + 1);

    const hasNext = rows.length > limit;
    const scheduled = hasNext ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasNext && scheduled.length > 0 ? scheduled[scheduled.length - 1]!.taskId : null;

    sendJson(res, 200, { scheduled, nextCursor });
  }

  // ── GET /v1/users/:id/details — getUserDetails ────────────────────────────
  async function getUserDetails(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const userId = ctx.params.id!;
    const user = await deps.userRepo.findRecordById(ctx.projectId!, userId);
    if (!user) return sendJson(res, 404, { error: "user_not_found", id: userId });

    const contacts = await deps.contactRepo.findByUserId(ctx.projectId!, userId);
    const logs = await deps.db
      .select()
      .from(messageLogs)
      .where(eq(messageLogs.projectId, ctx.projectId!))
      .orderBy(desc(messageLogs.timestamp))
      .limit(50);

    sendJson(res, 200, { ...user, contacts, logs });
  }

  // ── Unsubscribe ───────────────────────────────────────────────────────────
  //
  // Both routes are unauthenticated: they are reached from a mail client, which
  // has no API key. The signed token in the URL is the credential and it
  // authorises exactly one thing for one address.

  function sendHtml(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      // Nothing here should be cached by an inbox proxy or shared cache.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(body);
  }

  function escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function page(title: string, message: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#111}
h1{font-size:1.4rem;margin:0 0 .75rem}p{margin:0 0 1rem;color:#444}
button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:6px;background:#111;color:#fff;cursor:pointer}
code{background:#f4f4f5;padding:.1rem .35rem;border-radius:4px}</style>
</head><body><h1>${escapeHtml(title)}</h1>${message}</body></html>`;
  }

  /**
   * GET — the page a human lands on after clicking the link in the mail body.
   *
   * Deliberately does not unsubscribe anything. Corporate mail scanners and
   * link prescanners issue a GET against every URL in a message; performing the
   * opt-out here would unsubscribe people who never clicked. The mutation lives
   * behind the POST.
   */
  async function unsubscribePage(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const cfg = readBaseConfig();
    const token = ctx.query.get("token") ?? "";
    if (!cfg.UNSUBSCRIBE_SECRET) {
      deps.logger.warn(
        "UNSUBSCRIBE_SECRET is not configured — unable to verify unsubscribe tokens",
      );
    }
    const claim = cfg.UNSUBSCRIBE_SECRET
      ? verifyUnsubscribeToken(token, cfg.UNSUBSCRIBE_SECRET)
      : null;

    if (!claim) {
      return sendHtml(
        res,
        400,
        page(
          "This link is not valid",
          "<p>It may have been altered in transit, or this server may have been reconfigured since the message was sent. Replying to the message and asking to be removed will still work.</p>",
        ),
      );
    }

    const what =
      claim.topics.length > 0
        ? `<code>${claim.topics.map(escapeHtml).join("</code>, <code>")}</code> messages`
        : "all messages";

    sendHtml(
      res,
      200,
      page(
        "Unsubscribe",
        `<p>Stop sending ${what} to <code>${escapeHtml(claim.target)}</code>?</p>
<form method="post" action="/v1/unsubscribe?token=${encodeURIComponent(token)}">
<button type="submit">Unsubscribe</button></form>`,
      ),
    );
  }

  /**
   * POST — the real opt-out.
   *
   * Serves two callers with one handler: a mail client doing RFC 8058 one-click
   * (body `List-Unsubscribe=One-Click`, token in the query string, no
   * confirmation possible), and the form on the page above. Neither can carry a
   * CSRF token, and the one-click spec forbids an interstitial, so the signed
   * token is the whole of the authorisation.
   */
  async function unsubscribe(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    // The one-click POST carries `List-Unsubscribe=One-Click` as its body and
    // the token in the query string, so there is nothing here worth reading —
    // but an unread body leaves bytes on a keep-alive socket. Discard it.
    req.resume();

    const cfg = readBaseConfig();
    const token = ctx.query.get("token") ?? "";
    if (!cfg.UNSUBSCRIBE_SECRET) {
      deps.logger.warn(
        "UNSUBSCRIBE_SECRET is not configured — unable to verify unsubscribe tokens",
      );
    }
    const claim = cfg.UNSUBSCRIBE_SECRET
      ? verifyUnsubscribeToken(token, cfg.UNSUBSCRIBE_SECRET)
      : null;

    if (!claim) {
      return sendHtml(
        res,
        400,
        page(
          "This link is not valid",
          "<p>It may have been altered in transit, or this server may have been reconfigured since the message was sent.</p>",
        ),
      );
    }

    const target = normaliseTarget(claim.target);

    try {
      const userRows = await deps.db
        .select({ id: dbUsers.id })
        .from(dbUsers)
        .where(and(eq(dbUsers.projectId, claim.projectId), eq(dbUsers.externalId, claim.userId)))
        .limit(1);
      const internalId = userRows[0]?.id;

      if (claim.topics.length > 0 && internalId) {
        // Scoped opt-out: silence this kind of mail and leave the rest,
        // including anything transactional, working.
        await deps.db
          .insert(userTopicPreferences)
          .values(claim.topics.map((topic) => ({ userId: internalId, topic, enabled: false })))
          .onConflictDoUpdate({
            target: [userTopicPreferences.userId, userTopicPreferences.topic],
            set: { enabled: sql`excluded.enabled` },
          });
      } else {
        // No topic to scope to, or the user record is gone. Either way the
        // request has to be honoured, so fall back to suppressing the address
        // outright — over-honouring an unsubscribe is the safe direction.
        await deps.db
          .insert(suppressions)
          .values({
            projectId: claim.projectId,
            channel: claim.channel as any,
            target,
            reason: "unsubscribed",
            source: "unsubscribe-link",
          })
          .onConflictDoNothing();
      }

      logger.info(
        {
          projectId: claim.projectId,
          channel: claim.channel,
          topics: claim.topics,
          scoped: claim.topics.length > 0 && Boolean(internalId),
        },
        "unsubscribe honoured",
      );
    } catch (err) {
      // A 5xx here means the mail client reports failure and, worse, the person
      // believes they have opted out when they have not.
      logger.error({ err, projectId: claim.projectId }, "unsubscribe failed to apply");
      return sendHtml(
        res,
        500,
        page(
          "Something went wrong",
          "<p>We could not record that just now. Please try again in a moment.</p>",
        ),
      );
    }

    sendHtml(
      res,
      200,
      page(
        "You're unsubscribed",
        `<p>We've stopped sending ${
          claim.topics.length > 0 ? "these messages" : "messages"
        } to <code>${escapeHtml(claim.target)}</code>. It may take a few minutes to take effect for mail already on its way.</p>`,
      ),
    );
  }

  // ── GET /v1/campaigns — listCampaigns ─────────────────────────────────────
  //
  // One row per campaign label, newest activity first, with support for filtering
  // by search keyword, channel, date range, and minimum message counts.
  async function listCampaigns(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const limitParam = parseInt(getQueryParam(ctx, "limit") || "20", 10);
    const limit = isNaN(limitParam) ? 20 : Math.min(Math.max(limitParam, 1), 100);
    const search = getQueryParam(ctx, "search")?.trim();
    const channel = getQueryParam(ctx, "channel")?.trim();
    const since = getQueryParam(ctx, "since")?.trim();
    const until = getQueryParam(ctx, "until")?.trim();
    const minMessagesParam = parseInt(getQueryParam(ctx, "minMessages") || "", 10);
    const minMessages = isNaN(minMessagesParam) ? undefined : Math.max(minMessagesParam, 1);

    const conditions = [
      eq(messageLogs.projectId, ctx.projectId!),
      isNotNull(messageLogs.campaignId),
    ];

    if (search) {
      conditions.push(like(messageLogs.campaignId, `%${search}%`));
    }
    if (channel) {
      conditions.push(eq(messageLogs.channel, channel as any));
    }
    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) {
        conditions.push(gte(messageLogs.timestamp, sinceDate));
      }
    }
    if (until) {
      const untilDate = new Date(until);
      if (!isNaN(untilDate.getTime())) {
        conditions.push(lte(messageLogs.timestamp, untilDate));
      }
    }

    let query = deps.db
      .select({
        campaign: messageLogs.campaignId,
        messages: sql<number>`count(distinct ${messageLogs.taskId})`,
        firstSentAt: sql<string>`min(${messageLogs.timestamp})`,
        lastActivityAt: sql<string>`max(${messageLogs.timestamp})`,
      })
      .from(messageLogs)
      .where(and(...conditions))
      .groupBy(messageLogs.campaignId)
      .orderBy(desc(sql`max(${messageLogs.timestamp})`))
      .limit(limit);

    if (minMessages !== undefined) {
      query = query.having(gte(sql`count(distinct ${messageLogs.taskId})`, minMessages)) as any;
    }

    const rows = await query;

    sendJson(res, 200, {
      campaigns: rows.map((r: any) => ({
        campaign: r.campaign,
        messages: Number(r.messages ?? 0),
        firstSentAt: r.firstSentAt,
        lastActivityAt: r.lastActivityAt,
      })),
    });
  }

  // ── GET /v1/campaigns/:campaign/stats — getCampaignStats ──────────────────
  //
  // The delivery funnel for one campaign, in a single grouped scan.
  //
  // Every figure counts *distinct tasks*, not rows: a task accumulates a
  // dispatch row, an attempt row, and any number of engagement rows, so
  // counting rows would inflate every number by a different factor. Opening the
  // same email twice is one person who opened it.
  async function getCampaignStats(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const campaign = ctx.params.campaign;
    if (!campaign) return sendJson(res, 400, { error: "missing_campaign" });

    const rows = await deps.db
      .select({
        channel: messageLogs.channel,
        kind: messageLogs.kind,
        status: messageLogs.status,
        tasks: sql<number>`count(distinct ${messageLogs.taskId})`,
      })
      .from(messageLogs)
      .where(and(eq(messageLogs.projectId, ctx.projectId!), eq(messageLogs.campaignId, campaign)))
      .groupBy(messageLogs.channel, messageLogs.kind, messageLogs.status);

    if (rows.length === 0) {
      return sendJson(res, 404, {
        error: "not_found",
        message: `No messages recorded for campaign '${campaign}'`,
      });
    }

    const ENGAGEMENT = ["opened", "clicked", "bounced", "complained", "unsubscribed"] as const;
    type Engagement = (typeof ENGAGEMENT)[number];

    const blank = () => ({
      sent: 0,
      delivered: 0,
      failed: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
      complained: 0,
      unsubscribed: 0,
    });

    const byChannel = new Map<string, ReturnType<typeof blank>>();
    for (const row of rows as any[]) {
      const bucket = byChannel.get(row.channel) ?? blank();
      const n = Number(row.tasks ?? 0);

      if (ENGAGEMENT.includes(row.kind as Engagement)) {
        bucket[row.kind as Engagement] += n;
      } else {
        // A delivery row. `sent` is every task that reached a provider at all,
        // which is the denominator a bounce rate is measured against.
        bucket.sent += n;
        if (row.status === "delivered") bucket.delivered += n;
        if (row.status === "failed") bucket.failed += n;
      }
      byChannel.set(row.channel, bucket);
    }

    const total = blank();
    for (const bucket of byChannel.values()) {
      for (const key of Object.keys(total) as (keyof ReturnType<typeof blank>)[]) {
        total[key] += bucket[key];
      }
    }

    const pct = (n: number, d: number) => (d > 0 ? Number(((n / d) * 100).toFixed(2)) : null);

    // Engagement only exists where a provider reports it back. Saying "0% open
    // rate" for an SMS blast, or for email with no webhook wired, reads as a
    // failed campaign rather than an untracked one.
    const channels = [...byChannel.keys()];
    const engagementCapable = channels.some((c) => c === "email");
    const sawEngagement = ENGAGEMENT.some((k) => total[k] > 0);

    const warnings: string[] = [];
    if (!engagementCapable) {
      warnings.push(
        `Opens and clicks are not reported on ${channels.join(", ")} — those figures are not tracked, not zero.`,
      );
    } else if (!sawEngagement && total.delivered > 0) {
      warnings.push(
        "No engagement events recorded. If the provider webhook is not configured, opens and clicks cannot be tracked and will stay at zero.",
      );
    }

    sendJson(res, 200, {
      campaign,
      totals: {
        ...total,
        deliveryRate: pct(total.delivered, total.sent),
        openRate: pct(total.opened, total.delivered),
        clickRate: pct(total.clicked, total.delivered),
        bounceRate: pct(total.bounced, total.sent),
        complaintRate: pct(total.complained, total.delivered),
        unsubscribeRate: pct(total.unsubscribed, total.delivered),
      },
      byChannel: Object.fromEntries(byChannel),
      engagementTracked: engagementCapable && sawEngagement,
      warnings,
    });
  }

  // ── GET /v1/suppressions — listSuppressions ───────────────────────────────
  async function listSuppressions(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const limitParam = parseInt(getQueryParam(ctx, "limit") || "100", 10);
    const limit = isNaN(limitParam) ? 100 : Math.min(Math.max(limitParam, 1), 500);
    const channel = getQueryParam(ctx, "channel");
    const reason = getQueryParam(ctx, "reason");
    const target = getQueryParam(ctx, "target");

    const conditions = [eq(suppressions.projectId, ctx.projectId!)];
    if (channel) conditions.push(eq(suppressions.channel, channel as any));
    if (reason) conditions.push(eq(suppressions.reason, reason));
    if (target) conditions.push(like(suppressions.target, `%${target.toLowerCase().trim()}%`));

    const rows = await deps.db
      .select()
      .from(suppressions)
      .where(and(...conditions))
      .orderBy(desc(suppressions.createdAt))
      .limit(limit);

    sendJson(res, 200, { suppressions: rows });
  }

  // ── POST /v1/suppressions — createSuppression ─────────────────────────────
  async function createSuppression(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const parsed = z
      .object({
        channel: ContactChannelSchema,
        target: z.string().min(1),
        reason: z.enum(["unsubscribed", "complained", "bounced", "manual"]).default("manual"),
      })
      .safeParse(await readJsonBody(req));
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const { channel, target, reason } = parsed.data;
    await deps.db
      .insert(suppressions)
      .values({
        projectId: ctx.projectId!,
        channel,
        target: normaliseTarget(target),
        reason,
        source: "api",
      })
      .onConflictDoNothing();

    sendJson(res, 201, { channel, target: normaliseTarget(target), reason });
  }

  // ── DELETE /v1/suppressions/:channel/:target — deleteSuppression ──────────
  //
  // Re-enables sending to an address. Intentionally manual: a suppression
  // records that somebody asked not to be contacted, and undoing that should be
  // a decision rather than a retry.
  async function deleteSuppression(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const { channel, target } = ctx.params;
    if (!channel || !target) return sendJson(res, 400, { error: "missing_channel_or_target" });

    await deps.db
      .delete(suppressions)
      .where(
        and(
          eq(suppressions.projectId, ctx.projectId!),
          eq(suppressions.channel, channel as any),
          eq(suppressions.target, normaliseTarget(decodeURIComponent(target))),
        ),
      );

    sendNoContent(res);
  }

  return {
    syncTemplates,
    addUser,
    updateUser,
    deleteUser,
    addContact,
    deleteContact,
    notify,
    cancelNotification,
    triggerWorkflow,
    ingestEvent,
    getEventsStream,
    getNotificationLogs,
    getNotificationStatus,
    getUser,
    getUserDetails,
    unsubscribePage,
    unsubscribe,
    listCampaigns,
    getCampaignStats,
    listSuppressions,
    createSuppression,
    deleteSuppression,
    getUserPreferences,
    updateUserPreferences,
    listTemplates,
    getTemplate,
    deleteTemplate,
    createWorkflow,
    listWorkflows,
    getWorkflow,
    cancelWorkflow,
    listUsers,
    getUserContacts,
    listSegments,
    listProjects,
    deleteProject,
    updateProject,
    createProjectKey,
    listProjectKeys,
    deleteProjectKey,
    getSystemHealth,
    getSystemMetrics,
    getDLQMessages,
    replayDLQMessage,
    deleteDLQMessage,
    getScheduledMessages,
  };
}
