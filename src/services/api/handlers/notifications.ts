import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  NotifyRequestSchema,
  type NotificationRequestedPayload,
  type NotificationTarget,
  buildStreamEvent,
} from "@/contracts/index.js";
import { readJsonBody, sendJson, sendValidationError } from "../http.js";
import type { RouteContext } from "../router.js";
import { globalEmitter, getPriorityBucket } from "@/shared/index.js";
import { metrics } from "@/metrics/index.js";
import { eq, desc, and, sql, like, or, inArray } from "drizzle-orm";
import { messageLogs, scheduledPayloads } from "@/db/schema.js";
import {
  type Deps,
  type InlineUserLike,
  persistUsers,
  encodeLogCursor,
  decodeLogCursor,
  contains,
  getQueryParam,
  parseLimit,
} from "./shared.js";

export function createNotificationsHandlers(deps: Deps) {
  const { logger } = deps;

  async function notify(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const rawBody = await readJsonBody(req);
    const parsed = NotifyRequestSchema.safeParse(rawBody);

    if (!parsed.success) return sendValidationError(res, parsed.error);
    const body = parsed.data;

    // Resolve the (unresolved) target. Inline users are synced first.
    let targets: NotificationTarget[] = [];
    const inlineUsersToSync: InlineUserLike[] = [];
    if (body.user !== undefined) {
      const users = Array.isArray(body.user) ? body.user : [body.user];
      for (const u of users) {
        if (typeof u === "string") {
          targets.push({ type: "user", userId: u });
        } else {
          inlineUsersToSync.push(u);
          targets.push({ type: "user", userId: u.id });
        }
      }

      // A failure must reach the caller: queued without its user, the send is dropped.
      if (inlineUsersToSync.length > 0) {
        await persistUsers(deps, inlineUsersToSync, ctx.projectId!);
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
          // Only a caller's own key: the enricher keeps those for the full
          // 24-hour window, and dedupes everything else on the event id.
          ...(req.headers["x-idempotency-key"] ? { idempotencyKey: notificationId } : {}),
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

    logger.debug({ count: targets.length, priority: p }, "notification requested");
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

  async function getNotificationLogs(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const limit = parseLimit(ctx, 50);
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
          like(messageLogs.taskId, contains(search)),
          like(messageLogs.templateId, contains(search)),
          like(messageLogs.providerMessageId, contains(search)),
          like(messageLogs.campaignId, contains(search)),
        )!,
      );
    }

    // One entry per task, newest activity first. Rows are scanned in
    // (timestamp, id) order — a batch of deliveries shares one timestamp, so
    // the timestamp alone cannot mark a place — and a task is listed at its
    // newest row. The cursor is that row for the first task of the next page,
    // and any task with a row newer than the cursor was listed on an earlier
    // page. Paging on a millisecond timestamp over `limit * 2` rows skipped
    // tasks that shared a timestamp and dropped any that did not fit the slice.
    const start = decodeLogCursor(cursor);
    const tsText = sql<string>`${messageLogs.timestamp}::text`;
    const position = (ts: string, id: string) => sql`(${ts}::timestamptz, ${id}::uuid)`;
    const rowKey = sql`(${messageLogs.timestamp}, ${messageLogs.id})`;

    const order: string[] = [];
    const rowsByTask = new Map<string, (typeof messageLogs.$inferSelect)[]>();
    let nextCursor: string | null = null;
    let scanFrom = start;
    let inclusive = true;
    const batchSize = Math.max(limit * 4, 50);

    for (let round = 0; round < 50 && nextCursor === null; round++) {
      const batch = await deps.db
        .select({ row: messageLogs, ts: tsText })
        .from(messageLogs)
        .where(
          and(
            ...conditions,
            scanFrom
              ? sql`${rowKey} ${inclusive ? sql`<=` : sql`<`} ${position(scanFrom.ts, scanFrom.id)}`
              : undefined,
          ),
        )
        .orderBy(desc(messageLogs.timestamp), desc(messageLogs.id))
        .limit(batchSize);

      const fresh = [...new Set(batch.map((b) => b.row.taskId))].filter((t) => !rowsByTask.has(t));
      const listedEarlier = new Set<string>();
      if (start && fresh.length > 0) {
        const newer = await deps.db
          .selectDistinct({ taskId: messageLogs.taskId })
          .from(messageLogs)
          .where(
            and(
              ...conditions,
              inArray(messageLogs.taskId, fresh),
              sql`${rowKey} > ${position(start.ts, start.id)}`,
            ),
          );
        for (const r of newer) listedEarlier.add(r.taskId);
      }

      for (const { row, ts } of batch) {
        if (listedEarlier.has(row.taskId)) continue;
        let rows = rowsByTask.get(row.taskId);
        if (!rows) {
          if (order.length === limit) {
            nextCursor = encodeLogCursor(ts, row.id);
            break;
          }
          rows = [];
          order.push(row.taskId);
          rowsByTask.set(row.taskId, rows);
        }
        rows.push(row);
      }

      if (batch.length < batchSize) break;
      const last = batch[batch.length - 1]!;
      scanFrom = { ts: last.ts, id: last.row.id };
      inclusive = false;
    }

    // The latest outcome, rather than the dispatch that preceded it.
    const deduplicatedLogs = order.map((taskId) => {
      const rows = rowsByTask.get(taskId)!;
      return rows.find((r) => r.status !== "dispatched") ?? rows[0]!;
    });

    sendJson(res, 200, { logs: deduplicatedLogs, nextCursor });
  }

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

  async function getScheduledMessages(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const limit = parseLimit(ctx, 50);
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

  return {
    notify,
    cancelNotification,
    getNotificationLogs,
    getNotificationStatus,
    getScheduledMessages,
  };
}
