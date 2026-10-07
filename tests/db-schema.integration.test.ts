import { execFile } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type * as Migrator from "drizzle-orm/postgres-js/migrator";
import {
  assertTablesInSchema,
  createDatabase,
  migrateDatabase,
  notifkitTableNames,
  runMigrations,
} from "@/db/index.js";

// When set, every retargeted migration file is passed through this function
// right before drizzle applies it, to simulate the retargeting going wrong.
const sabotage = vi.hoisted(() => ({
  rewrite: null as ((sql: string) => string) | null,
}));

vi.mock("drizzle-orm/postgres-js/migrator", async (importOriginal) => {
  const actual = await importOriginal<typeof Migrator>();
  return {
    ...actual,
    migrate: async (...args: Parameters<typeof actual.migrate>) => {
      const [, config] = args;
      const { rewrite } = sabotage;
      if (rewrite) {
        for (const file of fs.readdirSync(config.migrationsFolder)) {
          if (!file.endsWith(".sql")) continue;
          const target = path.join(config.migrationsFolder, file);
          fs.writeFileSync(target, rewrite(fs.readFileSync(target, "utf8")));
        }
      }
      return actual.migrate(...args);
    },
  };
});

async function sabotaged<T>(rewrite: (sql: string) => string, run: () => Promise<T>) {
  sabotage.rewrite = rewrite;
  try {
    return await run().then(
      () => null,
      (err: Error) => err,
    );
  } finally {
    sabotage.rewrite = null;
  }
}

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrateCli = path.join(root, "scripts", "migrate.mjs");
const builtPackage = path.join(root, "dist", "index.mjs");
const cliIsBuilt =
  fs.existsSync(builtPackage) && fs.readFileSync(builtPackage, "utf8").includes("migrateDatabase");

const migrationCount = (
  JSON.parse(fs.readFileSync(path.join(root, "drizzle", "meta", "_journal.json"), "utf8")) as {
    entries: unknown[];
  }
).entries.length;

let container: StartedPostgreSqlContainer | undefined;
let adminUrl: string;
let admin: postgres.Sql;
const databases: string[] = [];

beforeAll(async () => {
  // NOTIFKIT_TEST_DATABASE_URL points at an existing server (any database the
  // role can CREATE DATABASE from); otherwise a throwaway container is started.
  if (process.env.NOTIFKIT_TEST_DATABASE_URL) {
    adminUrl = process.env.NOTIFKIT_TEST_DATABASE_URL;
  } else {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    adminUrl = container.getConnectionUri();
  }
  admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  for (const name of databases) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin?.end();
  await container?.stop();
});

async function freshDatabase(): Promise<string> {
  const name = `notifkit_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  databases.push(name);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function inspect(url: string, schema: string) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name <> '__drizzle_migrations'
      ORDER BY table_name`;
    const journalSchema = schema === "public" ? "drizzle" : schema;
    const [row] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ${sql(journalSchema)}.__drizzle_migrations`;
    return { tables: tables.map((t) => t.table_name), journal: row!.count };
  } finally {
    await sql.end();
  }
}

describe("migrateDatabase (notifkit-migrate)", () => {
  it("migrates public and is idempotent", async () => {
    const url = await freshDatabase();

    expect(await migrateDatabase({ url, schema: "public" })).toBe("public");
    expect(await inspect(url, "public")).toEqual({
      tables: notifkitTableNames(),
      journal: migrationCount,
    });

    await migrateDatabase({ url, schema: "public" });
    expect(await inspect(url, "public")).toEqual({
      tables: notifkitTableNames(),
      journal: migrationCount,
    });
  });

  it("migrates a custom schema next to the application's own users/projects in public", async () => {
    const url = await freshDatabase();
    const app = postgres(url, { max: 1, onnotice: () => {} });
    await app`CREATE TABLE public.users (id int PRIMARY KEY, login text)`;
    await app`CREATE TABLE public.projects (id int PRIMARY KEY)`;
    await app`INSERT INTO public.users VALUES (1, 'app-user')`;

    try {
      for (let run = 0; run < 2; run++) {
        expect(await migrateDatabase({ url, schema: "notifications" })).toBe("notifications");
        expect(await inspect(url, "notifications")).toEqual({
          tables: notifkitTableNames(),
          journal: migrationCount,
        });
      }

      const publicTables = await app<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`;
      expect(publicTables.map((t) => t.table_name)).toEqual(["projects", "users"]);
      expect(await app`SELECT login FROM public.users`).toEqual([{ login: "app-user" }]);
    } finally {
      await app.end();
    }
  });

  it("rejects when the database cannot be reached", async () => {
    await expect(
      migrateDatabase({
        url: "postgres://nobody@127.0.0.1:1/none",
        schema: "public",
      }),
    ).rejects.toThrow();
  });
});

