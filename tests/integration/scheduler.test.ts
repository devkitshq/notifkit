import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  executeSchedulerPoll,
  msUntilNextDue,
  rebuildScheduledQueue,
  SchedulerWorker,
  SCHEDULER_SENTINEL_KEY,
} from "@/services/scheduler/main.js";
import { createPriorityProducers } from "@/workers/bootstrap.js";
import { StreamConsumer, PendingMessageScanner } from "@/queue/index.js";
import { STREAMS, CONSUMER_GROUPS, registry, buildStreamEvent } from "@/contracts/index.js";
import { createLogger } from "@/logger/index.js";
import { ContactRepository, TemplateRepository, UserRepository } from "@/repositories/index.js";
import { useInfra, waitFor } from "./support/infra.js";

/**
 * The scheduler's pieces against real Redis ZSETs and a real
 * scheduled_payloads table: parking a task, releasing it when due, and
 * rebuilding the ZSETs from Postgres after Redis loses its data.
 */

const infra = useInfra();
const logger = createLogger({ name: "test", level: "silent" });

beforeEach(async () => {
  await infra.reset();
});

const shardOf = (taskId: string) => parseInt(taskId.slice(-1), 16) || 0;
const zkey = (taskId: string) => `notif:scheduled:zset:${shardOf(taskId)}`;

async function park(taskId: string, at: number, payload: Record<string, unknown> = {}) {
  const full = {
    projectId: randomUUID(),
    taskId,
    channel: "email",
    priority: "normal",
    scheduledAt: new Date(at).toISOString(),
    ...payload,
  };
  await infra.sql`INSERT INTO scheduled_payloads (task_id, payload) VALUES (${taskId}, ${JSON.stringify(full)}::jsonb)`;
  await infra.redis.zadd(
    zkey(taskId),
    at,
    JSON.stringify({ taskId, enrichedEventId: randomUUID(), traceId: `trace-${taskId}` }),
  );
  return full;
}

async function released(stream: string) {
  return (await infra.redis.xrange(stream, "-", "+")).map(([, f]) => JSON.parse(f[1]!));
}

async function zsize() {
  let n = 0;
  for (let i = 0; i < 16; i++) n += await infra.redis.zcard(`notif:scheduled:zset:${i}`);
  return n;
}

