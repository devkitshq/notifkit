import { z } from "zod";

export const NotificationScheduledPayloadSchema = z.object({
  projectId: z.string().uuid(),
  enrichedEventId: z.string().uuid(),
  taskId: z.string().min(1),
  scheduledAt: z.string().datetime(),
});
export type NotificationScheduledPayload = z.infer<typeof NotificationScheduledPayloadSchema>;
