import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NotifkitApi } from "../client.js";
import { CHANNELS, CONTACT_CHANNELS, PRIORITIES, handler } from "./shared.js";

export function registerSendingTools(server: McpServer, api: NotifkitApi): void {
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
          .record(z.string(), z.unknown())
          .optional()
          .describe("Variables interpolated into the template's {{placeholders}}."),
        channels: z
          .array(z.enum(CHANNELS))
          .nonempty()
          .optional()
          .describe("Channels to use. Defaults to ['email']."),
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
        "Send one template to a list of recipient destinations (email, SMS/phone, push tokens, webhook URLs, " +
        "Telegram chat ids, Discord webhook URLs, WhatsApp phone numbers, or Slack channel/user IDs/webhook URLs) given directly — the tool creates or updates a user " +
        "record for each address, then sends, and tags every message with a campaign label so the results " +
        "can be read back later with get_campaign_stats. Supports 'email', 'sms', 'push', 'webhook', " +
        "'telegram', 'discord', 'whatsapp', and 'slack' channels. Use this when the person supplies the recipients themselves " +
        "(a pasted list, a spreadsheet column). Always report the returned campaign label back to the user " +
        "— it is how they ask about results later. Suppressed addresses (previous unsubscribes, complaints, " +
        "hard bounces) are dropped automatically at send time, so the delivered count is normally lower than " +
        "the list size.",
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
        channel: z
          .enum(CONTACT_CHANNELS)
          .optional()
          .describe(
            "Channel to send on ('email', 'sms', 'push', 'webhook', 'telegram', 'discord', 'whatsapp', or 'slack'). Defaults to 'email'.",
          ),
        recipients: z
          .array(z.string().min(1))
          .min(1)
          .max(10000)
          .optional()
          .describe(
            "Recipient destination addresses: email addresses for email, E.164 phone numbers for sms/whatsapp, " +
              "device tokens for push, URLs for webhook, chat ids for telegram, webhook URLs for discord, or channel/user IDs for slack.",
          ),
        emails: z
          .array(z.string().email())
          .min(1)
          .max(10000)
          .optional()
          .describe(
            "Recipient email addresses (alias for recipients when sending on email channel).",
          ),
        data: z
          .record(z.string(), z.unknown())
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
      const channel = args.channel ?? "email";
      const rawList = args.recipients ?? args.emails;
      if (!rawList || rawList.length === 0) {
        throw new Error("Provide a list of `recipients` (or `emails`) to send to.");
      }

      const seen = new Set<string>();
      const recipients = [];
      for (const raw of rawList) {
        const target = channel === "email" ? raw.trim().toLowerCase() : raw.trim();
        if (seen.has(target)) continue;
        seen.add(target);

        // Every channel needs a contact on that channel to be reached. Chat
        // channels used to get a bare user record, and WhatsApp a phone
        // number filed as an SMS contact, so those campaigns sent nothing.
        const userRecord: Record<string, unknown> =
          channel === "email"
            ? { id: `email:${target}`, email: target }
            : channel === "sms"
              ? { id: `phone:${target}`, phone: target }
              : channel === "push"
                ? { id: `push:${target}`, pushToken: target }
                : { id: `${channel}:${target}`, contacts: [{ channel, target }] };
        recipients.push(userRecord);
      }

      const result = await api.post<Record<string, unknown>>("/v1/notify", {
        user: recipients,
        template: args.template,
        campaign: args.campaign,
        channels: [channel],
        ...(args.data ? { data: args.data } : {}),
        ...(args.priority ? { priority: args.priority } : {}),
        ...(args.sendAt ? { sendAt: args.sendAt } : {}),
      });

      const duplicates = rawList.length - recipients.length;
      return {
        campaign: args.campaign,
        channel,
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
        "yesterday') to find the label to pass to get_campaign_stats. Supports filtering by search query, " +
        "channel, date range, or minimum message count.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("How many campaigns to return. Defaults to 20."),
        search: z
          .string()
          .optional()
          .describe("Filter campaigns whose label contains this string (case-insensitive)."),
        channel: z
          .enum(CHANNELS)
          .optional()
          .describe("Only list campaigns that sent messages on this channel."),
        since: z
          .string()
          .datetime()
          .optional()
          .describe(
            "ISO 8601 timestamp; only return campaigns with activity on or after this date.",
          ),
        until: z
          .string()
          .datetime()
          .optional()
          .describe(
            "ISO 8601 timestamp; only return campaigns with activity on or before this date.",
          ),
        minMessages: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Minimum number of distinct messages/recipients for a campaign."),
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
        target: z
          .string()
          .optional()
          .describe("Filter suppressions matching this email, phone, or push token."),
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
        "recipient's quiet hours. Supports filtering by channel and pagination.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("How many rows to return. Defaults to 50."),
        cursor: z
          .string()
          .optional()
          .describe("Pagination cursor (taskId) from a previous call's `nextCursor`."),
        channel: z
          .enum(CHANNELS)
          .optional()
          .describe("Only list scheduled messages intended for this channel."),
      },
      annotations: { title: "List scheduled sends", readOnlyHint: true },
    },
    handler(async (args) => api.get("/v1/notifications/scheduled", args)),
  );

  server.registerTool(
    "get_delivery_logs",
    {
      title: "Get delivery logs",
      description:
        "Query the durable delivery log: what was sent, on which channel, and whether it succeeded. Call " +
        "this to answer 'did it go out?' after a send, or to investigate failures. Filter by template, " +
        "channel, status, campaign, or task ID. Results are paginated — pass the returned `nextCursor` " +
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
          .describe(
            "Delivery status to filter on, e.g. 'dispatched', 'delivered', 'failed', 'opened'.",
          ),
        campaign: z
          .string()
          .optional()
          .describe("Only log entries tagged with this campaign label."),
        taskId: z
          .string()
          .optional()
          .describe("Only log entries for this specific notification task ID."),
        search: z
          .string()
          .optional()
          .describe(
            "Search keyword across task IDs, template IDs, provider message IDs, or campaign labels.",
          ),
      },
      annotations: { title: "Get delivery logs", readOnlyHint: true },
    },
    handler(async (args) => api.get("/v1/notifications/logs", args)),
  );

  server.registerTool(
    "get_notification",
    {
      title: "Get notification status",
      description:
        "Fetch the delivery history and latest state of a specific notification by its task ID. " +
        "Shows each attempt, provider status, timestamps, and error messages.",
      inputSchema: {
        taskId: z
          .string()
          .min(1)
          .describe("Task ID returned from send_notification or send_campaign."),
      },
      annotations: { title: "Get notification status", readOnlyHint: true },
    },
    handler(async (args) => api.get(`/v1/notifications/${encodeURIComponent(args.taskId)}`)),
  );

  server.registerTool(
    "cancel_notification",
    {
      title: "Cancel a scheduled notification",
      description:
        "Cancel a pending or quiet-hours deferred notification before it is dispatched to the provider. " +
        "Takes the taskId from send_notification or list_scheduled.",
      inputSchema: {
        taskId: z.string().min(1).describe("Task ID of the scheduled notification to cancel."),
      },
      annotations: {
        title: "Cancel a scheduled notification",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    handler(async (args) => {
      await api.request("DELETE", `/v1/notifications/${encodeURIComponent(args.taskId)}`);
      return `Cancelled scheduled notification ${args.taskId}.`;
    }),
  );
}
