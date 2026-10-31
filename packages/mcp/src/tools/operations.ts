import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NotifkitApi } from "../client.js";
import { handler } from "./shared.js";

export function registerOperationsTools(server: McpServer, api: NotifkitApi): void {
  server.registerTool(
    "get_system_health",
    {
      title: "Get system health",
      description:
        "Report the health of the notifkit deployment: queue depth, worker state, and dependency status. " +
        "Call this first when sends appear queued but never delivered, to tell an outage apart from a " +
        "preference or quiet-hours filter.",
      annotations: { title: "Get system health", readOnlyHint: true },
    },
    handler(async () => api.get("/v1/system/health")),
  );

  server.registerTool(
    "get_dead_letters",
    {
      title: "Get dead-lettered messages",
      description:
        "List messages that exhausted their retries and landed in the dead-letter queue, with the error " +
        "that put them there. Use this to investigate deliveries that failed permanently; " +
        "replay_dead_letter puts one back on the queue.",
      annotations: { title: "Get dead-lettered messages", readOnlyHint: true },
    },
    handler(async () => api.get("/v1/dlq")),
  );

  server.registerTool(
    "replay_dead_letter",
    {
      title: "Replay a dead-lettered message",
      description:
        "Re-queue one dead-lettered message for delivery. Only replay after the cause of the original " +
        "failure is fixed, or it will simply fail again — check get_dead_letters for the recorded error " +
        "first. Replaying sends a real notification to a real person.",
      inputSchema: {
        id: z.string().min(1).describe("Dead-letter entry id from get_dead_letters."),
      },
      annotations: {
        title: "Replay a dead-lettered message",
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    handler(async (args) => api.post("/v1/dlq/replay", { id: args.id })),
  );

  server.registerTool(
    "delete_dead_letter",
    {
      title: "Delete a dead-lettered message",
      description: "Permanently delete/dismiss a dead-letter message from the DLQ by its entry ID.",
      inputSchema: {
        id: z.string().min(1).describe("Dead-letter entry id from get_dead_letters."),
      },
      annotations: {
        title: "Delete a dead-letter message",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    handler(async (args) => {
      await api.delete(`/v1/dlq/${encodeURIComponent(args.id)}`);
      return `Deleted dead letter message ${args.id}.`;
    }),
  );

  server.registerTool(
    "get_system_metrics",
    {
      title: "Get system stream metrics",
      description:
        "Report queue depths across all Redis streams and delivery stats for the project.",
      annotations: { title: "Get system stream metrics", readOnlyHint: true },
    },
    handler(async () => api.get("/v1/system/metrics")),
  );
}
