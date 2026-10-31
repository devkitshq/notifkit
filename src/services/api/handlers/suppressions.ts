import type { IncomingMessage, ServerResponse } from "node:http";
import { ContactChannelSchema } from "@/contracts/index.js";
import { readJsonBody, sendJson, sendNoContent, sendValidationError } from "../http.js";
import type { RouteContext } from "../router.js";
import { normaliseTarget } from "@/shared/index.js";
import { eq, desc, and, like } from "drizzle-orm";
import { suppressions } from "@/db/schema.js";
import { z } from "zod";
import { type Deps, contains, getQueryParam, parseLimit } from "./shared.js";

export function createSuppressionsHandlers(deps: Deps) {
  async function listSuppressions(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const limit = parseLimit(ctx, 100, 500);
    const channel = getQueryParam(ctx, "channel");
    const reason = getQueryParam(ctx, "reason");
    const target = getQueryParam(ctx, "target");

    const conditions = [eq(suppressions.projectId, ctx.projectId!)];
    if (channel) conditions.push(eq(suppressions.channel, channel as any));
    if (reason) conditions.push(eq(suppressions.reason, reason));
    if (target) conditions.push(like(suppressions.target, contains(target.toLowerCase().trim())));

    const rows = await deps.db
      .select()
      .from(suppressions)
      .where(and(...conditions))
      .orderBy(desc(suppressions.createdAt))
      .limit(limit);

    sendJson(res, 200, { suppressions: rows });
  }

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
          eq(suppressions.target, normaliseTarget(target)),
        ),
      );

    sendNoContent(res);
  }

  return {
    listSuppressions,
    createSuppression,
    deleteSuppression,
  };
}
