CREATE TYPE "public"."api_key_role" AS ENUM('admin', 'read_only');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('email', 'sms', 'push', 'webhook', 'in-app');--> statement-breakpoint
CREATE TYPE "public"."workflow_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "contact_topic_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"topic" varchar NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "contact_topic_preferences_contact_id_topic_unique" UNIQUE("contact_id","topic")
);
--> statement-breakpoint
CREATE TABLE "delivery_outbox" (
	"task_id" varchar NOT NULL,
	"channel" "channel" NOT NULL,
	"destination" text NOT NULL,
	"provider_message_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_outbox_task_id_channel_destination_pk" PRIMARY KEY("task_id","channel","destination")
);
--> statement-breakpoint
CREATE TABLE "message_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" varchar NOT NULL,
	"provider_message_id" varchar,
	"template_id" varchar,
	"workflow_instance_id" uuid,
	"channel" "channel" NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"kind" varchar DEFAULT 'attempt' NOT NULL,
	"status" varchar NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_channel_attempt_uidx" UNIQUE("task_id","channel","attempt","kind")
);
--> statement-breakpoint
CREATE TABLE "project_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"key_hash" varchar NOT NULL,
	"role" "api_key_role" DEFAULT 'admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar NOT NULL,
	"rate_limit_rpm" integer,
	"throttle_limit" integer,
	"throttle_window_hours" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quiet_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"contact_id" uuid,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	CONSTRAINT "check_owner" CHECK (num_nonnulls(user_id, contact_id) = 1)
);
--> statement-breakpoint
CREATE TABLE "scheduled_payloads" (
	"task_id" varchar PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"project_id" uuid NOT NULL,
	"id" varchar NOT NULL,
	"channel" "channel" NOT NULL,
	"topics" text[] NOT NULL,
	"content" jsonb NOT NULL,
	"ai_prompts" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_project_id_id_pk" PRIMARY KEY("project_id","id")
);
--> statement-breakpoint
CREATE TABLE "user_channel_preferences" (
	"user_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "user_channel_preferences_user_id_channel_pk" PRIMARY KEY("user_id","channel")
);
--> statement-breakpoint
CREATE TABLE "user_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"target" text NOT NULL,
	"label" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_contacts_user_id_channel_target_unique" UNIQUE("user_id","channel","target")
);
--> statement-breakpoint
CREATE TABLE "user_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"segment" varchar NOT NULL,
	CONSTRAINT "user_segments_user_id_segment_unique" UNIQUE("user_id","segment")
);
--> statement-breakpoint
CREATE TABLE "user_topic_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"topic" varchar NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "user_topic_preferences_user_id_topic_unique" UNIQUE("user_id","topic")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_project_id_external_id_unique" UNIQUE("project_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar NOT NULL,
	"steps" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_definitions_project_id_name_unique" UNIQUE("project_id","name")
);
--> statement-breakpoint
CREATE TABLE "workflow_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar NOT NULL,
	"status" "workflow_status" DEFAULT 'pending' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"step_index" varchar NOT NULL,
	"action" varchar NOT NULL,
	"output" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_steps_instance_id_step_index_unique" UNIQUE("instance_id","step_index")
);
--> statement-breakpoint
CREATE TABLE "workflow_waiters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"event_name" varchar NOT NULL,
	"match_criteria" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_topic_preferences" ADD CONSTRAINT "contact_topic_preferences_contact_id_user_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."user_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_api_keys" ADD CONSTRAINT "project_api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiet_hours" ADD CONSTRAINT "quiet_hours_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiet_hours" ADD CONSTRAINT "quiet_hours_contact_id_user_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."user_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_channel_preferences" ADD CONSTRAINT "user_channel_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_contacts" ADD CONSTRAINT "user_contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_segments" ADD CONSTRAINT "user_segments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_topic_preferences" ADD CONSTRAINT "user_topic_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_instance_id_workflow_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."workflow_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_waiters" ADD CONSTRAINT "workflow_waiters_instance_id_workflow_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."workflow_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_logs_project_idx" ON "message_logs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "task_idx" ON "message_logs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "message_logs_project_task_idx" ON "message_logs" USING btree ("project_id","task_id");--> statement-breakpoint
CREATE INDEX "provider_msg_idx" ON "message_logs" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "msg_log_proj_time_idx" ON "message_logs" USING btree ("project_id","timestamp");--> statement-breakpoint
CREATE INDEX "msg_log_template_idx" ON "message_logs" USING btree ("project_id","template_id");--> statement-breakpoint
CREATE INDEX "msg_log_workflow_idx" ON "message_logs" USING btree ("project_id","workflow_instance_id");--> statement-breakpoint
CREATE INDEX "quiet_hours_user_idx" ON "quiet_hours" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "segment_idx" ON "user_segments" USING btree ("segment");--> statement-breakpoint
CREATE INDEX "workflow_name_idx" ON "workflow_instances" USING btree ("name");--> statement-breakpoint
CREATE INDEX "waiter_event_idx" ON "workflow_waiters" USING btree ("event_name");--> statement-breakpoint
CREATE INDEX "waiter_instance_idx" ON "workflow_waiters" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "waiter_comp_idx" ON "workflow_waiters" USING btree ("event_name","project_id","expires_at");--> statement-breakpoint
CREATE INDEX "waiter_match_idx" ON "workflow_waiters" USING gin ("match_criteria");