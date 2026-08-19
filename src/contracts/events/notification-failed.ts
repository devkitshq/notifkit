import { z } from "zod";
import { NotificationChannelSchema } from "@/contracts/common.js";

export const NotificationFailedPayloadSchema = z.object({
  projectId: z.string().uuid(),
  taskId: z.string().min(1),
  enrichedEventId: z.string().uuid(),
  channel: NotificationChannelSchema,
  failureReason: z.string(),
  failureCode: z.string(),
  retryable: z.boolean(),
  attempt: z.number().int().positive(),
  providerResponse: z.record(z.string(), z.unknown()).optional(),
  templateId: z.string().uuid().optional(),
  workflowInstanceId: z.string().uuid().optional(),
  /** Campaign this message belongs to, carried from the originating request. */
  campaignId: z.string().min(1).max(128).optional(),
});
export type NotificationFailedPayload = z.infer<typeof NotificationFailedPayloadSchema>;
