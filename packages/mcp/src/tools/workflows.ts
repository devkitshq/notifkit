import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NotifkitApi } from "../client.js";
import { handler } from "./shared.js";

export function registerWorkflowsTools(server: McpServer, api: NotifkitApi): void {
  server.registerTool(
    "create_workflow",
    {
      title: "Create a workflow",
      description:
        "Define a named multi-step sequence — the way to build a drip, an onboarding series, or a reminder " +
        "chain rather than a single send. Steps run in order and are one of: `notify` (send, using the " +
        "same fields as send_notification), `wait` (pause for a duration like '1h' or '3d'), or " +
        "`waitForEvent` (block until ingest_event reports a named event, with an optional timeout). A " +
        "notify step with no target inherits the user the instance was triggered for. Creating a workflow " +
        "does not run it — call trigger_workflow per user.",
      inputSchema: {
        name: z.string().min(1).describe("Workflow name, used later by trigger_workflow."),
        steps: z
          .array(
            z.union([
              z.object({
                action: z.literal("notify"),
                payload: z
                  .record(z.string(), z.unknown())
                  .describe(
                    "Same shape as send_notification's arguments. Omit the target to use the instance's own user.",
                  ),
              }),
              z.object({
                action: z.literal("wait"),
                duration: z.string().describe("Duration string, e.g. '5m', '1h', '3d'."),
              }),
              z.object({
                action: z.literal("waitForEvent"),
                event: z.string().describe("Event name to wait for, as passed to ingest_event."),
                options: z
                  .object({ timeout: z.string().optional().describe("e.g. '24h'.") })
                  .optional()
                  .describe("Give a timeout so the instance cannot wait forever."),
              }),
            ]),
          )
          .min(1)
          .describe("Ordered steps."),
      },
      annotations: { title: "Create a workflow", readOnlyHint: false, idempotentHint: true },
    },
    handler(async (args) => api.post("/v1/workflows", args)),
  );

  server.registerTool(
    "list_workflows",
    {
      title: "List workflows",
      description:
        "List registered workflow definitions and their steps. Call this to find the name to pass to " +
        "trigger_workflow, or to check a sequence before triggering it. Supports filtering by search keyword.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum number of workflow definitions to return."),
        search: z
          .string()
          .optional()
          .describe("Filter workflow definitions whose name contains this search keyword."),
      },
      annotations: { title: "List workflows", readOnlyHint: true },
    },
    handler(async (args) => api.get("/v1/workflows", args)),
  );

  server.registerTool(
    "trigger_workflow",
    {
      title: "Trigger a workflow",
      description:
        "Start one run of a registered workflow, optionally for a specific user, and return the instance " +
        "id. Each call starts an independent instance, so triggering the same workflow twice for one user " +
        "enrols them twice. Track the returned instance with get_workflow_run.",
      inputSchema: {
        name: z.string().min(1).describe("Name of the workflow to run."),
        user: z
          .string()
          .min(1)
          .optional()
          .describe("User id this run is for. Notify steps default to them."),
        input: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Data made available to the run's steps."),
      },
      annotations: { title: "Trigger a workflow", readOnlyHint: false, idempotentHint: false },
    },
    handler(async (args) => api.post("/v1/workflows/trigger", args)),
  );

  server.registerTool(
    "get_workflow_run",
    {
      title: "Get a workflow run",
      description:
        "Fetch one workflow instance by id: which step it is on, its status, and what it is waiting for. " +
        "Use this to check on a run started by trigger_workflow.",
      inputSchema: { instanceId: z.string().min(1).describe("Workflow instance id.") },
      annotations: { title: "Get a workflow run", readOnlyHint: true },
    },
    handler(async (args) =>
      api.get(`/v1/workflows/instances/${encodeURIComponent(args.instanceId)}`),
    ),
  );

  server.registerTool(
    "cancel_workflow_run",
    {
      title: "Cancel a workflow run",
      description:
        "Stop a running or suspended workflow instance so its remaining steps never fire. This does not " +
        "recall notifications already sent, and it cannot be undone — confirm with the user before " +
        "cancelling a run you did not start in this session.",
      inputSchema: { instanceId: z.string().min(1).describe("Workflow instance id to cancel.") },
      annotations: {
        title: "Cancel a workflow run",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    handler(async (args) => {
      await api.request("DELETE", `/v1/workflows/instances/${encodeURIComponent(args.instanceId)}`);
      return `Cancelled workflow instance ${args.instanceId}.`;
    }),
  );

  server.registerTool(
    "ingest_event",
    {
      title: "Ingest an event",
      description:
        "Report that something happened in your product. Workflow instances parked on a matching " +
        "`waitForEvent` step resume. Call this to unblock a waiting sequence, e.g. emitting 'order.paid' " +
        "so an abandoned-cart workflow stops before its reminder fires.",
      inputSchema: {
        name: z.string().min(1).describe("Event name, matching a workflow's waitForEvent step."),
        properties: z
          .record(z.string(), z.unknown())
          .describe("Event payload. Include the user id the event is about."),
      },
      annotations: { title: "Ingest an event", readOnlyHint: false, idempotentHint: false },
    },
    handler(async (args) => api.post("/v1/events", args)),
  );
}
