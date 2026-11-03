import { sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { Logger } from "@/logger/index.js";
import type { Db } from "@/db/index.js";
import { deliveryOutbox, messageLogs } from "@/db/schema.js";

const BATCH = 5000;
const PRUNE_LOCK_KEY = "notif:lock:scheduler:prune";

/** Deletes delivery log and outbox rows older than `retentionDays`, in batches. */
export async function pruneDeliveryLogs(db: Db, retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const tables = [
    [messageLogs, messageLogs.timestamp],
    [deliveryOutbox, deliveryOutbox.createdAt],
  ] as const;

  let total = 0;
  for (const [table, column] of tables) {
    for (;;) {
      // Small batches keep each delete's locks and WAL short.
      const rows = await db.execute(
        sql`DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${column} < ${cutoff}::timestamptz LIMIT ${BATCH}) RETURNING 1`,
      );
      total += rows.length;
      if (rows.length < BATCH) break;
    }
  }
  return total;
}

/** Runs the prune once per hour across all scheduler processes. */
export async function maybePruneDeliveryLogs(
  redis: Pick<Redis, "set">,
  db: Db,
  logger: Pick<Logger, "info" | "error">,
  retentionDays: number,
): Promise<void> {
  try {
    // Never released: the key expiring is what allows the next run.
    if ((await redis.set(PRUNE_LOCK_KEY, "1", "EX", 3600, "NX")) !== "OK") return;
    const deleted = await pruneDeliveryLogs(db, retentionDays);
    if (deleted > 0) logger.info({ deleted, retentionDays }, "pruned old delivery logs");
  } catch (err) {
    logger.error({ err }, "delivery log prune failed");
  }
}