describe("runMigrations into a custom schema checks the result", () => {
  it("names a table that is missing from the target schema", async () => {
    const url = await freshDatabase();
    await migrateDatabase({ url, schema: "notifications" });

    const sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`DROP TABLE notifications.suppressions`;
    await sql.end();

    // The journal says every migration is applied, so nothing re-creates it.
    await expect(migrateDatabase({ url, schema: "notifications" })).rejects.toThrow(
      'schema "notifications" is missing notifkit tables: suppressions',
    );
  });

  it("names every table when the migrations put them somewhere else", async () => {
    const url = await freshDatabase();
    // The retargeted SQL (SET LOCAL and qualifiers alike) points at another
    // schema: the migration itself succeeds, only the check can notice.
    const error = await sabotaged(
      (sql) =>
        `CREATE SCHEMA IF NOT EXISTS "elsewhere";\n--> statement-breakpoint\n${sql}`.replaceAll(
          '"notifications"',
          '"elsewhere"',
        ),
      () => migrateDatabase({ url, schema: "notifications" }),
    );
    expect(error?.message).toBe(
      `Migrations finished, but schema "notifications" is missing notifkit tables: ${notifkitTableNames().join(", ")}`,
    );
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    const landed = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'elsewhere' ORDER BY table_name`;
    await sql.end();
    expect(landed.map((t) => t.table_name)).toEqual(notifkitTableNames());
  });

  it("names every table when the journal belongs to another schema", async () => {
    const url = await freshDatabase();
    await migrateDatabase({ url, schema: "first" });

    // Sharing first's journal makes drizzle skip every migration for second.
    const { db, sql } = createDatabase({
      url,
      schema: "second",
      maxConnections: 1,
    });
    try {
      await expect(
        runMigrations(db, { schema: "second", migrationsSchema: "first" }),
      ).rejects.toThrow(
        `schema "second" is missing notifkit tables: ${notifkitTableNames().join(", ")}`,
      );
    } finally {
      await sql.end();
    }
  });

  it("does not let tables fall through to public when SET LOCAL is lost", async () => {
    const url = await freshDatabase();
    // A connection without search_path, and the SET LOCAL line removed.
    const { db, sql } = createDatabase({
      url,
      schema: "public",
      maxConnections: 1,
    });
    try {
      const error = await sabotaged(
        (source) => source.replace(/^SET LOCAL search_path[^\n]*\n[^\n]*\n/, ""),
        () => runMigrations(db, { schema: "notifications" }),
      );
      expect(error).not.toBeNull();
      const leaked = await sql`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
      expect(leaked).toEqual([]); // the migration transaction rolled back
    } finally {
      await sql.end();
    }
  });

  it("assertTablesInSchema ignores notifkit-named tables in other schemas", async () => {
    const url = await freshDatabase();
    await migrateDatabase({ url, schema: "public" });
    const { db, sql } = createDatabase({
      url,
      schema: "public",
      maxConnections: 1,
    });
    try {
      await db.execute("CREATE SCHEMA empty_target");
      await expect(assertTablesInSchema(db, "empty_target")).rejects.toThrow(
        `missing notifkit tables: ${notifkitTableNames().join(", ")}`,
      );
      await expect(assertTablesInSchema(db, "public")).resolves.toBeUndefined();
    } finally {
      await sql.end();
    }
  });
});

describe.skipIf(!cliIsBuilt)("notifkit-migrate CLI (needs `npm run build`)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "notifkit-cli-")); // no stray .env
  const run = (env: Record<string, string>) =>
    execFileAsync(process.execPath, [migrateCli], {
      cwd,
      env: { PATH: process.env.PATH ?? "", ...env },
    }).then(
      ({ stdout }) => ({ code: 0, stdout, stderr: "" }),
      (err: { code: number; stdout: string; stderr: string }) => err,
    );

  afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));

  it("exits 0 and migrates DB_SCHEMA, twice", async () => {
    const url = await freshDatabase();
    for (let i = 0; i < 2; i++) {
      const result = await run({
        DATABASE_URL: url,
        DB_SCHEMA: "notifications",
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Migrations applied to schema "notifications".');
    }
    expect((await inspect(url, "notifications")).tables).toEqual(notifkitTableNames());
  });

  it("exits non-zero when the database cannot be reached", async () => {
    const result = await run({
      DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Failed to run migrations");
  });

  it("exits non-zero without DATABASE_URL", async () => {
    const result = await run({});
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });
});
