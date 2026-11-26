import { z } from "zod";
import { NotificationChannelSchema, NotificationPrioritySchema } from "@/contracts/common.js";

export const RecipientProfileSchema = z.object({
  id: z.string(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  webhook: z.string().url().optional(),
  pushTokens: z.array(z.string()).optional(),
  pushToken: z.string().optional(),
  telegram: z.string().optional(),
  discord: z.string().url().optional(),
  slack: z.string().optional(),
  teams: z.string().url().optional(),
  locale: z.string().default("en"),
  timezone: z.string().default("UTC"),
  preferences: z.object({
    optedOut: z.boolean().default(false),
    channels: z.array(NotificationChannelSchema).default([]),
    quietHours: z
      .array(
        z.object({
          start: z.string(),
          end: z.string(),
        }),
      )
      .optional(),
  }),
});
export type RecipientProfile = z.infer<typeof RecipientProfileSchema>;

export const NotificationEnrichedPayloadSchema = z.object({
  projectId: z.string().uuid(),
  rawEventId: z.string().uuid(),
  recipientId: z.string().min(1),
  channel: NotificationChannelSchema,
  priority: NotificationPrioritySchema,
  templateId: z.string().min(1).optional(),
  templateVariables: z.record(z.string(), z.unknown()),
  recipient: RecipientProfileSchema,
  aiPrompts: z.record(z.string(), z.string()).optional(),
  scheduledAt: z.string().datetime().optional(),
  fallbackChain: z.array(NotificationChannelSchema).optional(),
  /**
   * The contact the enricher resolved this message to, and its address. When
   * present the engine sends to exactly this contact instead of re-reading the
   * user's contacts. Absent on events from delivery's channel fallback and the
   * AI worker, which carry a recipient but no resolved contact.
   */
  contactId: z.string().min(1).optional(),
  destination: z.string().min(1).optional(),
  /** Campaign this message belongs to, carried from the originating request. */
  campaignId: z.string().min(1).max(128).optional(),
  /** Workflow instance whose step sent this, carried to the delivery log. */
  workflowInstanceId: z.string().uuid().optional(),
  /**
   * Set on delivery's channel fallback. The notification was counted against
   * the user's throttle when it was first sent; counting it again per channel
   * it falls back through would drop the very send meant to reach them.
   */
  throttleCounted: z.boolean().optional(),
});
export type NotificationEnrichedPayload = z.infer<typeof NotificationEnrichedPayloadSchema>;
