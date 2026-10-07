import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Logger } from "@/logger/index.js";
import * as schema from "./schema.js";
import { readBaseConfig } from "@/config/index.js";

export type Sql = postgres.Sql;
export type Db = PostgresJsDatabase<typeof schema>;

export interface DatabaseOptions {
  url: string;
  /**
   * Schema holding notifkit's tables. Defaults to `DB_SCHEMA` (`public`).
   * Anything else is set as the connection's `search_path`.
   */
  schema?: string;
  applicationName?: string;
  maxConnections?: number;
  idleTimeoutSeconds?: number;
  logger?: Logger;
}

export interface DatabaseClients {
  sql: Sql;
  db: Db;
}

/**
 * Create a postgres.js connection pool and initialize Drizzle ORM.
 * Call once at application startup; pass db into repositories.
 * Call sql.end() during graceful shutdown.
 */
export function createDatabase({
  url,
  schema: dbSchema,
  applicationName = "notifkit",
  maxConnections,
  idleTimeoutSeconds = 30,
  logger,
}: DatabaseOptions): DatabaseClients {
  const finalMaxConnections = maxConnections ?? readBaseConfig().DB_MAX_CONNECTIONS;
  const finalSchema = resolveSchema(dbSchema);

  const sql = postgres(url, {
    max: finalMaxConnections,
    idle_timeout: idleTimeoutSeconds,
    connection: {
      application_name: applicationName,
      statement_timeout: 10000 as any, // prevent TS issues with postgres.js types
      // Unqualified queries resolve against this schema only, so a same-named
      // table in `public` can never be picked up by mistake.
      ...(finalSchema === DEFAULT_SCHEMA ? {} : { search_path: quoteIdentifier(finalSchema) }),
    },
    onnotice: (notice) => {
      logger?.debug({ notice }, "postgres notice");
    },
  });

  const db = drizzle(sql, { schema });

  return { sql, db };
}

import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getTableName, is, sql as drizzleSql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { fileURLToPath } from "url";
import os from "os";
import path from "path";
import fs from "fs";

const DEFAULT_SCHEMA = "public";
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

export interface MigrationOptions {
  /** Schema to create notifkit's objects in. Defaults to `DB_SCHEMA` (`public`). */
  schema?: string;
  /**
   * Schema of drizzle's migration journal table. Defaults to drizzle's own
   * `drizzle` for `public`, and to `schema` otherwise, so two installs in
   * different schemas of one database never share a journal.
   */
  migrationsSchema?: string;
  /** Name of drizzle's migration journal table. Defaults to `__drizzle_migrations`. */
  migrationsTable?: string;
}

function resolveSchema(schema?: string): string {
  const name = schema ?? readBaseConfig().DB_SCHEMA;
  if (!SCHEMA_NAME.test(name)) {
    throw new Error(`Invalid database schema "${name}": must be a lowercase PostgreSQL identifier`);
  }
  return name;
}

function quoteIdentifier(name: string): string {
  return `"${name}"`;
}

function packagedMigrationsFolder(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const folder = path.resolve(__dirname, "../../drizzle");
  return fs.existsSync(folder) ? folder : path.resolve(__dirname, "../drizzle");
}

/**
 * Retarget one generated migration at `schema`. drizzle-kit qualifies enum
 * types and foreign-key targets with `"public".` but leaves tables and indexes
 * unqualified, so both halves have to move: the qualifier is rewritten, and
 * `SET LOCAL search_path` places the unqualified objects. `SET LOCAL` ends with
 * the migration transaction and never leaks into a pooled connection.
 *
 * Throws if `public` is still mentioned after the rewrite: a migration that
 * spells the schema some other way would otherwise put objects into `public`
 * without a word.
 */
