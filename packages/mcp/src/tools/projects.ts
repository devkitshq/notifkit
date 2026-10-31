import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NotifkitApi } from "../client.js";
import { handler } from "./shared.js";

export function registerProjectsTools(server: McpServer, api: NotifkitApi): void {
  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List all projects configured in this Notifkit deployment.",
      annotations: { title: "List projects", readOnlyHint: true },
    },
    handler(async () => api.get("/v1/projects")),
  );

  server.registerTool(
    "create_project",
    {
      title: "Create a project",
      description:
        "Create a new tenant project with a name and generate its initial admin API key.",
      inputSchema: {
        name: z.string().min(1).describe("Project name."),
      },
      annotations: { title: "Create a project", readOnlyHint: false },
    },
    handler(async (args) => api.post("/v1/projects", { name: args.name })),
  );

  server.registerTool(
    "update_project",
    {
      title: "Update a project",
      description: "Update project settings including rate limits and throttle limits.",
      inputSchema: {
        id: z.string().min(1).describe("Project id."),
        rateLimitRpm: z.number().nullable().optional().describe("Requests per minute limit."),
        throttleLimit: z
          .number()
          .nullable()
          .optional()
          .describe("Max notifications per throttle window."),
        throttleWindowHours: z.number().nullable().optional().describe("Throttle window in hours."),
      },
      annotations: { title: "Update a project", readOnlyHint: false, idempotentHint: true },
    },
    handler(async ({ id, ...settings }) =>
      api.patch(`/v1/projects/${encodeURIComponent(id)}`, settings),
    ),
  );

  server.registerTool(
    "delete_project",
    {
      title: "Delete a project",
      description: "Permanently delete a project and its associated resources.",
      inputSchema: {
        id: z.string().min(1).describe("Project id to delete."),
      },
      annotations: {
        title: "Delete a project",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    handler(async (args) => {
      await api.delete(`/v1/projects/${encodeURIComponent(args.id)}`);
      return `Deleted project ${args.id}.`;
    }),
  );

  server.registerTool(
    "list_project_keys",
    {
      title: "List project API keys",
      description: "List all API keys created for a specific project.",
      inputSchema: {
        projectId: z.string().min(1).describe("Project id."),
      },
      annotations: { title: "List project API keys", readOnlyHint: true },
    },
    handler(async (args) => api.get(`/v1/projects/${encodeURIComponent(args.projectId)}/keys`)),
  );

  server.registerTool(
    "create_project_key",
    {
      title: "Create a project API key",
      description: "Generate a new API key with 'admin' or 'read_only' role for a project.",
      inputSchema: {
        projectId: z.string().min(1).describe("Project id."),
        role: z
          .enum(["admin", "read_only"])
          .optional()
          .describe("Role for this API key. Defaults to 'admin'."),
      },
      annotations: { title: "Create a project API key", readOnlyHint: false },
    },
    handler(async (args) =>
      api.post(`/v1/projects/${encodeURIComponent(args.projectId)}/keys`, {
        role: args.role ?? "admin",
      }),
    ),
  );

  server.registerTool(
    "delete_project_key",
    {
      title: "Delete a project API key",
      description: "Revoke and delete an API key for a project.",
      inputSchema: {
        projectId: z.string().min(1).describe("Project id."),
        keyId: z.string().min(1).describe("Key id to revoke."),
      },
      annotations: {
        title: "Delete a project API key",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    handler(async (args) => {
      await api.delete(
        `/v1/projects/${encodeURIComponent(args.projectId)}/keys/${encodeURIComponent(args.keyId)}`,
      );
      return `Deleted API key ${args.keyId} for project ${args.projectId}.`;
    }),
  );
}
