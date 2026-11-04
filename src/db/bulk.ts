import { sql as drizzleSql } from "drizzle-orm";
import { deliveryOutbox, messageLogs } from "./schema.js";

/**
 * Bulk writes for the tables every delivery touches. One fixed `unnest()`
 * statement instead of Drizzle's per-row parameters, which was a worker's
 * biggest CPU cost. Non-postgres.js handles fall back to plain Drizzle.
 */

interface RawClient {
  unsafe: (query: string, params: unknown[], options?: { prepare?: boolean }) => Promise<unknown>;
}

function rawClient(db: any): RawClient | null {
  const client = db?.$client;
  return client && typeof client.unsafe === "function" ? client : null;
}

export interface MessageLogRow {
  projectId: string;
  taskId: string;
  providerMessageId: string | null;
  channel: string;
  attempt: number;
  kind: string;
  status: string;
  templateId: string | null;
  workflowInstanceId: string | null;
  campaignId: string | null;
  /** ISO time the event happened; the insert time when omitted. */
  timestamp?: string;
}

const INSERT_MESSAGE_LOGS = `
  INSERT INTO message_logs
    (project_id, task_id, provider_message_id, channel, attempt, kind, status,
     template_id, workflow_instance_id, campaign_id, "timestamp")
  SELECT project_id::uuid, task_id, provider_message_id, channel::channel, attempt, kind, status,
         template_id, workflow_instance_id::uuid, campaign_id, COALESCE(ts::timestamptz, now())
  FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[],
              $8::text[], $9::text[], $10::text[], $11::text[])
    AS t(project_id, task_id, provider_message_id, channel, attempt, kind, status,
         template_id, workflow_instance_id, campaign_id, ts)
  ON CONFLICT DO NOTHING`;

/** Inserts delivery log rows, skipping any already recorded. */
export async function insertMessageLogs(db: any, rows: MessageLogRow[]): Promise<void> {
  if (rows.length === 0) return;
  const client = rawClient(db);
  if (!client) {
    await db
      .insert(messageLogs)
      .values(
        rows.map(({ timestamp, ...r }) =>
          timestamp ? { ...r, timestamp: new Date(timestamp) } : r,
        ),
      )
      .onConflictDoNothing();
    return;
  }
  await client.unsafe(
    INSERT_MESSAGE_LOGS,
    [
      rows.map((r) => r.projectId),
      rows.map((r) => r.taskId),
      rows.map((r) => r.providerMessageId),
      rows.map((r) => r.channel),
      rows.map((r) => r.attempt),
      rows.map((r) => r.kind),
      rows.map((r) => r.status),
      rows.map((r) => r.templateId),
      rows.map((r) => r.workflowInstanceId),
      rows.map((r) => r.campaignId),
      rows.map((r) => r.timestamp ?? null),
    ],
    { prepare: true },
  );
}

export interface OutboxRow {
  taskId: string;
  channel: string;
  destination: string;
  providerMessageId: string | null;
}

const UPSERT_OUTBOX = `
  INSERT INTO delivery_outbox (task_id, channel, destination, provider_message_id)
  SELECT task_id, channel::channel, destination, provider_message_id
  FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
    AS t(task_id, channel, destination, provider_message_id)
  ON CONFLICT (task_id, channel, destination)
  DO UPDATE SET provider_message_id = EXCLUDED.provider_message_id`;

/** Records the provider's message id for each sent task, inserting rows as needed. */
export async function upsertOutboxProviderIds(db: any, rows: OutboxRow[]): Promise<void> {
  if (rows.length === 0) return;
  // ON CONFLICT DO UPDATE refuses to touch one row twice in a statement, which
  // a retried task landing in the same batch as its first attempt would do.
  const byKey = new Map<string, OutboxRow>();
  for (const r of rows) byKey.set(`${r.taskId}\u0000${r.channel}\u0000${r.destination}`, r);
  const unique = [...byKey.values()];

  const client = rawClient(db);
  if (!client) {
    await db
      .insert(deliveryOutbox)
      .values(unique)
      .onConflictDoUpdate({
        target: [deliveryOutbox.taskId, deliveryOutbox.channel, deliveryOutbox.destination],
        set: { providerMessageId: drizzleSql`EXCLUDED.provider_message_id` },
      });
    return;
  }
  await client.unsafe(
    UPSERT_OUTBOX,
    [
      unique.map((r) => r.taskId),
      unique.map((r) => r.channel),
      unique.map((r) => r.destination),
      unique.map((r) => r.providerMessageId),
    ],
    { prepare: true },
  );
}