export function qualifyMigrationSql(source: string, schema: string): string {
  const rewritten = source.replaceAll(`"${DEFAULT_SCHEMA}".`, `${quoteIdentifier(schema)}.`);
  if (/\bpublic\b/i.test(rewritten)) {
    throw new Error(
      `Migration still references the public schema after retargeting it to "${schema}"`,
    );
  }
  return `SET LOCAL search_path TO ${quoteIdentifier(schema)};\n${STATEMENT_BREAKPOINT}\n${rewritten}`;
}

/** Copy the journal and every migration it lists into `target`, retargeted at `schema`. */
function writeSchemaMigrations(source: string, target: string, schema: string): void {
  const journalPath = path.join(source, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: { tag: string }[];
  };

  fs.mkdirSync(path.join(target, "meta"));
  fs.copyFileSync(journalPath, path.join(target, "meta", "_journal.json"));
  for (const { tag } of journal.entries) {
    const file = `${tag}.sql`;
    const migration = fs.readFileSync(path.join(source, file), "utf8");
    fs.writeFileSync(path.join(target, file), qualifyMigrationSql(migration, schema));
  }
}

export async function runMigrations(db: Db, options: MigrationOptions = {}) {
  const migrationsFolder = packagedMigrationsFolder();
  const schema = resolveSchema(options.schema);
  const { migrationsTable } = options;

  if (schema === DEFAULT_SCHEMA) {
    await migrate(db, {
      migrationsFolder,
      migrationsTable,
      migrationsSchema: options.migrationsSchema,
    });
    return;
  }

  await db.execute(drizzleSql`CREATE SCHEMA IF NOT EXISTS ${drizzleSql.identifier(schema)}`);

  const retargeted = fs.mkdtempSync(path.join(os.tmpdir(), "notifkit-migrations-"));
  try {
    writeSchemaMigrations(migrationsFolder, retargeted, schema);
    await migrate(db, {
      migrationsFolder: retargeted,
      migrationsTable,
      migrationsSchema: options.migrationsSchema ?? schema,
    });
  } finally {
    fs.rmSync(retargeted, { recursive: true, force: true });
  }

  await assertTablesInSchema(db, schema);
}

/**
 * Names of every table notifkit's Drizzle schema defines, sorted. This is the
 * same object the ORM queries at run time, so the list cannot drift from the
 * tables notifkit actually uses.
 */
export function notifkitTableNames(): string[] {
  return Object.values(schema as Record<string, unknown>)
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => getTableName(table))
    .sort();
}

/**
 * Fail if any notifkit table is missing from `targetSchema`. Run after
 * migrating into a custom schema: if the retargeting ever stops working (the
 * `search_path` is overridden, a migration is skipped because of a shared
 * journal, ...), the tables land elsewhere or nowhere, and every runtime query
 * would fail with "relation does not exist". Only the target schema is checked:
 * the application sharing the database may well own `users` or `projects` in
 * `public`, and that is not an error.
 */
export async function assertTablesInSchema(db: Db, targetSchema: string): Promise<void> {
  const rows = await db.execute<{ table_name: string }>(
    drizzleSql`SELECT table_name FROM information_schema.tables WHERE table_schema = ${targetSchema}`,
  );
  const present = new Set(rows.map((row) => row.table_name));
  const missing = notifkitTableNames().filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Migrations finished, but schema "${targetSchema}" is missing notifkit tables: ${missing.join(", ")}`,
    );
  }
}

/**
 * Apply the bundled migrations to the database at `url` and close the
 * connection, whether or not they succeed. `schema` defaults to `DB_SCHEMA`.
 * This is what `notifkit-migrate` runs.
 */
export async function migrateDatabase({
  url,
  schema: dbSchema,
}: {
  url: string;
  schema?: string;
}): Promise<string> {
  const targetSchema = resolveSchema(dbSchema);
  const { db, sql } = createDatabase({
    url,
    schema: targetSchema,
    applicationName: "notifkit-migrate",
    maxConnections: 1,
  });
  try {
    await runMigrations(db, { schema: targetSchema });
  } finally {
    await sql.end();
  }
  return targetSchema;
}
