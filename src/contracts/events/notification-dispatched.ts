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
  /**
   * Absent on tasks the engine dispatches: delivery renders `templateId` with
   * `templateVariables` just before sending, so the rendered body never rides
   * through the outbound stream or sits in a scheduled payload. The AI worker
   * still sends it pre-rendered, since its variables are generated.
   */
  renderedContent: RenderedContentSchema.optional(),
  destination: z.string().min(1).optional(),
  deliveryOptions: DeliveryOptionsSchema,
  fallbackChain: z.array(NotificationChannelSchema).optional(),
  throttleAttemptCount: z.number().int().nonnegative().optional(),
  /** When delivery first found no provider capacity. Waiting is capped by time, not rounds. */
  throttledSince: z.string().datetime().optional(),
  /**
   * Provider attempts that already failed. Delivery re-queues a failed send
   * through the scheduler until this reaches `deliveryOptions.maxAttempts`.
   */
  deliveryAttemptCount: z.number().int().nonnegative().optional(),
  /** Campaign this message belongs to, carried from the originating request. */
  campaignId: z.string().min(1).max(128).optional(),
  /** Workflow instance whose step sent this, recorded on the delivery log. */
  workflowInstanceId: z.string().uuid().optional(),
});
/** A `notification.dispatched` task as it travels on the outbound stream. */
export type DispatchedTaskPayload = z.infer<typeof NotificationDispatchedPayloadSchema>;

/** A task as a transport receives it: always rendered. */
export type NotificationDispatchedPayload = DispatchedTaskPayload & {
  renderedContent: RenderedContent;
};
