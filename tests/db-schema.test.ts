import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { notifkitTableNames, qualifyMigrationSql } from "@/db/index.js";

const drizzleFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
const journal = JSON.parse(
  fs.readFileSync(path.join(drizzleFolder, "meta", "_journal.json"), "utf8"),
) as { entries: { tag: string }[] };
const migrations = journal.entries.map(({ tag }) => ({
  tag,
  source: fs.readFileSync(path.join(drizzleFolder, `${tag}.sql`), "utf8"),
}));

describe("qualifyMigrationSql", () => {
  it.each(migrations)("retargets $tag without leaving public behind", ({ source }) => {
    const qualified = qualifyMigrationSql(source, "notifications");

    expect(qualified).not.toMatch(/\bpublic\b/i);
    expect(qualified.split('"notifications".').length).toBe(source.split('"public".').length);
    expect(
      qualified.startsWith('SET LOCAL search_path TO "notifications";\n--> statement-breakpoint\n'),
    ).toBe(true);
  });

  it("rewrites every qualifier drizzle-kit emitted", () => {
    const total = migrations.reduce((n, { source }) => n + source.split('"public".').length - 1, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("refuses a migration that names public in a form it does not rewrite", () => {
    const source =
      'CREATE TABLE "a" ("id" int);\n--> statement-breakpoint\nGRANT SELECT ON public.a TO x;';
    expect(() => qualifyMigrationSql(source, "notifications")).toThrow(/public schema/);
  });

  it("leaves a column whose name merely starts with public alone", () => {
    const source = 'ALTER TABLE "projects" ADD COLUMN "public_url" text;';
    expect(() => qualifyMigrationSql(source, "notifications")).not.toThrow();
  });
});

describe("notifkitTableNames", () => {
  it("lists exactly the tables the bundled migrations create", () => {
    const created = migrations
      .flatMap(({ source }) => [...source.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"(\w+)"/g)])
      .map((match) => match[1]);
    expect(notifkitTableNames()).toEqual([...new Set(created)].sort());
  });
});

describe("notifkit-migrate packaging", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    bin: Record<string, string>;
    files: string[];
  };

  it("is published as a bin next to notifkit-create-admin", () => {
    expect(pkg.bin["notifkit-migrate"]).toBe("./scripts/migrate.mjs");
    expect(pkg.files).toContain("scripts/migrate.mjs");
    expect(fs.existsSync(path.join(root, "scripts", "migrate.mjs"))).toBe(true);
  });
});
