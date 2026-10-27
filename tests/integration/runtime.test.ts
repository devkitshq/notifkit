import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  hashPassword,
  verifyPassword,
  createAdminSession,
  getAdminSession,
  revokeAdminSession,
  DUMMY_PASSWORD_HASH,
} from "@/services/auth/index.js";
import { loadEnv, parseConfig, baseConfigSchema } from "@/config/index.js";
import { ValidationError } from "@/shared/index.js";
import { createDatabase, runMigrations } from "@/db/index.js";
import { useInfra, waitFor, settle } from "./support/infra.js";

/**
 * Process-level pieces against the real thing: admin sessions in Redis,
 * configuration read from a real .env file, migrations against Postgres, and
 * the server shutting down on a real signal.
 */

const infra = useInfra();

describe("admin sessions", () => {
  const admin = { id: randomUUID(), email: "a@x.com", username: "a", role: "admin" } as any;

  it("creates a session readable by its token, and revokes it", async () => {
    const session = await createAdminSession(infra.redis, admin);
    expect(session.token).toMatch(/^nk_sess_[0-9a-f]{64}$/);
    expect(await getAdminSession(infra.redis, session.token)).toMatchObject({
      adminId: admin.id,
      email: "a@x.com",
      role: "admin",
    });
    expect(await infra.redis.ttl(`notif:session:${session.token}`)).toBeGreaterThan(6 * 24 * 3600);

    await revokeAdminSession(infra.redis, session.token);
    expect(await getAdminSession(infra.redis, session.token)).toBeNull();
    await revokeAdminSession(infra.redis, "");
  });

  it("expires a session at its TTL", async () => {
    const session = await createAdminSession(infra.redis, admin, 1);
    await settle(1_100);
    expect(await getAdminSession(infra.redis, session.token)).toBeNull();
  });

  it("rejects tokens that are not sessions, and corrupt session data", async () => {
    expect(await getAdminSession(infra.redis, "nk_live_abc")).toBeNull();
    expect(await getAdminSession(infra.redis, "")).toBeNull();
    await infra.redis.set("notif:session:nk_sess_corrupt", "{not json");
    expect(await getAdminSession(infra.redis, "nk_sess_corrupt")).toBeNull();
    await infra.redis.set(
      "notif:session:nk_sess_stale",
      JSON.stringify({ expiresAt: Date.now() - 1 }),
    );
    expect(await getAdminSession(infra.redis, "nk_sess_stale")).toBeNull();
    expect(await infra.redis.exists("notif:session:nk_sess_stale")).toBe(0);
  });

  it("hashes passwords with a fresh salt and verifies them", async () => {
    const [a, b] = await Promise.all([hashPassword("pw"), hashPassword("pw")]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("pw", a)).toBe(true);
    expect(await verifyPassword("PW", a)).toBe(false);
    expect(await verifyPassword("pw", "garbage")).toBe(false);
    expect(await verifyPassword("pw", DUMMY_PASSWORD_HASH)).toBe(false);
  });
});

