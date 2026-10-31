import { z } from "zod";
import { NotificationChannelSchema, NotificationPrioritySchema } from "./common.js";

// ─── Preferences ──────────────────────────────────────────────────────────────
//
// Preferences are stored as JSONB and are intentionally open-ended so new
// channels/topics can be added without a migration. `channels` and `topics`
// are boolean opt-in maps; `quietHours` is a list of
// HH:MM windows in the user's own timezone.

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

/** Channels that carry an addressable target (email address, phone, push token, url, chat id). */
export const ContactChannelSchema = NotificationChannelSchema;
export type ContactChannel = z.infer<typeof ContactChannelSchema>;

/** Accept a single value or an array; always normalise to a non-empty array. */
const stringOrArray = z
  .union([z.string().min(1), z.array(z.string().min(1))])
  .transform((v) => (Array.isArray(v) ? v : [v]));

export const UserContactInputSchema = z.object({
  channel: ContactChannelSchema,
  target: z.string().min(1),
  label: z.string().optional(),
  isPrimary: z.boolean().optional(),
  enabled: z.boolean().optional(),
  preferences: PreferencesSchema.optional(),
});
export type UserContactInput = z.infer<typeof UserContactInputSchema>;

// ─── Users ────────────────────────────────────────────────────────────────────

/**
 * addUser({ id, contacts, email, phone, pushToken, segments, preferences })
 * email / phone / pushToken accept a single string or an array for backwards compatibility.
 * Prefer `contacts: [{ channel, target }]`.
 */
export const AddUserSchema = z.object({
  id: z.string().min(1),
  language: z.string().optional(),
  timezone: z.string().optional(),
  contacts: z.array(UserContactInputSchema).optional(),
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
  contacts: z.array(UserContactInputSchema).optional(),
  email: stringOrArray.optional(),
  phone: stringOrArray.optional(),
  pushToken: stringOrArray.optional(),
  segments: z.array(z.string().min(1)).optional(),
  preferences: PreferencesSchema.optional(),
});
export type UpdateUserInput = z.input<typeof UpdateUserSchema>;

/** addUserContact(userId, channel, { target, preferences, label, isPrimary, enabled }) */
export const AddContactSchema = UserContactInputSchema;
export type AddContactInput = z.infer<typeof AddContactSchema>;

export const BatchAddContactsSchema = z.union([AddContactSchema, z.array(AddContactSchema).min(1)]);
export type BatchAddContactsInput = z.infer<typeof BatchAddContactsSchema>;

// ─── Templates ────────────────────────────────────────────────────────────────

export const TemplateSchema = z.object({
  id: z.string().min(1),
  channel: NotificationChannelSchema,
  topic: stringOrArray.optional(),
  content: z.record(z.string(), z.unknown()),
  aiPrompts: z.record(z.string(), z.string()).optional(),
});
export type TemplateInput = z.input<typeof TemplateSchema>;

export const SyncTemplatesSchema = z.object({
  templates: z.array(TemplateSchema).min(1),
});
export type SyncTemplatesInput = z.input<typeof SyncTemplatesSchema>;

// ─── notify() ─────────────────────────────────────────────────────────────────

/** Inline user object accepted by notify({ user: {...} }). */
export const InlineUserSchema = AddUserSchema;
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
export type TriggerWorkflowInput = z.input<typeof TriggerWorkflowSchema>;

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
        /**
         * Fields the event must carry to wake this instance, e.g.
         * `{ userId: "u1" }`. Without it any event of that name in the project
         * wakes every instance waiting on it.
         */
        match: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  }),
]);
export type WorkflowStepDef = z.infer<typeof WorkflowStepSchema>;

export const CreateWorkflowSchema = z.object({
  name: z.string().min(1),
  steps: z.array(WorkflowStepSchema).min(1),
});
export type CreateWorkflowInput = z.input<typeof CreateWorkflowSchema>;

