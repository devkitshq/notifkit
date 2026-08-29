import { z } from "zod";
import { NotificationChannelSchema, NotificationPrioritySchema } from "./common.js";

// ─── Preferences ──────────────────────────────────────────────────────────────
//
// Preferences are stored as JSONB and are intentionally open-ended so new
// channels/topics can be added without a migration. `channels` and `topics`
// are boolean opt-in maps; `quietHours` is a list of UTC HH:MM windows.

export const QuietHoursSchema = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM (24h, UTC)"),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM (24h, UTC)"),
});
export type QuietHours = z.infer<typeof QuietHoursSchema>;

export const PreferencesSchema = z.object({
  channels: z.record(z.string(), z.boolean()).optional(),
  topics: z.record(z.string(), z.boolean()).optional(),
  quietHours: z.array(QuietHoursSchema).optional(),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

// ─── Contacts ─────────────────────────────────────────────────────────────────

/** Channels that carry an addressable target (email address, phone, push token, url). */
export const ContactChannelSchema = z.enum(["email", "sms", "push", "webhook", "whatsapp"]);
export type ContactChannel = z.infer<typeof ContactChannelSchema>;

/** Accept a single value or an array; always normalise to a non-empty array. */
const stringOrArray = z
  .union([z.string().min(1), z.array(z.string().min(1))])
  .transform((v) => (Array.isArray(v) ? v : [v]));

// ─── Users ────────────────────────────────────────────────────────────────────

/**
 * addUser({ id, email, phone, pushToken, segments, preferences })
 * email / phone / pushToken accept a single string or an array.
 */
export const AddUserSchema = z.object({
  id: z.string().min(1),
  language: z.string().optional(),
  timezone: z.string().optional(),
  email: stringOrArray.optional(),
  phone: stringOrArray.optional(),
  pushToken: stringOrArray.optional(),
  segments: z.array(z.string().min(1)).optional(),
  preferences: PreferencesSchema.optional(),
});
export type AddUserInput = z.input<typeof AddUserSchema>;

/** updateUser(id, patch) — every field optional; id comes from the path. */
export const UpdateUserSchema = z.object({
  language: z.string().optional(),
  timezone: z.string().optional(),
  email: stringOrArray.optional(),
  phone: stringOrArray.optional(),
  pushToken: stringOrArray.optional(),
  segments: z.array(z.string().min(1)).optional(),
  preferences: PreferencesSchema.optional(),
});
export type UpdateUserInput = z.input<typeof UpdateUserSchema>;

/** addUserContact(userId, channel, { target, preferences }) — channel carried in body. */
export const AddContactSchema = z.object({
  channel: ContactChannelSchema,
  target: z.string().min(1),
  preferences: PreferencesSchema.optional(),
});
export type AddContactInput = z.infer<typeof AddContactSchema>;

// ─── Templates ────────────────────────────────────────────────────────────────

export const TemplateSchema = z.object({
  id: z.string().min(1),
  channel: NotificationChannelSchema,
  topic: z
    .union([z.string().min(1), z.array(z.string().min(1))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  content: z.record(z.string(), z.unknown()),
  aiPrompts: z.record(z.string(), z.string()).optional(),
});
export type TemplateInput = z.infer<typeof TemplateSchema>;

export const SyncTemplatesSchema = z.object({
  templates: z.array(TemplateSchema).min(1),
});
export type SyncTemplatesInput = z.infer<typeof SyncTemplatesSchema>;

// ─── notify() ─────────────────────────────────────────────────────────────────

/** Inline user object accepted by notify({ user: {...} }). */
export const InlineUserSchema = z.object({
  id: z.string().min(1),
  language: z.string().optional(),
  timezone: z.string().optional(),
  email: stringOrArray.optional(),
  phone: stringOrArray.optional(),
  pushToken: stringOrArray.optional(),
  segments: z.array(z.string().min(1)).optional(),
  preferences: PreferencesSchema.optional(),
});
export type InlineUser = z.infer<typeof InlineUserSchema>;

/**
 * notify(...) request body.
 *
 * Exactly one of `user` / `segment` / `topic` must be provided.
 */
/**
 * The field set shared by `notify()` and a workflow's `notify` step. The two
 * differ only in whether naming a target is mandatory, so the fields live here
 * once and each schema layers its own target rule on top.
 */
const NotifyRequestFields = z.object({
  user: z
    .union([
      z.string().min(1),
      InlineUserSchema,
      z.array(z.union([z.string().min(1), InlineUserSchema])).nonempty(),
    ])
    .optional(),
  segment: z.string().min(1).optional(),
  topic: z.string().min(1).optional(),
  template: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional(),
  aiPrompts: z.record(z.string(), z.string()).optional(),
  priority: NotificationPrioritySchema.optional(),
  channels: z.array(NotificationChannelSchema).nonempty().optional(),
  fallback: z.boolean().optional(),
  sendAt: z.string().datetime().optional(),
  /**
   * A label grouping every message this call produces, so the send can be
   * reported on later via `/v1/campaigns/:id/stats`. Free-form, but reusing one
   * label across calls merges them into a single campaign — which is either
   * what you want (a send split into batches) or a reporting bug.
   */
  campaign: z.string().min(1).max(128).optional(),
});

function countTargets(val: { user?: unknown; segment?: unknown; topic?: unknown }): number {
  return [val.user, val.segment, val.topic].filter((t) => t !== undefined).length;
}

export const NotifyRequestSchema = NotifyRequestFields.superRefine((val, ctx) => {
  const targets = countTargets(val);
  if (targets === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "one of `user`, `segment`, or `topic` is required",
      path: ["user"],
    });
  } else if (targets > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "provide exactly one of `user`, `segment`, or `topic`",
      path: ["user"],
    });
  }
});
export type NotifyRequestInput = z.input<typeof NotifyRequestSchema>;

