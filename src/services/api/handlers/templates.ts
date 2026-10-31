import type { IncomingMessage, ServerResponse } from "node:http";
import { SyncTemplatesSchema, PUBSUB_CHANNELS } from "@/contracts/index.js";
import { readJsonBody, sendJson, sendNoContent, sendValidationError } from "../http.js";
import type { RouteContext } from "../router.js";
import { type Deps, getQueryParam, parseLimit } from "./shared.js";

export function createTemplatesHandlers(deps: Deps) {
  const { logger } = deps;

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
      await deps.redis.native.publish(
        PUBSUB_CHANNELS.TEMPLATE_INVALIDATED,
        `${ctx.projectId}:${t.id}`,
      );
    }

    logger.info({ synced }, "templates synced");
    sendJson(res, 200, { synced });
  }

  async function listTemplates(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const limit = parseLimit(ctx, undefined);
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

  async function deleteTemplate(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const templateId = ctx.params.id!;
    const deleted = await deps.templateRepo.delete(ctx.projectId!, templateId);
    if (!deleted) return sendJson(res, 404, { error: "template_not_found", id: templateId });

    await deps.redis.native.publish(
      PUBSUB_CHANNELS.TEMPLATE_INVALIDATED,
      `${ctx.projectId}:${templateId}`,
    );
    logger.info({ templateId }, "template deleted");
    sendNoContent(res);
  }

  return {
    syncTemplates,
    listTemplates,
    getTemplate,
    deleteTemplate,
  };
}
