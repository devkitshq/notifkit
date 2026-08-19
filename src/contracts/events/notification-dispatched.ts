import { z } from "zod";
import { NotificationChannelSchema, NotificationPrioritySchema } from "@/contracts/common.js";
import { RecipientProfileSchema } from "./notification-enriched.js";

export const RenderedContentSchema = z.object({
  content: z.record(z.string(), z.unknown()),
  attachments: z
    .array(
      z.object({
        name: z.string(),
        contentType: z.string(),
        url: z.string().url(),
      }),
    )
    .optional(),
});
export type RenderedContent = z.infer<typeof RenderedContentSchema>;

export const DeliveryOptionsSchema = z.object({
  maxAttempts: z.number().int().positive().default(3),
  timeoutMs: z.number().int().positive().default(10_000),
  headers: z.record(z.string(), z.string()).optional(),
});
export type DeliveryOptions = z.infer<typeof DeliveryOptionsSchema>;

export const NotificationDispatchedPayloadSchema = z.object({
  projectId: z.string().uuid(),
  taskId: z.string().min(1),
  enrichedEventId: z.string().uuid(),
  recipientId: z.string().min(1),
  channel: NotificationChannelSchema,
  priority: NotificationPrioritySchema,
  templateId: z.string().min(1).optional(),
  templateVariables: z.record(z.string(), z.unknown()).default({}),
  aiPrompts: z.record(z.string(), z.string()).optional(),
  recipient: RecipientProfileSchema.optional(),
  renderedContent: RenderedContentSchema,
  destination: z.string().min(1).optional(),
  deliveryOptions: DeliveryOptionsSchema,
  fallbackChain: z.array(NotificationChannelSchema).optional(),
  throttleAttemptCount: z.number().int().nonnegative().optional(),
  /** Campaign this message belongs to, carried from the originating request. */
  campaignId: z.string().min(1).max(128).optional(),
});
export type NotificationDispatchedPayload = z.infer<typeof NotificationDispatchedPayloadSchema>;
