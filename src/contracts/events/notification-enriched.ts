import { z } from "zod";
import { NotificationChannelSchema, NotificationPrioritySchema } from "@/contracts/common.js";

export const RecipientProfileSchema = z.object({
  id: z.string(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  webhook: z.string().url().optional(),
  pushTokens: z.array(z.string()).optional(),
  pushToken: z.string().optional(),
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
  /** Campaign this message belongs to, carried from the originating request. */
  campaignId: z.string().min(1).max(128).optional(),
});
export type NotificationEnrichedPayload = z.infer<typeof NotificationEnrichedPayloadSchema>;
