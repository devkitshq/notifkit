import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Logger } from "@/index.js";
import * as schema from "./schema.js";
import { readBaseConfig } from "@/index.js";

export type Sql = postgres.Sql;
export type Db = PostgresJsDatabase<typeof schema>;

export interface DatabaseOptions {
  url: string;
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
  applicationName = "notifkit",
  maxConnections,
  idleTimeoutSeconds = 30,
  logger,
}: DatabaseOptions): DatabaseClients {
  const finalMaxConnections = maxConnections ?? readBaseConfig().DB_MAX_CONNECTIONS;

  const sql = postgres(url, {
    max: finalMaxConnections,
    idle_timeout: idleTimeoutSeconds,
    connection: {
      application_name: applicationName,
      statement_timeout: 10000 as any, // prevent TS issues with postgres.js types
    },
    onnotice: (notice) => {
      logger?.debug({ notice }, "postgres notice");
    },
  });

  const db = drizzle(sql, { schema });

  return { sql, db };
}

import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

export async function runMigrations(db: Db) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  let migrationsFolder = path.resolve(__dirname, "../../drizzle");
  if (!fs.existsSync(migrationsFolder)) {
    migrationsFolder = path.resolve(__dirname, "../drizzle");
  }

  await migrate(db, { migrationsFolder });
}
