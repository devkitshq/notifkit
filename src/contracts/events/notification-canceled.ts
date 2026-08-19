import { z } from "zod";

export const NotificationCanceledPayloadSchema = z.object({
  projectId: z.string().uuid(),
  taskId: z.string().min(1),
});
export type NotificationCanceledPayload = z.infer<typeof NotificationCanceledPayloadSchema>;
