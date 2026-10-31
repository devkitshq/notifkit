import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NotifkitApi } from "../client.js";
import { CHANNELS, CONTACT_CHANNELS, handler } from "./shared.js";

export function registerUsersTools(server: McpServer, api: NotifkitApi): void {
  server.registerTool(
    "list_users",
    {
      title: "List users",
      description:
        "Page through the project's users with comprehensive filtering. Supports filtering by search " +
        "keyword (external ID or email), segment tag, language, timezone, or channel contact. " +
        "Results are paginated — pass the returned `nextCursor` back as `cursor`. For one known user " +
        "prefer get_user, which also returns contacts and preferences.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Users per page."),
        cursor: z
          .string()
          .optional()
          .describe("Pagination cursor from a previous call's `nextCursor`."),
        search: z
          .string()
          .optional()
          .describe("Filter users whose external ID or email contains this search keyword."),
        segment: z.string().optional().describe("Only list users assigned to this segment tag."),
        language: z
          .string()
          .optional()
          .describe("Filter users by language tag, e.g. 'en', 'es', 'fr'."),
        timezone: z
          .string()
          .optional()
          .describe("Filter users by IANA timezone, e.g. 'Europe/London', 'America/New_York'."),
        channel: z
          .enum(CONTACT_CHANNELS)
          .optional()
          .describe(
            "Only list users who have a registered contact for this channel " +
              "(email, sms, push, webhook, telegram, discord, whatsapp, slack).",
          ),
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
        contacts: z
          .array(
            z.object({
              channel: z.enum(CHANNELS).describe("Contact delivery channel."),
              target: z.string().min(1).describe("Destination address, phone, token, or URL."),
              label: z.string().optional().describe("Friendly label for this contact."),
              isPrimary: z
                .boolean()
                .optional()
                .describe("Whether this is the primary contact for this channel."),
            }),
          )
          .optional()
          .describe(
            "Array of user contacts across any supported channels (preferred over legacy email/phone/pushToken).",
          ),
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
              .record(z.string(), z.boolean())
              .optional()
              .describe("Per-channel opt-in map, e.g. { email: true, sms: false }."),
            topics: z.record(z.string(), z.boolean()).optional().describe("Per-topic opt-in map."),
            quietHours: z
              .array(
                z.object({
                  start: z.string().describe("HH:MM, 24h, in the user's timezone."),
                  end: z.string().describe("HH:MM, 24h, in the user's timezone."),
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
    "update_user",
    {
      title: "Update a user",
      description:
        "Partially update an existing user profile (e.g. language, timezone, segment tags, preferences, or append new contacts) without replacing unspecified fields.",
      inputSchema: {
        id: z.string().min(1).describe("User id."),
        contacts: z
          .array(
            z.object({
              channel: z.enum(CHANNELS).describe("Contact delivery channel."),
              target: z.string().min(1).describe("Destination address, phone, token, or URL."),
              label: z.string().optional().describe("Friendly label for this contact."),
              isPrimary: z
                .boolean()
                .optional()
                .describe("Whether this is the primary contact for this channel."),
            }),
          )
          .optional()
          .describe("Array of user contacts across any supported channels to append or update."),
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
              .record(z.string(), z.boolean())
              .optional()
              .describe("Per-channel opt-in map, e.g. { email: true, sms: false }."),
            topics: z.record(z.string(), z.boolean()).optional().describe("Per-topic opt-in map."),
            quietHours: z
              .array(
                z.object({
                  start: z.string().describe("HH:MM, 24h, in the user's timezone."),
                  end: z.string().describe("HH:MM, 24h, in the user's timezone."),
                }),
              )
              .optional()
              .describe("Windows during which non-critical sends are deferred."),
          })
          .optional()
          .describe("Consent and quiet-hours settings."),
      },
      annotations: { title: "Update a user", readOnlyHint: false, idempotentHint: true },
    },
    handler(async ({ id, ...body }) => api.patch(`/v1/users/${encodeURIComponent(id)}`, body)),
  );

  server.registerTool(
    "delete_user",
    {
      title: "Delete a user",
      description:
        "Permanently delete a user profile and all associated contacts and preferences by user id.",
      inputSchema: {
        id: z.string().min(1).describe("User id to delete."),
      },
      annotations: {
        title: "Delete a user",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    handler(async (args) => {
      await api.delete(`/v1/users/${encodeURIComponent(args.id)}`);
      return `Deleted user ${args.id}.`;
    }),
  );

  server.registerTool(
    "get_user_contacts",
    {
      title: "Get user contacts",
      description: "Fetch all registered contact addresses and tokens for a specific user.",
      inputSchema: {
        userId: z.string().min(1).describe("User id."),
      },
      annotations: { title: "Get user contacts", readOnlyHint: true },
    },
    handler(async (args) => api.get(`/v1/users/${encodeURIComponent(args.userId)}/contacts`)),
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

  server.registerTool(
    "delete_user_contact",
    {
      title: "Delete a user contact",
      description:
        "Remove one contact destination (email, phone, push token, or webhook URL) from a user profile.",
      inputSchema: {
        userId: z.string().min(1).describe("User id."),
        channel: z.enum(CONTACT_CHANNELS).describe("Channel of the contact to delete."),
        target: z.string().min(1).describe("The address/number/token/URL to remove."),
      },
      annotations: {
        title: "Delete a user contact",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    handler(async (args) => {
      await api.delete(
        `/v1/users/${encodeURIComponent(args.userId)}/contacts/${encodeURIComponent(args.channel)}/${encodeURIComponent(args.target)}`,
      );
      return `Deleted ${args.channel} contact '${args.target}' for user ${args.userId}.`;
    }),
  );

  server.registerTool(
    "get_user_preferences",
    {
      title: "Get user preferences",
      description:
        "Fetch notification channel/topic opt-in preferences and quiet hours for a user.",
      inputSchema: {
        userId: z.string().min(1).describe("User id."),
      },
      annotations: { title: "Get user preferences", readOnlyHint: true },
    },
    handler(async (args) => api.get(`/v1/users/${encodeURIComponent(args.userId)}/preferences`)),
  );

  server.registerTool(
    "update_user_preferences",
    {
      title: "Update user preferences",
      description: "Update notification channel/topic opt-ins and quiet hours settings for a user.",
      inputSchema: {
        userId: z.string().min(1).describe("User id."),
        channels: z
          .record(z.string(), z.boolean())
          .optional()
          .describe("Per-channel opt-in map, e.g. { email: true, sms: false }."),
        topics: z.record(z.string(), z.boolean()).optional().describe("Per-topic opt-in map."),
        quietHours: z
          .array(
            z.object({
              start: z.string().describe("HH:MM, 24h, in the user's timezone."),
              end: z.string().describe("HH:MM, 24h, in the user's timezone."),
            }),
          )
          .optional()
          .describe("Windows during which non-critical sends are deferred."),
      },
      annotations: { title: "Update user preferences", readOnlyHint: false, idempotentHint: true },
    },
    handler(async ({ userId, ...preferences }) =>
      api.patch(`/v1/users/${encodeURIComponent(userId)}/preferences`, preferences),
    ),
  );
}
