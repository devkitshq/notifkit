-- delivery_outbox's key leads with task_id, so GET /v1/users/:id/details,
-- which looks up the sends to a user's addresses, scanned the whole table.
CREATE INDEX IF NOT EXISTS "delivery_outbox_destination_idx" ON "delivery_outbox" USING btree ("destination");
