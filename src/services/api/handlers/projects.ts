import { randomBytes, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PUBSUB_CHANNELS, UpdateProjectSchema } from "@/contracts/index.js";
import { readJsonBody, sendJson, sendNoContent, sendValidationError } from "../http.js";
import type { RouteContext } from "../router.js";
import { z } from "zod";
import { type Deps, isUuid } from "./shared.js";

export function createProjectsHandlers(deps: Deps) {
  const { logger } = deps;

  async function listProjects(
    req: IncomingMessage,
    res: ServerResponse,
    _ctx: RouteContext,
  ): Promise<void> {
    const projects = await deps.projectRepo.list();
    sendJson(res, 200, { projects });
  }

  async function deleteProject(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const id = ctx.params.id!;
    const deleted = isUuid(id) && (await deps.projectRepo.delete(id));
    if (!deleted) return sendJson(res, 404, { error: "project_not_found" });

    sendNoContent(res);
  }

  async function updateProject(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const id = ctx.params.id!;
    const parsed = UpdateProjectSchema.safeParse(await readJsonBody(req));

    if (!parsed.success) return sendValidationError(res, parsed.error);

    const updated = isUuid(id) && (await deps.projectRepo.updateSettings(id, parsed.data));
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

    // A key for a project that does not exist would fail the foreign key.
    if (!isUuid(id) || !(await deps.projectRepo.findThrottleSettings(id))) {
      return sendJson(res, 404, { error: "project_not_found" });
    }

    const apiKey = `nk_live_${randomBytes(32).toString("hex")}`;
    const apiKeyHash = createHash("sha256").update(apiKey).digest("hex");

    const key = await deps.projectRepo.createApiKey(id, apiKeyHash, role);
    sendJson(res, 201, { id: key.id, apiKey, role });
  }

  async function listProjectKeys(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const id = ctx.params.id!;
    if (!isUuid(id)) return sendJson(res, 404, { error: "project_not_found" });
    const keys = await deps.projectRepo.listApiKeys(id);
    sendJson(res, 200, { keys });
  }

  async function deleteProjectKey(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const { id, keyId } = ctx.params;
    const deleted = isUuid(id) && isUuid(keyId) && (await deps.projectRepo.deleteApiKey(id, keyId));
    if (!deleted) return sendJson(res, 404, { error: "key_not_found" });

    await deps.redis.native.publish(PUBSUB_CHANNELS.API_KEY_INVALIDATED, "*");
    sendNoContent(res);
  }

  return {
    listProjects,
    deleteProject,
    updateProject,
    createProjectKey,
    listProjectKeys,
    deleteProjectKey,
  };
}
