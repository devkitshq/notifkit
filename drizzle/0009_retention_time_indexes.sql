-- The hourly retention prune deletes by age; without these it scans both tables.
-- Timestamps only grow, so each insert appends to the right edge of the index.
CREATE INDEX IF NOT EXISTS "msg_log_time_idx" ON "message_logs" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_outbox_created_idx" ON "delivery_outbox" USING btree ("created_at");
