import { z } from "zod";

export const NotificationSkippedPayloadSchema = z.object({
  projectId: z.string().uuid(),
  eventId: z.string().uuid(),
  recipientId: z.string(),
  reason: z.string(),
});
export type NotificationSkippedPayload = z.infer<typeof NotificationSkippedPayloadSchema>;
