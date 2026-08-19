import { z } from "zod";
import { NotificationChannelSchema, NotificationPrioritySchema } from "@/contracts/common.js";

/**
 * A high-level notification request as issued by the SDK's `notify()` call.
 *
 * Unlike `notification.created` (which targets a single resolved recipient),
 * this event carries the *unresolved* target — a user id, a segment, or a
 * topic. A downstream resolver stage fans it out into one
 * `notification.created` per matching recipient, applying preference filters.
 */
export const NotificationTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), userId: z.string().min(1) }),
  z.object({ type: z.literal("segment"), segment: z.string().min(1) }),
  z.object({ type: z.literal("topic"), topic: z.string().min(1) }),
]);
export type NotificationTarget = z.infer<typeof NotificationTargetSchema>;

export const NotificationRequestedPayloadSchema = z.object({
  projectId: z.string().uuid(),
  target: NotificationTargetSchema,
  templateId: z.string().min(1),
  priority: NotificationPrioritySchema.default("normal"),
  channels: z.array(NotificationChannelSchema).nonempty().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
  fallback: z.boolean().default(false),
  aiPrompts: z.record(z.string(), z.string()).optional(),
  scheduledAt: z.string().datetime().optional(),
  idempotencyKey: z.string().optional(),
  /**
   * Groups every message this request fans out into, so the send can be
   * reported on afterwards. Carried unchanged to the delivery log.
   */
  campaignId: z.string().min(1).max(128).optional(),
});
export type NotificationRequestedPayload = z.infer<typeof NotificationRequestedPayloadSchema>;
