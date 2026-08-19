import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NotifkitApi } from "./client.js";
import { NotifkitApiError } from "./client.js";

const CHANNELS = ["email", "sms", "push", "webhook", "in-app"] as const;
const CONTACT_CHANNELS = ["email", "sms", "push", "webhook"] as const;
const PRIORITIES = ["low", "normal", "high", "critical"] as const;

interface ToolResult {
  // The SDK's tool-result type carries an index signature for protocol
  // extensions; without one here an interface is not assignable to it.
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Render any handler return value as the text payload MCP clients expect. */
function ok(value: unknown): ToolResult {
  const text =
    value === undefined
      ? "Done."
      : typeof value === "string"
        ? value
        : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(error: unknown): ToolResult {
  const text =
    error instanceof NotifkitApiError
      ? `notifkit API error (HTTP ${error.status}): ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: "text", text }], isError: true };
}

/** Wrap a handler so a failed request is reported to the model instead of killing the server. */
function handler<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (error) {
      return fail(error);
    }
  };
}

export function registerTools(server: McpServer, api: NotifkitApi): void {
  // ─── Sending ────────────────────────────────────────────────────────────────

  server.registerTool(
    "send_notification",
    {
      title: "Send a notification",
      description:
        "Queue a notification and return immediately with its message id. This is the primitive behind " +
        "both one-off sends and broadcasts: target a single user by id, a list of user ids, a `segment` " +
        "(every user tagged with it), or a `topic` (every user opted in to it). Exactly one of `user`, " +
        "`segment`, or `topic` must be given. Set `sendAt` to schedule a future send, which can then be " +
        "inspected with list_scheduled. Delivery is filtered by each recipient's preferences, consent, and " +
        "quiet hours, so the number of messages actually delivered is usually lower than the audience size. " +
        "Call list_segments first when the user names an audience you have not confirmed exists, and " +
        "list_templates when you are unsure of the template id.",
      inputSchema: {
        template: z.string().min(1).describe("Template id to render, e.g. 'order-shipped'."),
        user: z
          .union([z.string().min(1), z.array(z.string().min(1)).nonempty()])
          .optional()
          .describe(
            "A single user id or a list of user ids. Mutually exclusive with segment and topic.",
          ),
        segment: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Send to every user tagged with this segment. Mutually exclusive with user and topic.",
          ),
        topic: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Send to every user opted in to this topic. Mutually exclusive with user and segment.",
          ),
        data: z
          .record(z.unknown())
          .optional()
          .describe("Variables interpolated into the template's {{placeholders}}."),
        channels: z
          .array(z.enum(CHANNELS))
          .nonempty()
          .optional()
          .describe("Channels to use. Defaults to whatever the template defines."),
        fallback: z
          .boolean()
          .optional()
          .describe(
            "When true, channels are tried in order and only the first success counts. When false or " +
              "omitted, every listed channel is delivered to.",
          ),
        priority: z
          .enum(PRIORITIES)
          .optional()
          .describe("Queue lane. 'critical' bypasses quiet hours and per-user rate limits."),
        sendAt: z
          .string()
          .datetime()
          .optional()
          .describe("ISO 8601 timestamp to send at. Omit to send now."),
        campaign: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe(
            "Label grouping this send for later reporting via get_campaign_stats. Set it on any send " +
              "whose results someone may ask about; without it the messages cannot be attributed.",
          ),
      },
      annotations: { title: "Send a notification", readOnlyHint: false, idempotentHint: false },
    },
    handler(async (args) => {
      const targets = [args.user, args.segment, args.topic].filter((t) => t !== undefined);
      if (targets.length !== 1) {
        throw new Error("Provide exactly one of `user`, `segment`, or `topic`.");
      }
      return api.post("/v1/notify", args);
    }),
  );

  server.registerTool(
    "send_campaign",
    {
      title: "Send a campaign to a list of addresses",
      description:
        "Send one template to a list of email addresses given directly — the tool creates or updates a " +
        "user record for each address, then sends, and tags every message with a campaign label so the " +
        "results can be read back later with get_campaign_stats. Use this when the person supplies the " +
        "recipients themselves (a pasted list, a spreadsheet column). Use send_notification instead when " +
        "targeting existing users, a segment, or a topic. Always report the returned campaign label back " +
        "to the user — it is how they ask about results later. Suppressed addresses (previous " +
        "unsubscribes, complaints, hard bounces) are dropped automatically at send time, so the delivered " +
        "count is normally lower than the list size.",
      inputSchema: {
        campaign: z
          .string()
          .min(1)
          .max(128)
          .describe(
            "Label for this send, e.g. 'spring-sale-2026-08-13'. Must be unique per send — reusing a " +
              "label merges the two into one set of statistics.",
          ),
        template: z.string().min(1).describe("Template id to render."),
        emails: z
          .array(z.string().email())
          .min(1)
          .max(10000)
          .describe("Recipient email addresses."),
        data: z
          .record(z.unknown())
          .optional()
          .describe("Variables interpolated into the template, shared by every recipient."),
        priority: z
          .enum(PRIORITIES)
          .optional()
          .describe(
            "Queue lane. Leave unset for 'normal'; do not use 'critical' for marketing sends.",
          ),
        sendAt: z
          .string()
          .datetime()
          .optional()
          .describe("ISO 8601 timestamp to send at. Omit to send now."),
      },
      annotations: { title: "Send a campaign", readOnlyHint: false, idempotentHint: false },
    },
    handler(async (args) => {
      // The API needs a stable user id per address. Deriving it from the
      // address itself means re-sending to the same list updates those people
      // rather than creating a second copy of each.
      const seen = new Set<string>();
      const recipients = [];
      for (const raw of args.emails) {
        const email = raw.trim().toLowerCase();
        if (seen.has(email)) continue;
        seen.add(email);
        recipients.push({ id: `email:${email}`, email });
      }

      const result = await api.post<Record<string, unknown>>("/v1/notify", {
        user: recipients,
        template: args.template,
        campaign: args.campaign,
        channels: ["email"],
        ...(args.data ? { data: args.data } : {}),
        ...(args.priority ? { priority: args.priority } : {}),
        ...(args.sendAt ? { sendAt: args.sendAt } : {}),
      });

      const duplicates = args.emails.length - recipients.length;
      return {
        campaign: args.campaign,
        queued: recipients.length,
        ...(duplicates > 0 ? { duplicatesRemoved: duplicates } : {}),
        note:
          "Queued, not yet delivered. Preferences, quiet hours, and suppressions are applied during " +
          "delivery — call get_campaign_stats for what actually landed.",
        result,
      };
    }),
  );

  server.registerTool(
    "list_campaigns",
    {
      title: "List campaigns",
      description:
        "List recent campaign labels with their size and when they last saw activity, newest first. Call " +
        "this when the user refers to a past send without naming its exact label ('the one I sent " +
        "yesterday') to find the label to pass to get_campaign_stats.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("How many campaigns to return."),
      },
      annotations: { title: "List campaigns", readOnlyHint: true },
    },
    handler(async (args) => api.get("/v1/campaigns", args)),
  );

  server.registerTool(
    "get_campaign_stats",
    {
      title: "Get campaign performance",
      description:
        "The delivery and engagement funnel for one campaign: sent, delivered, failed, opened, clicked, " +
        "bounced, complained, unsubscribed, with rates and a per-channel breakdown. This is the tool for " +
        "'how did that send perform?'. Every count is people, not events — opening an email twice counts " +
        "once. Always surface the `warnings` field to the user: it says when opens and clicks are not " +
        "tracked on a channel, which is different from them being zero. A high complaint rate (above " +
        "~0.3%) is worth flagging unprompted, as it damages deliverability for all future sends.",
      inputSchema: {
        campaign: z.string().min(1).describe("Campaign label, as returned by list_campaigns."),
      },
      annotations: { title: "Get campaign performance", readOnlyHint: true },
    },
    handler(async (args) => api.get(`/v1/campaigns/${encodeURIComponent(args.campaign)}/stats`)),
  );

  server.registerTool(
    "list_suppressions",
    {
      title: "List suppressed addresses",
      description:
        "List destinations that will not be contacted again, with the reason each was suppressed " +
        "(unsubscribed, complained, bounced, or manual). Call this to explain why someone did not receive " +
        "a message, or to review unsubscribes after a campaign.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe("How many rows to return."),
        channel: z.enum(CONTACT_CHANNELS).optional().describe("Only this channel."),
        reason: z
          .enum(["unsubscribed", "complained", "bounced", "manual"])
          .optional()
          .describe("Only suppressions with this reason."),
      },
      annotations: { title: "List suppressed addresses", readOnlyHint: true },
    },
    handler(async (args) => api.get("/v1/suppressions", args)),
  );

  server.registerTool(
    "suppress_address",
    {
      title: "Suppress an address",
      description:
        "Stop sending to a destination on a channel — use when someone asks to be removed by replying, " +
        "over the phone, or any route the provider does not report automatically. Takes effect on the " +
        "next send and outranks every other setting, including 'critical' priority.",
      inputSchema: {
        channel: z.enum(CONTACT_CHANNELS).describe("Channel to suppress on."),
        target: z.string().min(1).describe("The address: email, phone number, or push token."),
        reason: z
          .enum(["unsubscribed", "complained", "bounced", "manual"])
          .optional()
          .describe("Why. Defaults to 'manual'."),
      },
      annotations: { title: "Suppress an address", readOnlyHint: false, idempotentHint: true },
    },
    handler(async (args) => api.post("/v1/suppressions", args)),
  );

  server.registerTool(
    "unsuppress_address",
    {
      title: "Remove a suppression",
      description:
        "Re-enable sending to a previously suppressed destination. Only do this on an explicit request " +
        "from the user — a suppression usually records that the person asked not to be contacted, and " +
        "removing it to fix a low delivery count is how a sending domain gets blocked. Confirm before " +
        "calling.",
      inputSchema: {
        channel: z.enum(CONTACT_CHANNELS).describe("Channel the suppression is on."),
        target: z.string().min(1).describe("The suppressed address."),
      },
      annotations: {
        title: "Remove a suppression",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    handler(async (args) => {
      await api.request(
        "DELETE",
        `/v1/suppressions/${encodeURIComponent(args.channel)}/${encodeURIComponent(args.target)}`,
      );
      return `Removed the suppression on ${args.target} for ${args.channel}.`;
    }),
  );

  server.registerTool(
    "list_segments",
    {
      title: "List segments",
      description:
        "List every segment tag currently in use across the project's users. Call this to discover the " +
        "valid audiences for send_notification's `segment` argument before broadcasting.",
      annotations: { title: "List segments", readOnlyHint: true },
    },
    handler(async () => api.get("/v1/segments")),
  );

  server.registerTool(
    "list_scheduled",
    {
      title: "List scheduled sends",
      description:
        "List notifications queued for future delivery — those given a `sendAt`, plus any deferred by a " +
        "recipient's quiet hours. Use this to confirm a scheduled send landed, or to review what is " +
        "pending before scheduling more.",
      annotations: { title: "List scheduled sends", readOnlyHint: true },
    },
    handler(async () => api.get("/v1/notifications/scheduled")),
  );

  server.registerTool(
    "get_delivery_logs",
    {
      title: "Get delivery logs",
      description:
        "Query the durable delivery log: what was sent, on which channel, and whether it succeeded. Call " +
        "this to answer 'did it go out?' after a send, or to investigate failures. Filter by template, " +
        "channel, status, or workflow instance. Results are paginated — pass the returned `nextCursor` " +
        "back as `cursor` for the next page.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Rows per page. Defaults to the server's page size."),
        cursor: z
          .string()
          .optional()
          .describe("Pagination cursor from a previous call's `nextCursor`."),
        templateId: z.string().optional().describe("Only log entries rendered from this template."),
        workflowInstanceId: z
          .string()
          .optional()
          .describe("Only entries emitted by this workflow instance."),
        channel: z.enum(CHANNELS).optional().describe("Only entries delivered on this channel."),
        status: z
          .string()
          .optional()
          .describe("Delivery status to filter on, e.g. 'sent' or 'failed'."),
      },
      annotations: { title: "Get delivery logs", readOnlyHint: true },
    },
    handler(async (args) => api.get("/v1/notifications/logs", args)),
  );

  // ─── Templates ──────────────────────────────────────────────────────────────

  server.registerTool(
    "list_templates",
    {
      title: "List templates",
      description:
        "List every registered template with its channel and content. Call this to find the template id " +
        "for send_notification, or to check what a template renders before sending with it.",
      annotations: { title: "List templates", readOnlyHint: true },
    },
    handler(async () => api.get("/v1/templates")),
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
          .record(z.unknown())
          .describe("Channel-specific fields, e.g. { subject, body } for email."),
        aiPrompts: z
          .record(z.string())
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

  // ─── Users ──────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_users",
    {
      title: "List users",
      description:
        "Page through the project's users. Results are paginated — pass the returned `nextCursor` back as " +
        "`cursor`. For one known user prefer get_user, which also returns contacts and preferences.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Users per page."),
        cursor: z
          .string()
          .optional()
          .describe("Pagination cursor from a previous call's `nextCursor`."),
      },
      annotations: { title: "List users", readOnlyHint: true },
    },
    handler(async (args) => api.get("/v1/users", args)),
  );

  server.registerTool(
    "get_user",
    {
      title: "Get a user",
      description:
        "Fetch one user with their contacts, segments, and notification preferences. Call this before " +
        "sending to a single user when you need to know which channels they can actually be reached on.",
      inputSchema: { id: z.string().min(1).describe("User id.") },
      annotations: { title: "Get a user", readOnlyHint: true },
    },
    handler(async (args) => api.get(`/v1/users/${encodeURIComponent(args.id)}/details`)),
  );

  server.registerTool(
    "upsert_user",
    {
      title: "Create or update a user",
      description:
        "Create a user profile, or update an existing one with the same id. Sets contact targets, segment " +
        "tags, timezone, and preferences in one call. Segments assigned here are what send_notification's " +
        "`segment` targeting matches on. Timezone drives quiet-hours maths, so set it when known.",
      inputSchema: {
        id: z.string().min(1).describe("Your own stable user id, e.g. 'usr_123'."),
        email: z
          .union([z.string().min(1), z.array(z.string().min(1))])
          .optional()
          .describe("One email address or several."),
        phone: z
          .union([z.string().min(1), z.array(z.string().min(1))])
          .optional()
          .describe("One phone number or several, in E.164 form."),
        pushToken: z
          .union([z.string().min(1), z.array(z.string().min(1))])
          .optional()
          .describe("One device push token or several."),
        segments: z
          .array(z.string().min(1))
          .optional()
          .describe("Segment tags to assign to this user."),
        language: z
          .string()
          .optional()
          .describe("BCP 47 language tag used to pick localised content."),
        timezone: z
          .string()
          .optional()
          .describe("IANA timezone, e.g. 'Europe/London'. Drives quiet hours."),
        preferences: z
          .object({
            channels: z
              .record(z.boolean())
              .optional()
              .describe("Per-channel opt-in map, e.g. { email: true, sms: false }."),
            topics: z.record(z.boolean()).optional().describe("Per-topic opt-in map."),
            quietHours: z
              .array(
                z.object({
                  start: z.string().describe("HH:MM, 24h, UTC."),
                  end: z.string().describe("HH:MM, 24h, UTC."),
                }),
              )
              .optional()
              .describe("Windows during which non-critical sends are deferred."),
          })
          .optional()
          .describe("Consent and quiet-hours settings."),
      },
      annotations: { title: "Create or update a user", readOnlyHint: false, idempotentHint: true },
    },
    handler(async (args) => api.post("/v1/users", args)),
  );

  server.registerTool(
    "add_user_contact",
    {
      title: "Add a contact to a user",
      description:
        "Add one addressable target (email address, phone number, push token, or webhook URL) to an " +
        "existing user without replacing their other contacts. Prefer this over upsert_user when adding a " +
        "second device or address to someone who already exists.",
      inputSchema: {
        userId: z.string().min(1).describe("Id of the user to add the contact to."),
        channel: z.enum(CONTACT_CHANNELS).describe("Channel this target belongs to."),
        target: z.string().min(1).describe("The address itself: email, phone, push token, or URL."),
      },
      annotations: { title: "Add a contact to a user", readOnlyHint: false },
    },
    handler(async ({ userId, ...body }) =>
      api.post(`/v1/users/${encodeURIComponent(userId)}/contacts`, body),
    ),
  );

  // ─── Workflows ──────────────────────────────────────────────────────────────

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
                  .record(z.unknown())
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
        "trigger_workflow, or to check a sequence before triggering it.",
      annotations: { title: "List workflows", readOnlyHint: true },
    },
    handler(async () => api.get("/v1/workflows")),
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
        input: z.record(z.unknown()).optional().describe("Data made available to the run's steps."),
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
          .record(z.unknown())
          .describe("Event payload. Include the user id the event is about."),
      },
      annotations: { title: "Ingest an event", readOnlyHint: false, idempotentHint: false },
    },
    handler(async (args) => api.post("/v1/events", args)),
  );

  // ─── Operations ─────────────────────────────────────────────────────────────

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
}
