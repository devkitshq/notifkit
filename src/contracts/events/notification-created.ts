import { z } from "zod";
import { NotificationChannelSchema, NotificationPrioritySchema } from "@/contracts/common.js";

/** @deprecated Nothing publishes `notification.created`; removed in the next minor version. */
export const NotificationCreatedPayloadSchema = z.object({
  projectId: z.string().uuid(),
  recipientId: z.string().min(1),
  channel: NotificationChannelSchema,
  priority: NotificationPrioritySchema.default("normal"),
  templateId: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()),
  scheduledAt: z.string().datetime().optional(),
  idempotencyKey: z.string().optional(),
});
/** @deprecated Nothing publishes `notification.created`; removed in the next minor version. */
export type NotificationCreatedPayload = z.infer<typeof NotificationCreatedPayloadSchema>;
