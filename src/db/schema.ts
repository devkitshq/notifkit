import {
  pgTable,
  varchar,
  text,
  jsonb,
  boolean,
  timestamp,
  primaryKey,
  unique,
  uuid,
  pgEnum,
  time,
  check,
  index,
  integer,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const channelEnum = pgEnum("channel", [
  "email",
  "sms",
  "push",
  "webhook",
  "in-app",
  "whatsapp",
]);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name").notNull(),
  rateLimitRpm: integer("rate_limit_rpm"),
  throttleLimit: integer("throttle_limit"),
  throttleWindowHours: integer("throttle_window_hours"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    externalId: text("external_id").notNull(),
    attributes: jsonb("attributes").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    unq: unique().on(table.projectId, table.externalId),
  }),
);

export const apiKeyRoleEnum = pgEnum("api_key_role", ["admin", "read_only"]);

export const projectApiKeys = pgTable("project_api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  keyHash: varchar("key_hash").notNull().unique(),
  role: apiKeyRoleEnum("role").notNull().default("admin"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const userSegments = pgTable(
  "user_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    segment: varchar("segment").notNull(),
  },
  (table) => ({
    unq: unique().on(table.userId, table.segment),
    segmentIdx: index("segment_idx").on(table.segment),
  }),
);

export const userContacts = pgTable(
  "user_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channel: channelEnum("channel").notNull(),
    target: text("target").notNull(),
    label: text("label"),
    isPrimary: boolean("is_primary").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    unq: unique().on(table.userId, table.channel, table.target),
  }),
);

export const userChannelPreferences = pgTable(
  "user_channel_preferences",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channel: channelEnum("channel").notNull(),
    enabled: boolean("enabled").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.channel] }),
  }),
);

export const userTopicPreferences = pgTable(
  "user_topic_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    topic: varchar("topic").notNull(),
    enabled: boolean("enabled").notNull(),
  },
  (table) => ({
    unq: unique().on(table.userId, table.topic),
  }),
);

export const contactTopicPreferences = pgTable(
  "contact_topic_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => userContacts.id, { onDelete: "cascade" }),
    topic: varchar("topic").notNull(),
    enabled: boolean("enabled").notNull(),
  },
  (table) => ({
    unq: unique().on(table.contactId, table.topic),
  }),
);

export const quietHours = pgTable(
  "quiet_hours",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => userContacts.id, { onDelete: "cascade" }),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
  },
  (table) => ({
    checkOwner: check("check_owner", sql`num_nonnulls(user_id, contact_id) = 1`),
    userIdIdx: index("quiet_hours_user_idx").on(table.userId),
  }),
);

export const templates = pgTable(
  "templates",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    id: varchar("id").notNull(),
    channel: channelEnum("channel").notNull(),
    topics: text("topics").array().notNull(),
    content: jsonb("content").notNull(),
    aiPrompts: jsonb("ai_prompts"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.id] }),
  }),
);

export const messageLogs = pgTable(
  "message_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    taskId: varchar("task_id").notNull(),
    providerMessageId: varchar("provider_message_id"),
    templateId: varchar("template_id"),
    workflowInstanceId: uuid("workflow_instance_id"),
    channel: channelEnum("channel").notNull(),
    // Delivery attempts are numbered from 1; provider engagement events are not
    // attempts and use 0.
    attempt: integer("attempt").default(1).notNull(),
    /**
     * Discriminates a delivery attempt ("attempt") from a provider engagement
     * event ("opened", "clicked", "bounced", …). Without it an engagement row
     * collides with the delivery row for the same (task, channel, attempt).
     */
    kind: varchar("kind").notNull().default("attempt"),
    status: varchar("status").notNull(),
    /**
     * Groups every message produced by one `notify()` call. Null for sends that
     * did not name a campaign, which is every send made before this column
     * existed — treat null as "unattributed", not as a campaign of its own.
     */
    campaignId: varchar("campaign_id"),
    /**
     * Provider-specific detail that would otherwise be discarded: the clicked
     * URL on a click event, the bounce subtype on a bounce. Deliberately loose
     * — every provider reports these differently.
     */
    metadata: jsonb("metadata"),
    timestamp: timestamp("timestamp", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index("message_logs_project_idx").on(table.projectId),
    taskIdx: index("task_idx").on(table.taskId),
    projectIdTaskIdIdx: index("message_logs_project_task_idx").on(table.projectId, table.taskId),
    providerMsgIdx: index("provider_msg_idx").on(table.providerMessageId),
    projectTimeIdx: index("msg_log_proj_time_idx").on(table.projectId, table.timestamp),
    templateIdx: index("msg_log_template_idx").on(table.projectId, table.templateId),
    workflowIdx: index("msg_log_workflow_idx").on(table.projectId, table.workflowInstanceId),
    campaignIdx: index("msg_log_campaign_idx").on(table.projectId, table.campaignId),
    taskChannelAttemptUidx: unique("task_channel_attempt_uidx").on(
      table.taskId,
      table.channel,
      table.attempt,
      table.kind,
    ),
  }),
);

/**
 * Addresses that must not be contacted again on a given channel.
 *
 * Rows are written from provider webhooks (an unsubscribe, a spam complaint, a
 * hard bounce) and by hand through the API. The engine consults this table
 * before dispatching, so a suppression is a hard stop rather than a preference
 * — `priority: "critical"` does not override it. Removing a row is the only way
 * back, and that is deliberately a manual act.
 */
