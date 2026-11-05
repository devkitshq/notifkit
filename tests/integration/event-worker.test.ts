import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { EventWorker } from "@/services/events/main.js";
import { StreamConsumer, PendingMessageScanner, StreamProducer } from "@/queue/index.js";
import { STREAMS, CONSUMER_GROUPS, buildStreamEvent } from "@/contracts/index.js";
import { insertMessageLogs, upsertOutboxProviderIds } from "@/db/bulk.js";
import { createLogger } from "@/logger/index.js";
import { useInfra, waitFor, settle } from "./support/infra.js";

/**
 * The events worker against real streams and a real delivery log: outcome
 * events become log rows, and inbound events wake the workflows waiting on
 * them.
 */

const infra = useInfra();
const logger = createLogger({ name: "test", level: "silent" });
let project: string;
let worker: EventWorker | undefined;

beforeEach(async () => {
  await infra.reset();
  project = randomUUID();
});

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
});

/**
 * The worker is slow to make its first read, as it is on a loaded machine
 * running the whole suite. A wait that passes before the worker has read
 * anything then fails here every time, rather than once in a while.
 */
const FIRST_READ_DELAY_MS = 300;

async function start({ concurrency = 10 } = {}) {
  const consumer = new StreamConsumer({
    redis: infra.redis,
    stream: STREAMS.EVENTS_INBOUND,
    group: CONSUMER_GROUPS.EVENTS,
    consumer: "e1",
    blockMs: 100,
    logger,
  });
  const read = consumer.readBatch.bind(consumer);
  const stop = consumer.stop.bind(consumer);
  let stopped = false;
  consumer.stop = async () => {
    stopped = true;
    await stop();
  };
  consumer.readBatch = async function* () {
    await settle(FIRST_READ_DELAY_MS);
    if (!stopped) yield* read();
  };
  const pendingScanner = new PendingMessageScanner({
    redis: infra.redis,
    stream: STREAMS.EVENTS_INBOUND,
    group: CONSUMER_GROUPS.EVENTS,
    consumer: "e1",
    logger,
  });
  worker = new EventWorker({
    consumer,
    pendingScanner,
    logger,
    concurrency,
    db: infra.db,
    workflowProducer: new StreamProducer({
      redis: infra.redis,
      stream: STREAMS.WORKFLOW_INBOUND,
      logger,
      maxLen: 1000,
    }),
  });
  await worker.start();
  return worker;
}

async function emit(type: string, payload: Record<string, unknown>) {
  const ev = {
    ...buildStreamEvent(type, payload, "test"),
    id: randomUUID(),
    timestamp: new Date().toISOString(),
  };
  await infra.redis.xadd(STREAMS.EVENTS_INBOUND, "*", "data", JSON.stringify(ev));
  return ev;
}

/** The events group's XINFO entry: `lag` is entries not yet read, `pending` read but not acked. */
async function group(): Promise<Record<string, unknown> | undefined> {
  const groups = (await infra.redis.xinfo("GROUPS", STREAMS.EVENTS_INBOUND)) as unknown[][];
  return groups
    .map((flat) =>
      Object.fromEntries(flat.flatMap((v, i) => (i % 2 ? [] : [[String(v), flat[i + 1]]]))),
    )
    .find((g) => g.name === CONSUMER_GROUPS.EVENTS);
}

/**
 * Every entry on the stream has been read by the group and acked. Pending
 * alone is not enough: it is also 0 before the worker has read anything.
 */
const drained = async () => {
  const g = await group();
  return g?.lag === 0 && g.pending === 0;
};
const resumes = async () =>
  (await infra.redis.xrange(STREAMS.WORKFLOW_INBOUND, "-", "+")).map(([, f]) => JSON.parse(f[1]!));

