import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { NotifkitServer } from "../../src/server.js";
import { createDatabase, runMigrations } from "../../src/db/index.js";
import { STREAMS, buildStreamEvent } from "../../src/contracts/index.js";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type { Transport, DeliveryResult } from "../../src/transport/index.js";

const NUM_MESSAGES = 5000;

class MockCounterTransport implements Transport {
  public readonly channel = "email";
  public deliveredCount = 0;
  async send(): Promise<DeliveryResult> {
    this.deliveredCount++;
    return { success: true };
  }
}

describe("Recovery Testing (Infra Failures)", () => {
  let pgContainer: any;
  let redisContainer: any;
  let server: NotifkitServer;
  let dbUrl: string;
  let redisUrl: string;
  let redis: any;
  let sql: any;
  let mockTransport = new MockCounterTransport();
  let projectId: string;
  let userId: string;

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer("postgres:15-alpine").start();
    redisContainer = await new RedisContainer("redis:alpine").start();

    dbUrl = pgContainer.getConnectionUri();
    redisUrl = redisContainer.getConnectionUrl();

    const dbData = createDatabase({ url: dbUrl });
    sql = dbData.sql;
    await runMigrations(dbData.db);

    redis = new Redis(redisUrl, { maxRetriesPerRequest: null }); // allow reconnects

    projectId = randomUUID();
    userId = randomUUID();
    await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'Test')`;
    await sql`INSERT INTO users (id, project_id, external_id) VALUES (${userId}, ${projectId}, 'recovery-user')`;
    await sql`INSERT INTO user_contacts (id, user_id, channel, target, is_primary) VALUES (${randomUUID()}, ${userId}, 'email', 'test@example.com', true)`;
    await sql`INSERT INTO templates (project_id, id, channel, topics, content) VALUES (${projectId}, 'welcome', 'email', '{}', '{"subject": "Welcome", "text": "Hello"}')`;

    server = new NotifkitServer({
      services: ["enricher", "engine", "scheduler", "delivery"],
      redisUrl,
      databaseUrl: dbUrl,
      logLevel: "warn",
      autoMigrate: false,
      providers: [mockTransport],
    });

    await server.start();
  }, 60_000);

  afterAll(async () => {
    try {
      await server?.stop();
    } catch (_e) {}
    try {
      await sql?.end();
    } catch (_e) {}
    try {
      await redis?.quit();
    } catch (_e) {}
    try {
      await pgContainer?.stop();
    } catch (_e) {}
    try {
      await redisContainer?.stop();
    } catch (_e) {}
  }, 120_000);

  it("should process all notifications despite Redis and Postgres restarts", async () => {
    console.log(`Injecting ${NUM_MESSAGES} messages while restarting infrastructure...`);

    let injected = 0;
    let chaosActive = true;
    const injectLoop = async () => {
      while (injected < NUM_MESSAGES) {
        try {
          const event = buildStreamEvent(
            "notification.requested",
            {
              projectId,
              target: { type: "user", userId: "recovery-user" },
              channels: ["email"],
              templateId: "welcome",
              priority: "critical",
            } as any,
            "test",
            `trace-${injected}`,
          );
          const fullEvent = { ...event, id: randomUUID(), timestamp: new Date().toISOString() };

          await redis.xadd(STREAMS.INBOUND_NORMAL, "*", "data", JSON.stringify(fullEvent));
          injected++;
        } catch (_err) {
          // Ignore inject errors during redis downtime, just retry
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    };

    // Start injecting in background
    const injectPromise = injectLoop();

    // Unified Chaos monkey for Infra
    const infraChaos = async () => {
      const { execSync } = await import("node:child_process");
      const pgId = pgContainer.getId();
      const redisId = redisContainer.getId();

      while (chaosActive) {
        await new Promise((r) => setTimeout(r, Math.random() * 3000 + 1000));

        const target = Math.random();
        let pausePg = false,
          pauseRedis = false;

        if (target < 0.33) pausePg = true;
        else if (target < 0.66) pauseRedis = true;
        else {
          pausePg = true;
          pauseRedis = true;
        }

        if (pausePg) {
          console.log("🛑 Stopping Postgres...");
          execSync(`docker pause ${pgId}`, { stdio: "ignore" });
        }
        if (pauseRedis) {
          console.log("🛑 Stopping Redis...");
          execSync(`docker pause ${redisId}`, { stdio: "ignore" });
        }

        await new Promise((r) => setTimeout(r, Math.random() * 4000 + 2000));

        if (pausePg) {
          console.log("✅ Starting Postgres...");
          execSync(`docker unpause ${pgId}`, { stdio: "ignore" });
        }
        if (pauseRedis) {
          console.log("✅ Starting Redis...");
          execSync(`docker unpause ${redisId}`, { stdio: "ignore" });
        }
      }

      console.log("✅ Ensuring Postgres and Redis are unpaused...");
      try {
        execSync(`docker unpause ${pgId}`, { stdio: "ignore" });
      } catch (_e) {}
      try {
        execSync(`docker unpause ${redisId}`, { stdio: "ignore" });
      } catch (_e) {}
    };

    const chaosPromise = infraChaos();

    await injectPromise;
    chaosActive = false; // Stop chaos to let things drain
    await chaosPromise;

    console.log("Chaos complete, waiting for pipeline to flush...");

    const startTime = Date.now();
    while (mockTransport.deliveredCount < NUM_MESSAGES) {
      if (Date.now() - startTime > 100_000) {
        const len1 = await redis.xlen("notifkit:stream:inbound:normal");
        const len2 = await redis.xlen("notifkit:stream:enriched:critical");
        const len3 = await redis.xlen("notifkit:stream:outbound:critical");
        const dlq = await redis.xlen("notifkit:stream:dlq");
        const allKeys = await redis.keys("*");
        console.log("ALL REDIS KEYS:", allKeys);
        for (const k of allKeys) {
          const type = await redis.type(k);
          if (type === "stream") console.log(k, "XLEN:", await redis.xlen(k));
          else if (type === "string") console.log(k, "GET:", await redis.get(k));
        }
        throw new Error(
          `Timeout waiting for deliveries. Delivered: ${mockTransport.deliveredCount}/${NUM_MESSAGES}. INBOUND: ${len1}, ENRICHED: ${len2}, OUTBOUND: ${len3}, DLQ: ${dlq}`,
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
      console.log(`Recovered deliveries: ${mockTransport.deliveredCount}/${NUM_MESSAGES}`);
    }

    expect(mockTransport.deliveredCount).toBe(NUM_MESSAGES);
  }, 240_000);
});
