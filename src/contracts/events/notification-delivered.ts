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
  templateId: z.string().min(1).optional(),
  workflowInstanceId: z.string().uuid().optional(),
  /** Campaign this message belongs to, carried from the originating request. */
  campaignId: z.string().min(1).max(128).optional(),
  attempt: z.number().int().positive().optional(),
  /**
   * Set when this event also stands in for the attempt's
   * `notification.dispatched` log entry (see DeliveryWorker): the send finished
   * quickly enough that both were published as one stream entry.
   */
  dispatchedAt: z.string().datetime().optional(),
});
export type NotificationDeliveredPayload = z.infer<typeof NotificationDeliveredPayloadSchema>;