describe("configuration", () => {
  const keys = ["NOTIFKIT_TEST_A", "NOTIFKIT_TEST_B"];
  afterEach(() => keys.forEach((k) => delete process.env[k]));

  it("loads a .env file without overriding what the environment already set", () => {
    const dir = mkdtempSync(join(tmpdir(), "nk-env-"));
    try {
      writeFileSync(join(dir, ".env"), "NOTIFKIT_TEST_A=from-file\nNOTIFKIT_TEST_B=from-file\n");
      process.env.NOTIFKIT_TEST_B = "from-env";
      loadEnv(join(dir, ".env"));
      expect(process.env.NOTIFKIT_TEST_A).toBe("from-file");
      expect(process.env.NOTIFKIT_TEST_B).toBe("from-env");
      loadEnv(join(dir, "missing.env"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies defaults and rejects invalid values field by field", () => {
    const cfg = parseConfig(baseConfigSchema, { ADMIN_API_KEY: "  key \n", PIPELINE_FUSED: "1" });
    expect(cfg).toMatchObject({
      PORT: 3000,
      WORKER_CONCURRENCY: 10,
      ADMIN_API_KEY: "key",
      PIPELINE_FUSED: true,
    });

    const err = (() => {
      try {
        parseConfig(baseConfigSchema, { PORT: "99999", REDIS_URL: "not a url" });
      } catch (e) {
        return e;
      }
    })() as ValidationError;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(Object.keys(err.fields!).sort()).toEqual(["PORT", "REDIS_URL"]);
    expect(parseConfig(z.object({ n: z.coerce.number() }), { n: "4" })).toEqual({ n: 4 });
  });
});

describe("database", () => {
  it("migrations are idempotent on an up-to-date database", async () => {
    const { db, sql } = createDatabase({ url: infra.dbUrl, maxConnections: 1 });
    try {
      await runMigrations(db);
      const [{ n }] =
        (await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`) as any;
      expect(n).toBeGreaterThanOrEqual(8);
      const [{ canceled }] = (await sql`SELECT 'canceled'::workflow_status AS canceled`) as any;
      expect(canceled).toBe("canceled");
    } finally {
      await sql.end();
    }
  });
});

describe("process lifecycle", () => {
  it.skipIf(process.platform === "win32")(
    "shuts the server down gracefully on SIGTERM and exits cleanly",
    async () => {
      // A real module file run by this node binary, not `npx tsx --eval`: tsx
      // compiles an eval snippet as CommonJS, where the top-level await below
      // does not run, so the child exited without ever starting. And a signal
      // sent to an npx wrapper need not reach the server it launched.
      const dir = mkdtempSync(join(tmpdir(), "nk-lifecycle-"));
      const script = join(dir, "server.mts");
      writeFileSync(
        script,
        `
        import { NotifkitServer } from ${JSON.stringify(pathToFileURL(resolve("src/server.ts")).href)};
        const server = new NotifkitServer({
          services: ["enricher", "engine", "delivery"],
          redisUrl: process.env.REDIS_URL, databaseUrl: process.env.DATABASE_URL,
          logLevel: "silent", autoMigrate: false,
        });
        await server.start();
        console.log("READY");
      `,
      );
      const child = spawn(process.execPath, ["--import", "tsx", script], {
        env: { ...process.env, REDIS_URL: infra.redisUrl, DATABASE_URL: infra.dbUrl },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));

      try {
        // Stop waiting as soon as the child dies, and say why it did.
        await waitFor(
          "server ready",
          () => out.includes("READY") || child.exitCode !== null,
          60_000,
        );
        expect(out, `server never started; stderr:\n${err}`).toContain("READY");
        await waitFor(
          "workers reporting",
          async () => (await infra.redis.exists("notif:health:engine")) === 1,
          20_000,
        );
        child.kill("SIGTERM");
        expect(await exited, `stderr:\n${err}`).toBe(0);
      } finally {
        child.kill("SIGKILL");
        rmSync(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );
});

describe("create-admin script", () => {
  const script = resolve(__dirname, "../../scripts/create-admin.mjs");

  function createAdmin(...args: string[]) {
    return new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(process.execPath, [script, ...args], {
        env: { ...process.env, DATABASE_URL: infra.dbUrl, DB_SCHEMA: "public" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (out += c));
      child.on("exit", (code) => done({ code, out }));
    });
  }

  async function roleOf(email: string) {
    const rows = await infra.sql`SELECT role FROM admin_users WHERE email = ${email}`;
    return rows[0]?.role as string | undefined;
  }

  it("saves a dashboard user with a known role", async () => {
    const email = `ro-${randomUUID().slice(0, 8)}@example.com`;
    const { code } = await createAdmin(email, "correct horse", "read_only");
    expect(code).toBe(0);
    expect(await roleOf(email)).toBe("read_only");
  });

  it("refuses a role it does not know, rather than saving one nothing enforces", async () => {
    const email = `typo-${randomUUID().slice(0, 8)}@example.com`;
    const { code, out } = await createAdmin(email, "correct horse", "readonly");
    expect(code).not.toBe(0);
    expect(out).toMatch(/superadmin, admin, read_only/);
    expect(await roleOf(email)).toBeUndefined();
  });
});
