import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildStreamEvent,
  CreateWorkflowSchema,
  TriggerWorkflowSchema,
} from "@/contracts/index.js";
import { readJsonBody, sendJson, sendNoContent, sendValidationError } from "../http.js";
import type { RouteContext } from "../router.js";
import { workflowDefinitions } from "@/db/schema.js";
import { type Deps, persistUsers, isUuid, getQueryParam, parseLimit } from "./shared.js";

export function createWorkflowsHandlers(deps: Deps) {
  const { logger } = deps;

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
      // Logged, not returned: driver errors name tables, constraints and values.
      deps.logger.error({ err: error }, "Failed to create workflow definition");
      sendJson(res, 500, { error: "internal_error" });
    }
  }

  async function listWorkflows(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const limit = parseLimit(ctx, undefined);
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

  async function getWorkflow(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const instanceId = ctx.params.id!;
    const workflow = isUuid(instanceId)
      ? await deps.workflowRepo.getInstance(ctx.projectId!, instanceId)
      : null;
    if (!workflow) return sendJson(res, 404, { error: "workflow_not_found", id: instanceId });

    sendJson(res, 200, workflow);
  }

  async function cancelWorkflow(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const instanceId = ctx.params.id!;
    const canceled =
      isUuid(instanceId) && (await deps.workflowRepo.cancelInstance(ctx.projectId!, instanceId));
    if (!canceled) return sendJson(res, 400, { error: "workflow_not_cancelable", id: instanceId });

    logger.info({ instanceId }, "workflow canceled");
    sendNoContent(res);
  }

  return {
    triggerWorkflow,
    createWorkflow,
    listWorkflows,
    getWorkflow,
    cancelWorkflow,
  };
}
