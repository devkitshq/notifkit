CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"target" varchar NOT NULL,
	"reason" varchar NOT NULL,
	"source" varchar,
	"task_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppression_project_channel_target_uidx" UNIQUE("project_id","channel","target")
);
--> statement-breakpoint
ALTER TABLE "message_logs" ADD COLUMN "campaign_id" varchar;--> statement-breakpoint
ALTER TABLE "message_logs" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
CREATE INDEX "suppression_project_idx" ON "suppressions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "suppression_lookup_idx" ON "suppressions" USING btree ("project_id","channel","target");--> statement-breakpoint
CREATE INDEX "msg_log_campaign_idx" ON "message_logs" USING btree ("project_id","campaign_id");