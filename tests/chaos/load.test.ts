import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { NotifkitServer } from "../../src/server.js";
import { createDatabase, runMigrations } from "../../src/db/index.js";
import { STREAMS, buildStreamEvent } from "../../src/contracts/index.js";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type { Transport, DeliveryResult } from "../../src/transport/index.js";

const NUM_MESSAGES = 10_000;

class MockCounterTransport implements Transport {
  public readonly channel = "email";
  public deliveredCount = 0;

  async send(): Promise<DeliveryResult> {
    this.deliveredCount++;
    return { success: true };
  }
}

describe("Load Testing (Throughput & Memory)", () => {
  let pgContainer: any;
  let redisContainer: any;
  let server: NotifkitServer;
  let redis: any;
  let sql: any;
  let mockTransport = new MockCounterTransport();
  let projectId: string;
  let userId: string;

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer("postgres:15-alpine").start();
    redisContainer = await new RedisContainer("redis:alpine").start();

    const dbUrl = pgContainer.getConnectionUri();
    const redisUrl = redisContainer.getConnectionUrl();

    const dbData = createDatabase({ url: dbUrl });
    sql = dbData.sql;
    await runMigrations(dbData.db);

    redis = new Redis(redisUrl);

    projectId = randomUUID();
    userId = randomUUID();
    await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'Test')`;
    await sql`INSERT INTO users (id, project_id, external_id) VALUES (${userId}, ${projectId}, 'test-user')`;
    await sql`INSERT INTO user_contacts (id, user_id, channel, target, is_primary) VALUES (${randomUUID()}, ${userId}, 'email', 'test@example.com', true)`;
    await sql`INSERT INTO templates (project_id, id, channel, topics, content) VALUES (${projectId}, 'welcome', 'email', '{}', '{"subject": "Welcome", "text": "Hello"}')`;

    server = new NotifkitServer({
      services: ["enricher", "engine", "scheduler", "delivery"],
      redisUrl,
      databaseUrl: dbUrl,
      logLevel: "warn",
      autoMigrate: false,
      providers: [mockTransport],
      workerConcurrency: 500,
    });

    await server.start();
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    await sql?.end();
    await redis?.quit();
    await pgContainer?.stop();
    await redisContainer?.stop();
  }, 30_000);

  it("should process 100k messages with stable memory", async () => {
    console.log(`Injecting ${NUM_MESSAGES} messages for load test...`);
    const startMemory = process.memoryUsage().heapUsed;

    const pipeline = redis.pipeline();
    for (let i = 0; i < NUM_MESSAGES; i++) {
      const payload = {
        projectId,
        target: { type: "user", userId: "test-user" },
        channels: ["email"],
        templateId: "welcome",
        priority: "critical",
      };

      const event = buildStreamEvent(
        "notification.requested",
        payload as any,
        "test",
        `trace-${i}`,
      );
      const fullEvent = { ...event, id: randomUUID(), timestamp: new Date().toISOString() };

      pipeline.xadd(STREAMS.INBOUND_NORMAL, "*", "data", JSON.stringify(fullEvent));

      if (i % 10000 === 0 && i > 0) {
        await pipeline.exec();
      }
    }
    await pipeline.exec();

    const startTime = Date.now();
    let memorySamples: number[] = [];

    while (mockTransport.deliveredCount < NUM_MESSAGES) {
      if (Date.now() - startTime > 120_000) {
        throw new Error(
          `Timeout in load test. Delivered: ${mockTransport.deliveredCount}/${NUM_MESSAGES}`,
        );
      }
      memorySamples.push(process.memoryUsage().heapUsed);
      await new Promise((r) => setTimeout(r, 1000));
      console.log(
        `Delivered: ${mockTransport.deliveredCount}/${NUM_MESSAGES} (Mem: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB)`,
      );
    }

    const endMemory = process.memoryUsage().heapUsed;
    const timeTakenS = (Date.now() - startTime) / 1000;
    const throughput = NUM_MESSAGES / timeTakenS;

    console.log(`Load Test Completed!`);
    console.log(`Throughput: ${throughput.toFixed(2)} msg/sec`);
    console.log(`Start Mem: ${Math.round(startMemory / 1024 / 1024)}MB`);
    console.log(`End Mem: ${Math.round(endMemory / 1024 / 1024)}MB`);
    console.log(`Max Mem: ${Math.round(Math.max(...memorySamples) / 1024 / 1024)}MB`);

    expect(mockTransport.deliveredCount).toBe(NUM_MESSAGES);

    // Ensure memory didn't leak aggressively (e.g. max memory shouldn't be > 1GB above start)
    expect(endMemory - startMemory).toBeLessThan(1024 * 1024 * 1024);
  }, 300_000);
});