// ─── Projects ─────────────────────────────────────────────────────────────────

export const UpdateProjectSchema = z.object({
  rateLimitRpm: z.number().nullable().optional(),
  throttleLimit: z.number().nullable().optional(),
  throttleWindowHours: z.number().nullable().optional(),
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;

// ─── Response Entities ────────────────────────────────────────────────────────

export interface UserContactResponse {
  id: string;
  userId: string;
  channel: ContactChannel;
  target: string;
  label?: string | null;
  isPrimary?: boolean;
  active?: boolean;
  enabled?: boolean;
  preferences?: Preferences;
}

export interface UserProfileResponse {
  userId: string;
  language?: string;
  timezone?: string;
  email?: string | null;
}

export interface UserResponse extends UserProfileResponse {
  segments: string[];
  preferences: Preferences;
  contacts?: UserContactResponse[];
}

export interface UserDetailResponse extends UserResponse {
  contacts: UserContactResponse[];
  /** The 50 most recent delivery-log rows for this user's addresses. */
  logs: NotificationLogRecord[];
}

export interface WorkflowDefinitionRecord {
  id: string;
  name: string;
  steps: unknown[];
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkflowStepRecord {
  id: string;
  instanceId: string;
  stepIndex: string;
  action: "notify" | "wait" | "waitForEvent" | "run" | string;
  output: unknown;
  error: string | null;
  createdAt: string;
}

export interface WorkflowWaiterRecord {
  id: string;
  instanceId: string;
  eventName: string;
  matchCriteria: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
}

export interface WorkflowInstanceRecord {
  id: string;
  projectId: string;
  name: string;
  status: "pending" | "running" | "completed" | "failed" | "canceled";
  input?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  steps: WorkflowStepRecord[];
  waiters: WorkflowWaiterRecord[];
}

/** One row of the delivery log, as the API returns it. */
export interface NotificationLogRecord {
  id: string;
  projectId: string;
  taskId: string;
  providerMessageId: string | null;
  templateId: string | null;
  workflowInstanceId: string | null;
  channel: string;
  attempt: number;
  /** `dispatched`, `attempt`, or an engagement event such as `opened`. */
  kind: string;
  status: string;
  campaignId: string | null;
  metadata: Record<string, unknown> | null;
  timestamp: string;
}

export interface TemplateRecordResponse {
  id: string;
  channel: string;
  topics: string[];
  content: Record<string, unknown>;
  aiPrompts?: Record<string, string> | null;
}

export interface SuppressionRecord {
  id: string;
  projectId: string;
  channel: string;
  target: string;
  reason: string;
  source: string | null;
  taskId: string | null;
  createdAt: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  rateLimitRpm?: number | null;
  throttleLimit?: number | null;
  throttleWindowHours?: number | null;
  createdAt: string;
}

/** A key as listed: the secret itself is only ever returned once, on creation. */
export interface ProjectKeyRecord {
  id: string;
  role: "admin" | "read_only";
  createdAt: string;
}

export interface CreatedProjectKeyRecord {
  id: string;
  apiKey: string;
  role: "admin" | "read_only";
}

export interface SystemHealthRecord {
  status: "healthy" | "degraded";
  redis: { ok: boolean; latencyMs: number };
  db: { ok: boolean; latencyMs: number };
  /** Each worker's last heartbeat, or `{ status: "unknown" }` when none arrived. */
  workers: Record<string, Record<string, unknown>>;
}

export interface SystemMetricsRecord {
  /** Unconsumed backlog per stream. Empty for project-scoped callers. */
  streams: Record<string, number>;
  deliveryStats: {
    total: number;
    delivered: number;
    failed: number;
    successRate: number;
  };
}

export interface DLQMessageRecord {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  /** Why the message was dead-lettered. */
  error: string;
  timestamp: string;
  /** The stream it failed on, where a replay puts it back. */
  originalStream?: string;
}
