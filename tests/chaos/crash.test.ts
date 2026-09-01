import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createDatabase, runMigrations } from "../../src/db/index.js";
import { STREAMS, buildStreamEvent } from "../../src/contracts/index.js";
import pino from "pino";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

const NUM_MESSAGES = 100;

describe("Crash Testing (Chaos Monkey)", () => {
  let pgContainer: any;
  let redisContainer: any;
  let dbUrl: string;
  let redisUrl: string;
  let db: any;
  let sql: any;
  let redis: any;

  const workers = new Map<string, { type: string; cp: ChildProcess }>();
  let chaosInterval: NodeJS.Timeout;
  const logger = pino({ name: "crash-test", level: "info" });

  const spawnWorker = (type: string, id: string) => {
    logger.info(`Spawning worker: ${type} (${id})`);
    const isWin = process.platform === "win32";
    const cp = spawn(
      isWin ? "cmd.exe" : "npx",
      isWin
        ? ["/c", "npx", "--no-install", "tsx", "tests/chaos/worker-runner.ts"]
        : ["--no-install", "tsx", "tests/chaos/worker-runner.ts"],
      {
        env: {
          ...process.env,
          WORKER_TYPE: type,
          DATABASE_URL: dbUrl,
          REDIS_URL: redisUrl,
          LOG_LEVEL: "silent",
        },
        stdio: "ignore", // ignore output to keep logs clean
      },
    );

    cp.on("exit", (code, signal) => {
      logger.info(`Worker ${type} (${id}) exited with signal ${signal} (code ${code})`);
      // Auto-restart if we didn't intentionally clean it up at the end
      if (workers.has(id) && workers.get(id)?.cp === cp) {
        spawnWorker(type, id);
      }
    });

    // Prevent unhandled errors from killed processes
    cp.on("error", (err) => {
      logger.debug(`Worker ${type} (${id}) error: ${err.message}`);
    });

    workers.set(id, { type, cp });
  };

  beforeAll(async () => {
    // 1. Spin up containers
    pgContainer = await new PostgreSqlContainer("postgres:15-alpine").start();
    redisContainer = await new RedisContainer("redis:alpine").start();

    dbUrl = pgContainer.getConnectionUri();
    redisUrl = redisContainer.getConnectionUrl();

    // 2. Setup DB schema
    const dbData = createDatabase({ url: dbUrl });
    db = dbData.db;
    sql = dbData.sql;
    await runMigrations(db);

    redis = new Redis(redisUrl);

    // 4. Start all workers (2 of each type to simulate a cluster)
    ["enricher", "engine", "scheduler", "delivery"].forEach((type) => {
      spawnWorker(type, `${type}-1`);
      spawnWorker(type, `${type}-2`);
    });

    // 5. Start chaos monkey
    chaosInterval = setInterval(() => {
      const allIds = Array.from(workers.keys());
      // Randomly pick 1 to 3 workers to kill
      const killCount = Math.floor(Math.random() * 3) + 1;

      allIds.sort(() => 0.5 - Math.random());
      const targets = allIds.slice(0, killCount);

      logger.info(`💀 SIGKILLing ${targets.join(", ")}...`);
      targets.forEach((id) => {
        workers.get(id)?.cp.kill("SIGKILL");
      });
    }, 3000); // Kill every 3 seconds
  }, 120_000);

  afterAll(async () => {
    clearInterval(chaosInterval);
    for (const { cp } of workers.values()) {
      cp.kill("SIGKILL"); // hard kill all
    }
    await sql?.end();
    await redis?.quit();
    await pgContainer?.stop();
    await redisContainer?.stop();
  }, 30_000);

  it("should process all notifications despite aggressive worker crashes", async () => {
    const traceIds = new Set<string>();

    // Setup a user
    const projectId = randomUUID();
    const userId = randomUUID();
    await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'Test')`;
    await sql`INSERT INTO users (id, project_id, external_id) VALUES (${userId}, ${projectId}, 'test-user')`;
    await sql`INSERT INTO user_contacts (id, user_id, channel, target, is_primary) VALUES (${randomUUID()}, ${userId}, 'email', 'test@example.com', true)`;
    await sql`INSERT INTO templates (project_id, id, channel, topics, content) VALUES (${projectId}, 'welcome', 'email', '{}', '{"subject": "Welcome", "text": "Hello"}')`;

    logger.info(`Injecting ${NUM_MESSAGES} messages...`);
    const pipeline = redis.pipeline();
    for (let i = 0; i < NUM_MESSAGES; i++) {
      const traceId = `trace-${i}`;
      traceIds.add(traceId);

      const payload = {
        projectId,
        target: { type: "user", userId: "test-user" },
        channels: ["email"],
        templateId: "welcome",
        priority: "critical",
      };

      const event = buildStreamEvent("notification.requested", payload as any, "test", traceId);
      const fullEvent = { ...event, id: randomUUID(), timestamp: new Date().toISOString() };
      pipeline.xadd(STREAMS.INBOUND_NORMAL, "*", "data", JSON.stringify(fullEvent));
    }
    await pipeline.exec();
    logger.info(`Injected ${NUM_MESSAGES} messages.`);

    let deliveredCount = 0;
    let failedCount = 0;
    let lastId = "0-0";

    // Wait up to 90 seconds for processing (because workers crash and have 60s autoclaim backoff)
    // Actually, if we kill them, autoclaim handles it, but recoveryIntervalMs is 60s.
    // So if a message was in-flight during a crash, it takes 60s to be reclaimed.
    // So wait 180s.
    const startTime = Date.now();
    while (deliveredCount + failedCount < NUM_MESSAGES) {
      if (Date.now() - startTime > 180_000) {
        throw new Error(
          `Timeout waiting for deliveries. Delivered: ${deliveredCount}, Failed: ${failedCount}, Expected: ${NUM_MESSAGES}`,
        );
      }

      const res = await redis.xread("BLOCK", 1000, "STREAMS", STREAMS.EVENTS_INBOUND, lastId);
      if (res && res.length > 0) {
        const streamData = res[0][1];
        for (const [id, fields] of streamData) {
          lastId = id;
          const ev = JSON.parse(fields[1]);
          if (ev.type === "notification.delivered") deliveredCount++;
          if (ev.type === "notification.failed") failedCount++;
        }
      }
    }

    expect(deliveredCount + failedCount).toBe(NUM_MESSAGES);
    expect(failedCount).toBe(0);
  }, 180_000);
});