describe("executeSchedulerPoll", () => {
  it("releases due tasks onto the outbound lane for their priority, and only due ones", async () => {
    const producers = createPriorityProducers(infra.redis, logger, "OUTBOUND");
    const due = await park("task-a", Date.now() - 1_000, { priority: "critical" });
    await park("task-b", Date.now() - 1_000, { priority: "low" });
    await park("task-c", Date.now() + 60_000);

    expect(await executeSchedulerPoll(infra.redis, producers, logger, infra.db)).toBe(false);

    const critical = await released(STREAMS.OUTBOUND_CRITICAL);
    expect(critical).toHaveLength(1);
    expect(critical[0]).toMatchObject({
      type: "notification.dispatched",
      payload: due,
      metadata: { traceId: "trace-task-a", source: "scheduler" },
    });
    expect(await released(STREAMS.OUTBOUND_LOW)).toHaveLength(1);
    expect(await released(STREAMS.OUTBOUND_NORMAL)).toHaveLength(0);

    const left = await infra.sql`SELECT task_id FROM scheduled_payloads ORDER BY task_id`;
    expect(left.map((r) => r.task_id)).toEqual(["task-c"]);
    expect(await zsize()).toBe(1);
  });

  it("drops a parked task whose payload was canceled, without sending it", async () => {
    const producers = createPriorityProducers(infra.redis, logger, "OUTBOUND");
    await park("task-x", Date.now() - 1_000);
    await infra.sql`DELETE FROM scheduled_payloads`;

    await executeSchedulerPoll(infra.redis, producers, logger, infra.db);
    expect(await released(STREAMS.OUTBOUND_NORMAL)).toEqual([]);
    expect(await zsize()).toBe(0);
  });

  it("skips a member that is not valid JSON and releases the rest", async () => {
    const producers = createPriorityProducers(infra.redis, logger, "OUTBOUND");
    await infra.redis.zadd("notif:scheduled:zset:0", Date.now() - 1, "{not json");
    await park("task-0", Date.now() - 1_000);
    await executeSchedulerPoll(infra.redis, producers, logger, infra.db);
    expect(await released(STREAMS.OUTBOUND_NORMAL)).toHaveLength(1);
  });

  it("does nothing while another scheduler holds the poll lock", async () => {
    const producers = createPriorityProducers(infra.redis, logger, "OUTBOUND");
    await park("task-l", Date.now() - 1_000);
    await infra.redis.set("notif:lock:scheduler:poll", "someone-else", "EX", 30);

    expect(await executeSchedulerPoll(infra.redis, producers, logger, infra.db)).toBe(false);
    expect(await released(STREAMS.OUTBOUND_NORMAL)).toEqual([]);
    // And it must not have released someone else's lock.
    expect(await infra.redis.get("notif:lock:scheduler:poll")).toBe("someone-else");
  });

  it("never releases one task twice when schedulers race", async () => {
    const producers = createPriorityProducers(infra.redis, logger, "OUTBOUND");
    for (let i = 0; i < 30; i++) await park(`race-${i.toString(16)}`, Date.now() - 1_000);
    for (let round = 0; round < 10; round++) {
      await Promise.all(
        Array.from({ length: 4 }, () =>
          executeSchedulerPoll(infra.redis, producers, logger, infra.db),
        ),
      );
    }
    const out = await released(STREAMS.OUTBOUND_NORMAL);
    expect(out).toHaveLength(30);
    expect(new Set(out.map((e) => e.payload.taskId)).size).toBe(30);
  });

  it("asks to be called again while a shard still has a backlog", async () => {
    const producers = createPriorityProducers(infra.redis, logger, "OUTBOUND");
    // Every id ends in "0", so all 150 land on one shard (100 per poll).
    const pipeline = infra.redis.pipeline();
    const past = Date.now() - 1_000;
    for (let i = 0; i < 150; i++) {
      const taskId = `bulk-${i}-0`;
      pipeline.zadd(zkey(taskId), past, JSON.stringify({ taskId, enrichedEventId: randomUUID() }));
    }
    await pipeline.exec();
    await infra.sql`INSERT INTO scheduled_payloads (task_id, payload)
      SELECT 'bulk-' || i || '-0', jsonb_build_object('priority', 'normal') FROM generate_series(0, 149) AS i`;

    expect(await executeSchedulerPoll(infra.redis, producers, logger, infra.db)).toBe(true);
    expect(await executeSchedulerPoll(infra.redis, producers, logger, infra.db)).toBe(false);
    expect(await released(STREAMS.OUTBOUND_NORMAL)).toHaveLength(150);
  });

  it("does not delete a task's newer payload when it was re-parked while being released", async () => {
    // Delivery throttles a released task and parks it again — new send time,
    // same task id — sometimes before the poll that released it has finished.
    const base = createPriorityProducers(infra.redis, logger, "OUTBOUND");
    const retryAt = Date.now() + 5_000;
    const reparking = {
      ...base,
      normal: {
        publishBatch: async (events: any[]) => {
          const result = await base.normal.publishBatch(events);
          for (const e of events) {
            const payload = {
              ...e.payload,
              scheduledAt: new Date(retryAt).toISOString(),
              throttleAttemptCount: 1,
            };
            await infra.sql`
              INSERT INTO scheduled_payloads (task_id, payload) VALUES (${e.payload.taskId}, ${JSON.stringify(payload)}::jsonb)
              ON CONFLICT (task_id) DO UPDATE SET payload = EXCLUDED.payload`;
            await infra.redis.zadd(
              zkey(e.payload.taskId),
              retryAt,
              JSON.stringify({
                taskId: e.payload.taskId,
                enrichedEventId: randomUUID(),
                traceId: "retry",
              }),
            );
          }
          return result;
        },
      },
    };
    await park("task-r", Date.now() - 1_000);

    await executeSchedulerPoll(infra.redis, reparking, logger, infra.db);

    const rows = await infra.sql`SELECT payload FROM scheduled_payloads WHERE task_id = 'task-r'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.throttleAttemptCount).toBe(1);
  });

  it("keeps releasing the other shards when one cannot be read", async () => {
    const producers = createPriorityProducers(infra.redis, logger, "OUTBOUND");
    await infra.redis.set("notif:scheduled:zset:3", "wrong type");
    await park("task-4", Date.now() - 1_000);
    await expect(executeSchedulerPoll(infra.redis, producers, logger, infra.db)).resolves.toBe(
      false,
    );
    expect((await released(STREAMS.OUTBOUND_NORMAL)).map((e) => e.payload.taskId)).toEqual([
      "task-4",
    ]);
  });
});

/**
 * A parked send was cleared by the engine when it was parked. Whatever the
 * person did since — hours or days of it, for a `sendAt` or a quiet-hours
 * deferral — has to stop it at release.
 */
describe("msUntilNextDue", () => {
  // A throttled task asks to come back within a second; a flat 5s poll held
  // it for five, so a provider got one window's sends per poll.
  it("is the time until the earliest parked task, across shards", async () => {
    await park("task-1", Date.now() + 4_000);
    await park("task-2", Date.now() + 800);

    const ms = await msUntilNextDue(infra.redis, 5_000);

    expect(ms).toBeGreaterThan(500);
    expect(ms).toBeLessThanOrEqual(800);
  });

  it("is zero when a task is already due", async () => {
    await park("task-3", Date.now() - 1_000);
    expect(await msUntilNextDue(infra.redis, 5_000)).toBe(0);
  });

  it("is capped, so tasks parked meanwhile still go out on time", async () => {
    await park("task-4", Date.now() + 60_000);
    expect(await msUntilNextDue(infra.redis, 5_000)).toBe(5_000);
  });

  it("is the cap when nothing is parked", async () => {
    expect(await msUntilNextDue(infra.redis, 5_000)).toBe(5_000);
  });
});

describe("executeSchedulerPoll re-checks a parked send when releasing it", () => {
  let project: string;
  const users = () => new UserRepository(infra.db);
  const contacts = () => new ContactRepository(infra.db);

  beforeEach(async () => {
    project = randomUUID();
    await infra.sql`INSERT INTO projects (id, name) VALUES (${project}, 'p')`;
    await new TemplateRepository(infra.db).upsertMany(project, [
      { id: "promo", channel: "email", content: { subject: "Sale" }, topics: ["marketing"] },
      { id: "receipt", channel: "email", content: { subject: "Receipt" } },
    ]);
    await users().upsertFull(project, { userId: "u", segments: [], preferences: {} });
    await contacts().upsert(project, "u", "email", "U@X.com");
  });

  const parkFor = (taskId: string, extra: Record<string, unknown> = {}) =>
    park(taskId, Date.now() - 1_000, {
      projectId: project,
      recipientId: "u",
      templateId: "promo",
      destination: "U@X.com",
      ...extra,
    });

  async function poll() {
    await executeSchedulerPoll(
      infra.redis,
      createPriorityProducers(infra.redis, logger, "OUTBOUND"),
      logger,
      infra.db,
    );
    return (await released(STREAMS.OUTBOUND_NORMAL)).map((e) => e.payload.taskId);
  }

  async function expectDropped(taskId: string) {
    expect(await poll()).toEqual([]);
    expect(
      await infra.sql`SELECT 1 FROM scheduled_payloads WHERE task_id = ${taskId}`,
    ).toHaveLength(0);
    expect(await zsize()).toBe(0);
  }

  it("still releases a send nothing has changed for", async () => {
    await parkFor("ok-1");
    expect(await poll()).toEqual(["ok-1"]);
  });

  it("drops a send to an address suppressed since it was parked", async () => {
    await parkFor("sup-1");
    // Stored normalised, while the contact kept its original casing.
    await infra.sql`INSERT INTO suppressions (project_id, channel, target, reason) VALUES (${project}, 'email', 'u@x.com', 'bounced')`;
    await expectDropped("sup-1");
  });

  it("does not let a suppression on another channel or project stop it", async () => {
    await parkFor("sup-2");
    await infra.sql`INSERT INTO suppressions (project_id, channel, target, reason) VALUES (${project}, 'sms', 'u@x.com', 'manual')`;
    await infra.sql`INSERT INTO suppressions (project_id, channel, target, reason) VALUES (${randomUUID()}, 'email', 'u@x.com', 'manual')`;
    expect(await poll()).toEqual(["sup-2"]);
  });

  it("drops a send for a topic the user opted out of, and keeps their transactional mail", async () => {
    await parkFor("topic-1");
    await parkFor("topic-2", { templateId: "receipt" });
    await users().upsertFull(project, {
      userId: "u",
      segments: [],
      preferences: { topics: { marketing: false } },
    });
    expect(await poll()).toEqual(["topic-2"]);
  });

  it("drops a send on a channel the user switched off", async () => {
    await parkFor("chan-1", { templateId: "receipt" });
    await users().upsertFull(project, {
      userId: "u",
      segments: [],
      preferences: { channels: { email: false } },
    });
    await expectDropped("chan-1");
  });

  it("drops a send to an address that was deactivated, or a user that was deleted", async () => {
    await parkFor("gone-1");
    await contacts().deactivate(project, "u", "email", "U@X.com");
    await expectDropped("gone-1");

    await parkFor("gone-2", { recipientId: "nobody" });
    await expectDropped("gone-2");
  });
});

describe("rebuildScheduledQueue", () => {
  it("re-queues every parked payload at its send time, page by page, and marks the queue intact", async () => {
    const at = Date.now() + 3600_000;
    for (let i = 0; i < 7; i++) await park(`rb-${i}`, at + i);
    await infra.sql`INSERT INTO scheduled_payloads (task_id, payload) VALUES ('legacy-1', '{"priority":"normal"}')`;
    await infra.redis.flushdb();

    expect(await rebuildScheduledQueue(infra.redis, infra.db, logger, 3)).toBe(8);

    expect(await zsize()).toBe(8);
    const score = await infra.redis.zscore(
      zkey("rb-4"),
      JSON.stringify({ taskId: "rb-4", enrichedEventId: undefined }),
    );
    expect(Number(score)).toBe(at + 4);
    // A payload with no send time is due now.
    const legacy = await infra.redis.zrange(zkey("legacy-1"), "0", "-1", "WITHSCORES");
    expect(Number(legacy[1]!)).toBeLessThanOrEqual(Date.now());
    expect(await infra.redis.get(SCHEDULER_SENTINEL_KEY)).toBe("1");
  });

  it("does not duplicate a member that survived", async () => {
    await park("keep-1", Date.now() + 60_000);
    await infra.redis.del(zkey("keep-1"));
    await rebuildScheduledQueue(infra.redis, infra.db, logger);
    await rebuildScheduledQueue(infra.redis, infra.db, logger);
    expect(await zsize()).toBe(1);
  });

  it("marks an empty queue intact too", async () => {
    expect(await rebuildScheduledQueue(infra.redis, infra.db, logger)).toBe(0);
    expect(await infra.redis.exists(SCHEDULER_SENTINEL_KEY)).toBe(1);
  });

  it("lets the poll send a task rebuilt next to a surviving copy only once", async () => {
    const producers = createPriorityProducers(infra.redis, logger, "OUTBOUND");
    await park("dup-5", Date.now() - 1_000);
    await rebuildScheduledQueue(infra.redis, infra.db, logger); // adds a trace-less copy
    expect(await infra.redis.zcard(zkey("dup-5"))).toBe(2);

    await executeSchedulerPoll(infra.redis, producers, logger, infra.db);
    expect(await released(STREAMS.OUTBOUND_NORMAL)).toHaveLength(1);
    expect(await zsize()).toBe(0);
  });
});

describe("SchedulerWorker", () => {
  let worker: SchedulerWorker | undefined;
  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
  });

  it("parks each scheduled task in its shard at its send time", async () => {
    const consumer = new StreamConsumer({
      redis: infra.redis,
      stream: STREAMS.SCHEDULED,
      group: CONSUMER_GROUPS.SCHEDULER,
      consumer: "s1",
      blockMs: 100,
      logger,
    });
    const pendingScanner = new PendingMessageScanner({
      redis: infra.redis,
      stream: STREAMS.SCHEDULED,
      group: CONSUMER_GROUPS.SCHEDULER,
      consumer: "s1",
      logger,
    });
    worker = new SchedulerWorker({
      consumer,
      pendingScanner,
      logger,
      registry,
      redis: infra.redis,
    });
    await worker.start();

    const at = new Date(Date.now() + 60_000).toISOString();
    const taskId = `${randomUUID()}:abc`;
    const ev = {
      ...buildStreamEvent(
        "notification.scheduled",
        { projectId: randomUUID(), enrichedEventId: randomUUID(), taskId, scheduledAt: at },
        "engine",
        "trace-9",
      ),
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };
    await infra.redis.xadd(STREAMS.SCHEDULED, "*", "data", JSON.stringify(ev));
    // An invalid payload is skipped, not retried forever.
    await infra.redis.xadd(
      STREAMS.SCHEDULED,
      "*",
      "data",
      JSON.stringify({ ...ev, id: randomUUID(), payload: { taskId: 1 } }),
    );

    await waitFor("parked", async () => (await infra.redis.zcard(zkey(taskId))) === 1);
    const [member, score] = await infra.redis.zrange(zkey(taskId), "0", "-1", "WITHSCORES");
    expect(JSON.parse(member!)).toMatchObject({ taskId, traceId: "trace-9" });
    expect(Number(score)).toBe(Date.parse(at));
    await waitFor(
      "both acked",
      async () =>
        Number(
          ((await infra.redis.xpending(STREAMS.SCHEDULED, CONSUMER_GROUPS.SCHEDULER)) as any[])[0],
        ) === 0,
    );
  });
});