export const suppressions = pgTable(
  "suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    channel: channelEnum("channel").notNull(),
    /** The address itself, normalised: email is lower-cased, others stored verbatim. */
    target: varchar("target").notNull(),
    /** `unsubscribed` | `complained` | `bounced` | `manual`. */
    reason: varchar("reason").notNull(),
    /** Where it came from — a provider name, or `api` for a manual entry. */
    source: varchar("source"),
    /** The delivery that triggered it, when a provider webhook is the origin. */
    taskId: varchar("task_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // One row per address per channel; a second complaint must not error.
    projectChannelTargetUidx: unique("suppression_project_channel_target_uidx").on(
      table.projectId,
      table.channel,
      table.target,
    ),
    projectIdx: index("suppression_project_idx").on(table.projectId),
    // The engine's hot path: "is this address suppressed on this channel?"
    lookupIdx: index("suppression_lookup_idx").on(table.projectId, table.channel, table.target),
  }),
);

export const workflowStatusEnum = pgEnum("workflow_status", [
  "pending",
  "running",
  "completed",
  "failed",
]);

export const workflowDefinitions = pgTable(
  "workflow_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    name: varchar("name").notNull(),
    steps: jsonb("steps").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    nameUnq: unique().on(table.projectId, table.name),
  }),
);

export const workflowInstances = pgTable(
  "workflow_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    name: varchar("name").notNull(),
    status: workflowStatusEnum("status").notNull().default("pending"),
    input: jsonb("input").default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    nameIdx: index("workflow_name_idx").on(table.name),
  }),
);

export const workflowSteps = pgTable(
  "workflow_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => workflowInstances.id, { onDelete: "cascade" }),
    stepIndex: varchar("step_index").notNull(), // We can use string format for index (e.g. "0", "1", "0.1") or a deterministic id
    action: varchar("action").notNull(), // e.g. "notify", "wait", "run"
    output: jsonb("output"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    unq: unique().on(table.instanceId, table.stepIndex),
  }),
);

export const workflowWaiters = pgTable(
  "workflow_waiters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => workflowInstances.id, { onDelete: "cascade" }),
    eventName: varchar("event_name").notNull(),
    matchCriteria: jsonb("match_criteria").notNull(), // { userId: "123" }
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    eventIdx: index("waiter_event_idx").on(table.eventName),
    instanceIdx: index("waiter_instance_idx").on(table.instanceId),
    compositeWaitIdx: index("waiter_comp_idx").on(
      table.eventName,
      table.projectId,
      table.expiresAt,
    ),
    matchCriteriaIdx: index("waiter_match_idx").using("gin", table.matchCriteria),
  }),
);

export const deliveryOutbox = pgTable(
  "delivery_outbox",
  {
    taskId: varchar("task_id").notNull(),
    channel: channelEnum("channel").notNull(),
    destination: text("destination").notNull(),
    providerMessageId: varchar("provider_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.taskId, table.channel, table.destination] }),
  }),
);

export const scheduledPayloads = pgTable("scheduled_payloads", {
  taskId: varchar("task_id").primaryKey(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Generated Zod Schemas ──────────────────────────────────────────────────

export const insertProjectSchema = createInsertSchema(projects);
export const selectProjectSchema = createSelectSchema(projects);

export const insertProjectApiKeySchema = createInsertSchema(projectApiKeys);
export const selectProjectApiKeySchema = createSelectSchema(projectApiKeys);

export const insertUserSchema = createInsertSchema(users);
export const selectUserSchema = createSelectSchema(users);

export const insertUserSegmentSchema = createInsertSchema(userSegments);
export const selectUserSegmentSchema = createSelectSchema(userSegments);

export const insertUserContactSchema = createInsertSchema(userContacts);
export const selectUserContactSchema = createSelectSchema(userContacts);

export const insertUserChannelPreferenceSchema = createInsertSchema(userChannelPreferences);
export const selectUserChannelPreferenceSchema = createSelectSchema(userChannelPreferences);

export const insertUserTopicPreferenceSchema = createInsertSchema(userTopicPreferences);
export const selectUserTopicPreferenceSchema = createSelectSchema(userTopicPreferences);

export const insertMessageLogSchema = createInsertSchema(messageLogs);
export const selectMessageLogSchema = createSelectSchema(messageLogs);

export const insertSuppressionSchema = createInsertSchema(suppressions);
export const selectSuppressionSchema = createSelectSchema(suppressions);

export const insertWorkflowInstanceSchema = createInsertSchema(workflowInstances);
export const selectWorkflowInstanceSchema = createSelectSchema(workflowInstances);

export const insertWorkflowStepSchema = createInsertSchema(workflowSteps);
export const selectWorkflowStepSchema = createSelectSchema(workflowSteps);

export const insertWorkflowWaiterSchema = createInsertSchema(workflowWaiters);
export const selectWorkflowWaiterSchema = createSelectSchema(workflowWaiters);

export const insertDeliveryOutboxSchema = createInsertSchema(deliveryOutbox);
export const selectDeliveryOutboxSchema = createSelectSchema(deliveryOutbox);

export const insertScheduledPayloadSchema = createInsertSchema(scheduledPayloads);
export const selectScheduledPayloadSchema = createSelectSchema(scheduledPayloads);