describe("EventWorker: delivery log", () => {
  it("writes a dispatched row and an outcome row, in that order, once each", async () => {
    await start();
    const dispatchedAt = new Date(Date.now() - 5_000).toISOString();
    const outcome = {
      projectId: project,
      taskId: "t1",
      channel: "email",
      attempt: 1,
      providerMessageId: "pm-1",
      dispatchedAt,
      templateId: "tpl",
      campaignId: "c",
    };
    await emit("notification.delivered", outcome);
    await emit("notification.delivered", outcome); // a replay
    await emit("notification.failed", {
      projectId: project,
      taskId: "t2",
      channel: "sms",
      attempt: 2,
    });
    await emit("notification.dispatched", { projectId: project, taskId: "t3", channel: "push" });

    await waitFor("read and acked", drained);
    const rows =
      await infra.sql`SELECT task_id, kind, status, attempt, provider_message_id, template_id, campaign_id, "timestamp" FROM message_logs ORDER BY task_id, "timestamp"`;
    expect(rows.map((r) => [r.task_id, r.kind, r.status, r.attempt])).toEqual([
      ["t1", "dispatched", "dispatched", 1],
      ["t1", "attempt", "delivered", 1],
      ["t2", "attempt", "failed", 2],
      ["t3", "dispatched", "dispatched", 1],
    ]);
    expect(new Date(rows[0]!.timestamp).toISOString()).toBe(dispatchedAt);
    expect(rows[1]).toMatchObject({
      provider_message_id: "pm-1",
      template_id: "tpl",
      campaign_id: "c",
    });
  });

  it("flushes everything buffered when it stops", async () => {
    // Hold rows in the buffer: a flush threshold out of reach (half of 100)
    // and no interval flush, so only stopping can write them.
    const w = await start({ concurrency: 100 });
    clearInterval((w as any).flushInterval);
    for (let i = 0; i < 5; i++)
      await emit("notification.delivered", {
        projectId: project,
        taskId: `s${i}`,
        channel: "email",
      });

    await waitFor("all five buffered", () => (w as any).messageLogBuffer.length === 5);
    expect(await infra.sql`SELECT 1 FROM message_logs`).toEqual([]);

    await w.stop();
    worker = undefined;
    const [{ n }] = (await infra.sql`SELECT count(*)::int AS n FROM message_logs`) as any;
    expect(n).toBe(5);
    // With the flush interval off, stop() waits out BaseWorker's 30s drain before flushing.
  }, 60_000);

  it("ignores event types it has no use for", async () => {
    await start();
    await emit("something.else", { projectId: project });
    await waitFor("read and acked", drained);
    expect(await infra.sql`SELECT 1 FROM message_logs`).toEqual([]);
  });
});

