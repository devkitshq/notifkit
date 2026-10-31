import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AddUserSchema,
  UpdateUserSchema,
  BatchAddContactsSchema,
  ContactChannelSchema,
  PreferencesSchema,
} from "@/contracts/index.js";
import { readJsonBody, sendJson, sendNoContent, sendValidationError } from "../http.js";
import type { RouteContext } from "../router.js";
import { eq, desc, and, inArray } from "drizzle-orm";
import { messageLogs, deliveryOutbox } from "@/db/schema.js";
import { type Deps, contactsOf, persistUsers, getQueryParam, parseLimit } from "./shared.js";

export function createUsersHandlers(deps: Deps) {
  const { logger } = deps;

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
      email: patch.email?.[0] ?? patch.contacts?.find((c) => c.channel === "email")?.target,
      segments: patch.segments,
      preferences: patch.preferences,
    });
    if (!updated) return sendJson(res, 404, { error: "user_not_found", id: userId });

    // New contact values in the patch are added (existing ones are kept).
    for (const c of contactsOf({ id: userId, ...patch })) {
      if (c.preferences) {
        await deps.contactRepo.upsert(ctx.projectId!, userId, c.channel, c.target, c.preferences);
      } else {
        await deps.contactRepo.upsert(ctx.projectId!, userId, c.channel, c.target);
      }
    }
    logger.info({ userId }, "user updated");
    sendJson(res, 200, { id: userId });
  }

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

  async function addContact(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const userId = ctx.params.id!;
    const body = await readJsonBody(req);
    const parsed = BatchAddContactsSchema.safeParse(body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const user = await deps.userRepo.findById(ctx.projectId!, userId);
    if (!user) return sendJson(res, 404, { error: "user_not_found", id: userId });

    if (Array.isArray(parsed.data)) {
      const contactsList = parsed.data.map((c) => ({
        userId,
        channel: c.channel,
        target: c.target,
        preferences: c.preferences ?? {},
      }));
      await deps.contactRepo.upsertMany(ctx.projectId!, contactsList);
      logger.info({ userId, count: contactsList.length }, "contacts batch added");
      sendJson(res, 201, {
        userId,
        contacts: contactsList.map((c) => ({ channel: c.channel, target: c.target })),
      });
    } else {
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
  }

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

  async function listUsers(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const limit = parseLimit(ctx, 50);
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

  async function getUserContacts(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const userId = ctx.params.id!;
    const contacts = await deps.contactRepo.findByUserId(ctx.projectId!, userId);
    sendJson(res, 200, { contacts });
  }

  async function listSegments(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const segments = await deps.segmentRepo.listSegments(ctx.projectId!);
    sendJson(res, 200, { segments });
  }

  async function getUserDetails(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const userId = ctx.params.id!;
    const user = await deps.userRepo.findRecordById(ctx.projectId!, userId);
    if (!user) return sendJson(res, 404, { error: "user_not_found", id: userId });

    const contacts = await deps.contactRepo.findByUserId(ctx.projectId!, userId);
    const contactTargets = contacts.map((c) => c.target);
    let logs: any[] = [];
    if (contactTargets.length > 0) {
      // One statement: fetching every task id the addresses were ever sent and
      // passing them back as parameters failed outright past 65,535 sends.
      const sentTo = deps.db
        .select({ taskId: deliveryOutbox.taskId })
        .from(deliveryOutbox)
        .where(inArray(deliveryOutbox.destination, contactTargets));
      logs = await deps.db
        .select()
        .from(messageLogs)
        .where(and(eq(messageLogs.projectId, ctx.projectId!), inArray(messageLogs.taskId, sentTo)))
        .orderBy(desc(messageLogs.timestamp))
        .limit(50);
    }

    sendJson(res, 200, { ...user, contacts, logs });
  }

  return {
    addUser,
    updateUser,
    deleteUser,
    addContact,
    deleteContact,
    getUser,
    getUserDetails,
    getUserPreferences,
    updateUserPreferences,
    listUsers,
    getUserContacts,
    listSegments,
  };
}
