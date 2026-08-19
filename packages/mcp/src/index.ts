#!/usr/bin/env node
/**
 * notifkit MCP server (stdio).
 *
 * Exposes the notifkit HTTP API as MCP tools so a terminal agent can send
 * notifications, manage templates and users, and drive workflows.
 *
 * stdout is the JSON-RPC transport — never write to it. Diagnostics go to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NotifkitApi } from "./client.js";
import { registerTools } from "./tools.js";

const DEFAULT_URL = "http://localhost:3000";

export function createServer(options: {
  baseUrl: string;
  apiKey: string;
  projectId?: string;
}): McpServer {
  const server = new McpServer(
    { name: "notifkit", version: "0.0.1" },
    {
      instructions:
        "Tools for notifkit, a self-hosted notification service.\n\n" +
        "Sending: send_campaign takes a list of email addresses directly and is the right tool when the " +
        "user supplies recipients themselves. send_notification targets existing users, a segment, or a " +
        "topic. Both accept a `campaign` label — set one on any send whose results might be asked about " +
        "later, and tell the user the label, because without it the send cannot be reported on " +
        "afterwards. Multi-step sequences (drips, onboarding, reminders) are workflows: create_workflow " +
        "defines one, trigger_workflow runs it per user.\n\n" +
        "Reporting: get_campaign_stats answers 'how did that send do?'. Pass on its `warnings` verbatim — " +
        "an untracked open rate is not a zero open rate.\n\n" +
        "Discover ids with list_campaigns, list_segments, list_templates, and list_workflows rather than " +
        "guessing them.\n\n" +
        "Every send reaches real people and cannot be recalled, so confirm the audience before " +
        "broadcasting. Never remove a suppression to improve a delivery figure: suppressions record that " +
        "somebody asked not to be contacted.",
    },
  );

  registerTools(server, new NotifkitApi(options));
  return server;
}

async function main(): Promise<void> {
  const baseUrl = process.env["NOTIFKIT_URL"] ?? DEFAULT_URL;
  const apiKey = process.env["NOTIFKIT_API_KEY"];
  const projectId = process.env["NOTIFKIT_PROJECT_ID"];

  if (!apiKey) {
    console.error(
      "notifkit-mcp: NOTIFKIT_API_KEY is not set.\n" +
        "  Set it to a project API key, or to your ADMIN_API_KEY together with NOTIFKIT_PROJECT_ID.\n" +
        `  NOTIFKIT_URL defaults to ${DEFAULT_URL}.`,
    );
    process.exit(1);
  }

  const server = createServer({ baseUrl, apiKey, projectId });
  await server.connect(new StdioServerTransport());

  console.error(`notifkit-mcp: connected, talking to ${baseUrl}`);
}

main().catch((error: unknown) => {
  console.error("notifkit-mcp: fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
