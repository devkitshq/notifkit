import { z } from "zod";
import { NotificationChannelSchema, NotificationPrioritySchema } from "@/contracts/common.js";
import { RecipientProfileSchema } from "./notification-enriched.js";

export const NotificationAiPendingPayloadSchema = z.object({
  projectId: z.string().uuid(),
  enrichedEventId: z.string().uuid(),
  recipientId: z.string().min(1),
  channel: NotificationChannelSchema,
  priority: NotificationPrioritySchema,
  templateId: z.string().min(1).optional(),
  templateVariables: z.record(z.string(), z.unknown()),
  recipient: RecipientProfileSchema,
  aiPrompts: z.record(z.string(), z.string()),
  scheduledAt: z.string().datetime().optional(),
  fallbackChain: z.array(NotificationChannelSchema).optional(),
});
export type NotificationAiPendingPayload = z.infer<typeof NotificationAiPendingPayloadSchema>;