/**
 * The payload of a workflow `notify` step — every field `notify()` takes.
 *
 * The one difference is that a target is optional here: a step naming none
 * inherits the instance's own user, which is the ordinary case. Naming one
 * overrides that, so a step can notify a different user, a segment, or a topic.
 */
export const WorkflowNotifyPayloadSchema = NotifyRequestFields.superRefine((val, ctx) => {
  if (countTargets(val) > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "provide at most one of `user`, `segment`, or `topic`",
      path: ["user"],
    });
  }
});
export type WorkflowNotifyInput = z.input<typeof WorkflowNotifyPayloadSchema>;

// ─── Workflows ────────────────────────────────────────────────────────────────

export const TriggerWorkflowSchema = z.object({
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
  user: z.union([z.string().min(1), InlineUserSchema]).optional(),
});
export type TriggerWorkflowInput = z.infer<typeof TriggerWorkflowSchema>;

// ─── Events ───────────────────────────────────────────────────────────────────

export const IngestEventSchema = z.object({
  name: z.string().min(1),
  properties: z.record(z.string(), z.unknown()),
});
export type IngestEventInput = z.infer<typeof IngestEventSchema>;

export const WorkflowStepSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("notify"),
    payload: WorkflowNotifyPayloadSchema,
  }),
  z.object({
    action: z.literal("wait"),
    duration: z.string(), // e.g. "1h", "5m"
  }),
  z.object({
    action: z.literal("waitForEvent"),
    event: z.string(),
    options: z
      .object({
        timeout: z.string().optional(), // e.g. "24h"
      })
      .optional(),
  }),
]);
export type WorkflowStepDef = z.infer<typeof WorkflowStepSchema>;

export const CreateWorkflowSchema = z.object({
  name: z.string().min(1),
  steps: z.array(WorkflowStepSchema).min(1),
});
export type CreateWorkflowInput = z.infer<typeof CreateWorkflowSchema>;

// ─── Projects ─────────────────────────────────────────────────────────────────

export const UpdateProjectSchema = z.object({
  rateLimitRpm: z.number().nullable().optional(),
  throttleLimit: z.number().nullable().optional(),
  throttleWindowHours: z.number().nullable().optional(),
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;
