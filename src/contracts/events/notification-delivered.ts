import { z } from "zod";
import { NotificationChannelSchema } from "@/contracts/common.js";

export const NotificationDeliveredPayloadSchema = z.object({
  projectId: z.string().uuid(),
  taskId: z.string().min(1),
  enrichedEventId: z.string().uuid(),
  channel: NotificationChannelSchema,
  deliveredAt: z.string().datetime(),
  providerMessageId: z.string().optional(),
  providerResponse: z.record(z.string(), z.unknown()).optional(),
  templateId: z.string().uuid().optional(),
  workflowInstanceId: z.string().uuid().optional(),
  /** Campaign this message belongs to, carried from the originating request. */
  campaignId: z.string().min(1).max(128).optional(),
});
export type NotificationDeliveredPayload = z.infer<typeof NotificationDeliveredPayloadSchema>;
