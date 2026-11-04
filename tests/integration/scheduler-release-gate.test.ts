import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { executeSchedulerPoll } from "@/services/scheduler/main.js";
import { createPriorityProducers } from "@/workers/bootstrap.js";
import { STREAMS } from "@/contracts/index.js";
import { createLogger } from "@/logger/index.js";
import { ContactRepository, TemplateRepository, UserRepository } from "@/repositories/index.js";
import { useInfra } from "./support/infra.js";

// Cases of the release gate not covered in scheduler.test.ts.

const infra = useInfra();
const logger = createLogger({ name: "test", level: "silent" });
const shardOf = (taskId: string) => parseInt(taskId.slice(-1), 16) || 0;

let project: string;

beforeEach(async () => {
  await infra.reset();
  project = randomUUID();
  await infra.sql`INSERT INTO projects (id, name) VALUES (${project}, 'p')`;
  await new TemplateRepository(infra.db).upsertMany(project, [
    { id: "promo", channel: "email", content: { subject: "Sale" }, topics: ["marketing"] },
  ]);
  await new UserRepository(infra.db).upsertFull(project, {
    userId: "u",
    segments: [],
    preferences: {},
  });
});

async function park(taskId: string) {
  const payload = {
    projectId: project,
    taskId,
    recipientId: "u",
    channel: "email",
    priority: "normal",
    templateId: "promo",
    destination: "u@x.com",
    scheduledAt: new Date(Date.now() - 1_000).toISOString(),
  };
  await infra.sql`INSERT INTO scheduled_payloads (task_id, payload) VALUES (${taskId}, ${JSON.stringify(payload)}::jsonb)`;
  await infra.redis.zadd(
    `notif:scheduled:zset:${shardOf(taskId)}`,
    Date.now() - 1_000,
    JSON.stringify({ taskId, enrichedEventId: randomUUID() }),
  );
}

async function releasedTaskIds() {
  await executeSchedulerPoll(
    infra.redis,
    createPriorityProducers(infra.redis, logger, "OUTBOUND"),
    logger,
    infra.db,
  );
  const entries = await infra.redis.xrange(STREAMS.OUTBOUND_NORMAL, "-", "+");
  return entries.map(([, f]) => JSON.parse(f[1]!).payload.taskId);
}

describe("scheduler release gate", () => {
  it("drops a send to a contact that was deleted while it was parked", async () => {
    const contacts = new ContactRepository(infra.db);
    await contacts.upsert(project, "u", "email", "u@x.com");
    await park("del-1");
    await contacts.delete(project, "u", "email", "u@x.com");

    expect(await releasedTaskIds()).toEqual([]);
  });

  it("drops a send when only that address opted out of the template's topic", async () => {
    await park("addr-1");
    await new ContactRepository(infra.db).upsert(project, "u", "email", "u@x.com", {
      topics: { marketing: false },
    });

    expect(await releasedTaskIds()).toEqual([]);
  });
});
