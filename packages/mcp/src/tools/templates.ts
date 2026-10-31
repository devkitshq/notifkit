import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NotifkitApi } from "../client.js";
import { CHANNELS, handler, renderContentNode } from "./shared.js";

export function registerTemplatesTools(server: McpServer, api: NotifkitApi): void {
  server.registerTool(
    "list_templates",
    {
      title: "List templates",
      description:
        "List registered templates with their channel and content. Supports filtering by channel, " +
        "topic opt-out category, or limiting result count.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum number of templates to return."),
        channel: z
          .enum(CHANNELS)
          .optional()
          .describe("Only list templates that render for this channel."),
        topic: z.string().optional().describe("Only list templates tagged with this topic."),
      },
      annotations: { title: "List templates", readOnlyHint: true },
    },
    handler(async (args) => api.get("/v1/templates", args)),
  );

  server.registerTool(
    "get_template",
    {
      title: "Get a template",
      description:
        "Fetch one template by id, including its full per-channel content and any AI prompts.",
      inputSchema: { id: z.string().min(1).describe("Template id.") },
      annotations: { title: "Get a template", readOnlyHint: true },
    },
    handler(async (args) => api.get(`/v1/templates/${encodeURIComponent(args.id)}`)),
  );

  server.registerTool(
    "upsert_template",
    {
      title: "Create or update a template",
      description:
        "Create a template, or overwrite an existing one with the same id. Content is a per-channel object " +
        "whose values may contain {{variable}} placeholders filled by send_notification's `data`; escaping " +
        "is decided by the destination field. Because this overwrites, call get_template first when " +
        "editing one that already exists.",
      inputSchema: {
        id: z.string().min(1).describe("Template id, e.g. 'order-shipped'."),
        channel: z.enum(CHANNELS).describe("Channel this template renders for."),
        topic: z
          .union([z.string().min(1), z.array(z.string().min(1))])
          .optional()
          .describe("Topic(s) this template belongs to, used for per-user topic opt-outs."),
        content: z
          .record(z.string(), z.unknown())
          .describe("Channel-specific fields, e.g. { subject, body } for email."),
        aiPrompts: z
          .record(z.string(), z.string())
          .optional()
          .describe("Optional per-field LLM prompts applied before rendering."),
      },
      annotations: {
        title: "Create or update a template",
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    handler(async (args) => api.put("/v1/templates", { templates: [args] })),
  );

  server.registerTool(
    "delete_template",
    {
      title: "Delete a template",
      description: "Permanently delete a registered template by its ID.",
      inputSchema: {
        id: z.string().min(1).describe("Template id to delete."),
      },
      annotations: {
        title: "Delete a template",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    handler(async (args) => {
      await api.delete(`/v1/templates/${encodeURIComponent(args.id)}`);
      return `Deleted template ${args.id}.`;
    }),
  );

  const previewTemplateHandler = async (args: {
    id?: string;
    content?: Record<string, unknown>;
    data?: Record<string, unknown>;
    channel?: (typeof CHANNELS)[number];
  }) => {
    if (!args.id && !args.content) {
      throw new Error("Provide either a template `id` or raw `content` to preview.");
    }

    let rawContent = args.content;
    let templateChannel = args.channel;

    if (args.id) {
      const tmpl = await api.get<{
        id: string;
        channel?: (typeof CHANNELS)[number];
        content: Record<string, unknown>;
      }>(`/v1/templates/${encodeURIComponent(args.id)}`);
      if (!rawContent) {
        rawContent = tmpl.content;
      }
      if (!templateChannel && tmpl.channel) {
        templateChannel = tmpl.channel;
      }
    }

    const vars = args.data ?? {};
    const rendered = renderContentNode(rawContent ?? {}, vars, "text");

    const jsonStr = JSON.stringify(rawContent ?? {});
    const placeholderMatches = Array.from(jsonStr.matchAll(/\{\{\{?(\w+)\}?\}\}/g)).map(
      (m) => m[1]!,
    );
    const placeholders = Array.from(new Set(placeholderMatches));
    const resolvedVariables = placeholders.filter((p) => p in vars);
    const unresolvedVariables = placeholders.filter((p) => !(p in vars));

    return {
      ...(args.id ? { templateId: args.id } : {}),
      channel: templateChannel ?? "email",
      rendered,
      resolvedVariables,
      unresolvedVariables: unresolvedVariables.length > 0 ? unresolvedVariables : undefined,
    };
  };

  server.registerTool(
    "preview_template",
    {
      title: "Preview a template",
      description:
        "Dry-run render a template with sample variable data before sending. Pass an existing template " +
        "`id` or supply raw `content` directly. Interpolates {{variable}} placeholders and returns the " +
        "rendered output alongside resolved/unresolved variable names.",
      inputSchema: {
        id: z.string().optional().describe("Template id to fetch and preview."),
        content: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Raw template content object (e.g. { subject, body }) to render without saving.",
          ),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Sample variable data to interpolate into the template's placeholders."),
        channel: z
          .enum(CHANNELS)
          .optional()
          .describe(
            "Target channel (e.g. 'email', 'sms', 'push'). Defaults to the template's channel.",
          ),
      },
      annotations: { title: "Preview a template", readOnlyHint: true },
    },
    handler(previewTemplateHandler),
  );

  /** @deprecated Same handler as preview_template; removed at the next minor version. */
  server.registerTool(
    "render_template",
    {
      title: "Render template content",
      description:
        "Deprecated: use preview_template, which does the same thing; this tool will be removed. " +
        "Render template content with variable data without dispatching any notifications. " +
        "Accepts either an existing template `id` or raw `content` object.",
      inputSchema: {
        id: z.string().optional().describe("Template id to fetch and render."),
        content: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Raw template content object to render."),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Variables to interpolate into placeholders."),
        channel: z
          .enum(CHANNELS)
          .optional()
          .describe("Target channel. Defaults to template channel."),
      },
      annotations: { title: "Render template content", readOnlyHint: true },
    },
    handler(previewTemplateHandler),
  );
}
