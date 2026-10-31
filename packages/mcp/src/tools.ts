import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NotifkitApi } from "./client.js";
import { registerSendingTools } from "./tools/sending.js";
import { registerTemplatesTools } from "./tools/templates.js";
import { registerUsersTools } from "./tools/users.js";
import { registerWorkflowsTools } from "./tools/workflows.js";
import { registerOperationsTools } from "./tools/operations.js";
import { registerProjectsTools } from "./tools/projects.js";

export function registerTools(server: McpServer, api: NotifkitApi): void {
  registerSendingTools(server, api);
  registerTemplatesTools(server, api);
  registerUsersTools(server, api);
  registerWorkflowsTools(server, api);
  registerOperationsTools(server, api);
  registerProjectsTools(server, api);
}