describe("EventWorker: waking workflows", () => {
  async function waitingInstance(
    eventName: string,
    match: Record<string, unknown>,
    expiresInMs = 3600_000,
  ) {
    const [inst] = await infra.sql`
      INSERT INTO workflow_instances (project_id, name, status, input) VALUES (${project}, 'wf', 'pending', ${JSON.stringify({ user: { id: "u" } })}::jsonb) RETURNING id`;
    const id = inst!.id as string;
    await infra.sql`INSERT INTO workflow_steps (project_id, instance_id, step_index, action) VALUES (${project}, ${id}, '0', 'waitForEvent')`;
    await infra.sql`INSERT INTO workflow_waiters (project_id, instance_id, event_name, match_criteria, expires_at)
      VALUES (${project}, ${id}, ${eventName}, ${JSON.stringify(match)}::jsonb, ${new Date(Date.now() + expiresInMs).toISOString()})`;
    return id;
  }

  it("resumes the instance whose criteria match, recording the event on its step", async () => {
    await start();
    const alice = await waitingInstance("order.paid", { "customer.id": "alice" });
    const bob = await waitingInstance("order.paid", { "customer.id": "bob" });

    await emit("event.received", {
      projectId: project,
      eventName: "order.paid",
      payload: { customer: { id: "alice" }, total: 5 },
    });
    await waitFor("resumed", async () => (await resumes()).length === 1);

    const [resume] = await resumes();
    expect(resume.type).toBe("workflow.resumed");
    expect(resume.payload).toMatchObject({
      projectId: project,
      instanceId: alice,
      name: "wf",
      input: { user: { id: "u" } },
      reason: "event_matched",
    });
    const [step] = await infra.sql`SELECT output FROM workflow_steps WHERE instance_id = ${alice}`;
    expect(step!.output).toEqual({ customer: { id: "alice" }, total: 5 });
    const waiters = await infra.sql`SELECT instance_id FROM workflow_waiters`;
    expect(waiters.map((w) => w.instance_id)).toEqual([bob]);
  });

  it("does not wake anything for an event in another project, of another name, or after the waiter expired", async () => {
    await start();
    await waitingInstance("order.paid", {});
    await waitingInstance("expired", {}, -1_000);
    await emit("event.received", { projectId: randomUUID(), eventName: "order.paid", payload: {} });
    await emit("event.received", { projectId: project, eventName: "order.refunded", payload: {} });
    await emit("event.received", { projectId: project, eventName: "expired", payload: {} });
    await emit("event.received", { eventName: "order.paid", payload: {} });

    await waitFor("read and acked", drained);
    await settle(200);
    expect(await resumes()).toEqual([]);
  });

  it("drops a waiter whose instance no longer exists", async () => {
    await start();
    const id = await waitingInstance("ping", {});
    // Orphan the waiter as a crash between deletes would.
    await infra.sql`ALTER TABLE workflow_waiters DISABLE TRIGGER ALL`;
    await infra.sql`DELETE FROM workflow_instances WHERE id = ${id}`.catch(() => {});
    await infra.sql`ALTER TABLE workflow_waiters ENABLE TRIGGER ALL`;
    const orphaned = (await infra.sql`SELECT 1 FROM workflow_waiters`).length;

    await emit("event.received", {
      projectId: project,
      eventName: "ping",
      payload: "not an object",
    });
    await waitFor("read and acked", drained);
    expect(await resumes()).toEqual([]);
    if (orphaned) expect(await infra.sql`SELECT 1 FROM workflow_waiters`).toEqual([]);
  });
});

describe("bulk log writers", () => {
  it("insertMessageLogs writes typed rows and skips ones already recorded", async () => {
    const row = {
      projectId: project,
      taskId: "b1",
      providerMessageId: null,
      channel: "email",
      attempt: 1,
      kind: "attempt",
      status: "delivered",
      templateId: null,
      workflowInstanceId: null,
      campaignId: null,
    };
    await insertMessageLogs(infra.db, [
      row,
      {
        ...row,
        taskId: "b2",
        workflowInstanceId: randomUUID(),
        timestamp: "2020-01-01T00:00:00.000Z",
      },
    ]);
    await insertMessageLogs(infra.db, [row]);
    await insertMessageLogs(infra.db, []);
    const rows = await infra.sql`SELECT task_id, "timestamp" FROM message_logs ORDER BY task_id`;
    expect(rows.map((r) => r.task_id)).toEqual(["b1", "b2"]);
    expect(new Date(rows[1]!.timestamp).toISOString()).toBe("2020-01-01T00:00:00.000Z");
  });

  it("upsertOutboxProviderIds records and updates provider ids, even with a task twice in one batch", async () => {
    const base = { taskId: "o1", channel: "email", destination: "a@x.com" };
    await upsertOutboxProviderIds(infra.db, [{ ...base, providerMessageId: null }]);
    await upsertOutboxProviderIds(infra.db, [
      { ...base, providerMessageId: "first" },
      { ...base, providerMessageId: "retry" },
      { taskId: "o2", channel: "sms", destination: "+1", providerMessageId: "s" },
    ]);
    await upsertOutboxProviderIds(infra.db, []);
    const rows =
      await infra.sql`SELECT task_id, provider_message_id FROM delivery_outbox ORDER BY task_id`;
    expect(rows.map((r) => [r.task_id, r.provider_message_id])).toEqual([
      ["o1", "retry"],
      ["o2", "s"],
    ]);
  });
});
