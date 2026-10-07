#!/usr/bin/env node
/**
 * Apply notifkit's database migrations.
 *
 * Reads DATABASE_URL and DB_SCHEMA (from the environment or .env) and runs the
 * same migrations NotifkitServer runs on start-up with autoMigrate, into the
 * same schema. Safe to run repeatedly: already-applied migrations are skipped.
 * Exits non-zero if anything fails.
 *
 * Usage:
 *   DATABASE_URL=postgres://user:pass@host:5432/db npx notifkit-migrate
 *   DATABASE_URL=... DB_SCHEMA=notifications npx notifkit-migrate
 *   node scripts/migrate.mjs
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env") });

if (!process.env.DATABASE_URL) {
  console.error("Usage: DATABASE_URL=postgres://... [DB_SCHEMA=schema] npx notifkit-migrate");
  process.exit(1);
}

try {
  // Imported after .env is loaded: the package reads DB_SCHEMA from the environment.
  const { migrateDatabase } = await import("../dist/index.mjs");
  const schema = await migrateDatabase({ url: process.env.DATABASE_URL });
  console.log(`Migrations applied to schema "${schema}".`);
} catch (err) {
  console.error(`Failed to run migrations: ${describe(err)}`);
  process.exitCode = 1;
}

/** drizzle wraps driver errors as "Failed query: ..."; the cause says what actually went wrong. */
function describe(err) {
  const parts = [err.message];
  if (err.fields) parts.push(JSON.stringify(err.fields));
  const cause = err.cause;
  if (cause) parts.push(`cause: ${cause.message || cause.code || String(cause)}`);
  return parts.join("\n  ");
}
