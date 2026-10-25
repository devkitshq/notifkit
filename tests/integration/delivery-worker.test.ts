import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { DeliveryWorker, MAX_THROTTLE_DEFERRALS } from "@/services/delivery/main.js";
import { StreamConsumer, PendingMessageScanner, StreamProducer } from "@/queue/index.js";
import { IdempotencyGuard } from "@/idempotency/index.js";
import { ContactRepository, TemplateRepository, UserRepository } from "@/repositories/index.js";
import { TemplateCache } from "@/templates/index.js";
import { transportRegistry, type Transport, type DeliveryResult } from "@/transport/index.js";
import { STREAMS, CONSUMER_GROUPS, OUTBOUND_STREAMS, buildStreamEvent } from "@/contracts/index.js";
import { createPriorityProducers } from "@/workers/bootstrap.js";
import { globalEmitter } from "@/shared/index.js";
import { createLogger } from "@/logger/index.js";
import { useInfra, waitFor, settle } from "./support/infra.js";

/**
 * The delivery worker on its own: real streams, real idempotency leases,
 * real Postgres for the outbox and contacts, and transports that behave like
 * providers do when they are slow, down, or rejecting.
 */

const infra = useInfra();
const logger = createLogger({ name: "test", level: "silent" });
let project: string;
const workers: DeliveryWorker[] = [];

beforeEach(async () => {
  await infra.reset();
  project = randomUUID();
  await infra.sql`INSERT INTO projects (id, name) VALUES (${project}, 'p')`;
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop()));
});

class FakeProvider implements Transport {
  calls = 0;
  constructor(
    readonly channel: any,
    private readonly behaviour: (n: number) => Promise<DeliveryResult> | DeliveryResult,
    readonly limits?: { limit: number; windowSeconds: number },
  ) {}
  async send(): Promise<DeliveryResult> {
    return this.behaviour(++this.calls);
  }
}

function registry(...transports: Transport[]) {
  const r = new (transportRegistry.constructor as any)();
  transports.forEach((t, i) => r.register(t, transports.length - i));
  return r;
}

function worker(reg: any, name = "d1") {
  const consumer = new StreamConsumer({
    redis: infra.redis,
    stream: [...OUTBOUND_STREAMS],
    group: CONSUMER_GROUPS.DELIVERY,
    consumer: name,
    dlqStream: STREAMS.DEAD_LETTER,
    blockMs: 100,
    logger,
  });
  const pendingScanner = new PendingMessageScanner({
    redis: infra.redis,
    stream: [...OUTBOUND_STREAMS],
    group: CONSUMER_GROUPS.DELIVERY,
    consumer: name,
    logger,
  });
  const w = new DeliveryWorker({
    consumer,
    pendingScanner,
    logger,
    concurrency: 10,
    transportRegistry: reg,
    idempotency: new IdempotencyGuard({
      redis: infra.redis,
      keyPrefix: "notif:processed:delivery",
    }),
    redis: infra.redis,
    scheduledProducer: new StreamProducer({
      redis: infra.redis,
      stream: STREAMS.SCHEDULED,
      logger,
      maxLen: 1000,
    }),
    enrichedProducers: createPriorityProducers(infra.redis, logger, "ENRICHED"),
    contactRepo: new ContactRepository(infra.db),
    eventsProducer: new StreamProducer({
      redis: infra.redis,
      stream: STREAMS.EVENTS_INBOUND,
      logger,
      maxLen: 1000,
    }),
    globalEmitter,
    db: infra.db,
    templateCache: new TemplateCache(new TemplateRepository(infra.db)),
  });
  workers.push(w);
  return w;
}

function dispatched(overrides: Record<string, unknown> = {}) {
  return {
    ...buildStreamEvent(
      "notification.dispatched",
      {
        projectId: project,
        taskId: `task-${randomUUID()}`,
        enrichedEventId: randomUUID(),
        recipientId: "u",
        channel: "email",
        priority: "normal",
        templateVariables: {},
        renderedContent: { content: { subject: "s" } },
        destination: "u@x.com",
        recipient: {
          id: "u",
          email: "u@x.com",
          locale: "en",
          timezone: "UTC",
          preferences: { optedOut: false, channels: [] },
        },
        deliveryOptions: { maxAttempts: 3, timeoutMs: 500 },
        ...overrides,
      },
      "engine",
    ),
    id: randomUUID(),
    timestamp: new Date().toISOString(),
  };
}

async function publish(ev: any) {
  await infra.redis.xadd(STREAMS.OUTBOUND_NORMAL, "*", "data", JSON.stringify(ev));
}

const events = async () =>
  (await infra.redis.xrange(STREAMS.EVENTS_INBOUND, "-", "+")).map(([, f]) => JSON.parse(f[1]!));
const parked = async () =>
  (await infra.sql`SELECT task_id, payload FROM scheduled_payloads ORDER BY task_id`).map(
    (r) => r.payload as any,
  );
const dlq = async () =>
  (await infra.redis.xrange(STREAMS.DEAD_LETTER, "-", "+")).map(([, f]) => JSON.parse(f[1]!));

describe("DeliveryWorker", () => {
  it("parks a send the provider timed out on for a later attempt, instead of failing it", async () => {
    const hang = new FakeProvider("email", () => new Promise(() => {}));
    const w = worker(registry(hang));
    const ev = dispatched();
    await w.processInline(ev as any);
    await w.stop();

    expect(await dlq()).toEqual([]);
    expect((await events()).some((e) => e.type === "notification.failed")).toBe(false);
    const [retry] = await parked();
    expect(retry).toMatchObject({ taskId: ev.payload.taskId, deliveryAttemptCount: 1 });
    // Backed off by at least the circuit breaker's reset time.
    expect(Date.parse(retry.scheduledAt)).toBeGreaterThanOrEqual(Date.now() + 25_000);
    // Parked as it arrived: no rendered body or abort signal carried along.
    expect(retry.signal).toBeUndefined();
    expect(await infra.redis.xlen(STREAMS.SCHEDULED)).toBe(1);
    // The attempt is still in the log, as dispatched.
    expect((await events()).filter((e) => e.type === "notification.dispatched")).toHaveLength(1);
    // Released, so the re-queued attempt can take the lease.
    expect(await infra.redis.exists(`notif:processed:delivery:${ev.payload.taskId}`)).toBe(0);
  });

  it("delivers on a later attempt once the provider is back", async () => {
    const flaky = new FakeProvider("email", (n) =>
      n === 1
        ? { success: false, error: "503 Service Unavailable" }
        : { success: true, providerMessageId: "late-1" },
    );
    const w = worker(registry(flaky));
    await w.processInline(dispatched() as any);

    // What the scheduler would release when the retry falls due.
    const [retry] = await parked();
    await w.processInline({
      ...buildStreamEvent("notification.dispatched", retry, "scheduler"),
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    } as any);
    await w.stop();

    expect(flaky.calls).toBe(2);
    const delivered = (await events()).find((e) => e.type === "notification.delivered");
    expect(delivered.payload).toMatchObject({ providerMessageId: "late-1", attempt: 2 });
    expect(await dlq()).toEqual([]);
  });

  it("fails a provider that is still down on the last attempt, and dead-letters the task", async () => {
    const hang = new FakeProvider("email", () => new Promise(() => {}));
    const w = worker(registry(hang));
    await w.start();
    const ev = dispatched({ deliveryAttemptCount: 2 });
    await publish(ev);

    await waitFor("dead-lettered", async () => (await dlq()).length === 1, 5_000);
    expect((await dlq())[0].dlq.reason).toMatch(/timeout/i);
    await waitFor("failure event", async () =>
      (await events()).some((e) => e.type === "notification.failed"),
    );
    const failed = (await events()).find((e) => e.type === "notification.failed");
    expect(failed.payload).toMatchObject({
      taskId: ev.payload.taskId,
      failureCode: "provider_error",
      attempt: 3,
    });
    expect(await parked()).toEqual([]);
    // Released, so a replay from the DLQ can try again.
    expect(await infra.redis.exists(`notif:processed:delivery:${ev.payload.taskId}`)).toBe(0);
  });

  it("keeps sending to a provider that rejected addresses, rather than tripping its breaker", async () => {
    // A run of dead addresses in a list is the provider answering correctly;
    // opening the breaker on it held up everyone else's mail.
    const provider = new FakeProvider("email", () => ({ success: true, providerMessageId: "ok" }));
    const send = provider.send.bind(provider);
    provider.send = async (task?: any) =>
      task?.destination === "dead@x.com"
        ? { success: false, error: "422 invalid recipient", retryable: false }
        : send();
    const w = worker(registry(provider));

    for (let i = 0; i < 6; i++) {
      await w.processInline(dispatched({ destination: "dead@x.com" }) as any).catch(() => {});
    }
    const good = dispatched();
    await w.processInline(good as any);
    await w.stop();

    const delivered = (await events()).filter((e) => e.type === "notification.delivered");
    expect(delivered.map((e) => e.payload.taskId)).toEqual([good.payload.taskId]);
    expect(await parked()).toEqual([]);
  });

  it("still opens the breaker on a provider that keeps failing", async () => {
    const down = new FakeProvider("email", () => ({ success: false, error: "503" }));
    const w = worker(registry(down));
    for (let i = 0; i < 6; i++) await w.processInline(dispatched() as any);
    await w.stop();
    // Five failures open it; the sixth send never reaches the provider.
    expect(down.calls).toBe(5);
  });

  it("fails over to the next provider for the channel, in priority order", async () => {
    const primary = new FakeProvider("email", () => ({
      success: false,
      error: "503 from primary",
    }));
    const backup = new FakeProvider("email", () => ({
      success: true,
      providerMessageId: "backup-1",
    }));
    const w = worker(registry(primary, backup));
    await w.start();
    const ev = dispatched();
    await publish(ev);

    await waitFor("delivered", async () =>
      (await events()).some((e) => e.type === "notification.delivered"),
    );
    expect(primary.calls).toBe(1);
    expect(backup.calls).toBe(1);
    const [outbox] =
      await infra.sql`SELECT provider_message_id FROM delivery_outbox WHERE task_id = ${ev.payload.taskId as string}`;
    await waitFor(
      "outbox",
      async () =>
        (await infra.sql`SELECT 1 FROM delivery_outbox WHERE provider_message_id = 'backup-1'`)
          .length === 1,
    );
    void outbox;
  });

  it("does not retry a failure the provider says is permanent", async () => {
    const reject = new FakeProvider("email", () => ({
      success: false,
      error: "invalid recipient",
      retryable: false,
    }));
    await worker(registry(reject)).processInline(dispatched() as any);
    expect(reject.calls).toBe(1);
    expect(await parked()).toEqual([]);
    expect((await dlq())[0].dlq.reason).toBe("invalid recipient");
  });

  it("stops calling a provider that keeps failing once its circuit opens, and parks what it turned away", async () => {
    const down = new FakeProvider("email", () => ({ success: false, error: "down" }));
    const w = worker(registry(down));
    // One at a time: sends already in flight when the circuit opens still go out.
    for (let i = 0; i < 8; i++) await w.processInline(dispatched() as any);

    expect(down.calls).toBe(5);
    // An open circuit is an outage, not a verdict on the message: nothing is
    // dead-lettered, and every task waits for another attempt.
    expect(await dlq()).toEqual([]);
    const retries = await parked();
    expect(retries).toHaveLength(8);
    expect(retries.every((r) => r.deliveryAttemptCount === 1)).toBe(true);
  });

  it("keeps a circuit per provider, even for two providers of the same class", async () => {
    const down = new FakeProvider("email", () => ({ success: false, error: "down" }));
    const backup = new FakeProvider("email", () => ({ success: true, providerMessageId: "b" }));
    const w = worker(registry(down, backup));
    for (let i = 0; i < 8; i++) await w.processInline(dispatched() as any);

    // The backup's successes are not the primary's: its circuit opens after
    // five failures, and every task still goes out through the backup.
    expect(down.calls).toBe(5);
    expect(backup.calls).toBe(8);
    expect(await dlq()).toEqual([]);
  });

  it("sends a task once when two workers race for it", async () => {
    let sends = 0;
    const slow = new FakeProvider("email", async () => {
      sends++;
      await settle(200);
      return { success: true, providerMessageId: "p" };
    });
    const reg = registry(slow);
    const ev = dispatched();
    await Promise.all([
      worker(reg, "a").processInline(ev as any),
      worker(reg, "b").processInline(ev as any),
    ]);
    await worker(reg, "c").processInline(ev as any);
    expect(sends).toBe(1);
  });

  it("defers sends over the provider's limit, and fails them once the deferrals run out", async () => {
    const limited = new FakeProvider("sms", () => ({ success: true, providerMessageId: "x" }), {
      limit: 1,
      windowSeconds: 60,
    });
    const w = worker(registry(limited));
    await w.start();
    const first = dispatched({ channel: "sms", destination: "+1" });
    const second = dispatched({ channel: "sms", destination: "+2" });
    // Waiting for capacity is not a failed attempt: a backlog several windows
    // deep must keep waiting, not fail once it has waited maxAttempts times.
    const waitedLong = dispatched({
      channel: "sms",
      destination: "+3",
      throttleAttemptCount: 3,
      deliveryOptions: { maxAttempts: 3, timeoutMs: 10_000 },
    });
    const exhausted = dispatched({
      channel: "sms",
      destination: "+4",
      throttleAttemptCount: MAX_THROTTLE_DEFERRALS,
    });
    for (const ev of [first, second, waitedLong, exhausted]) await publish(ev);

    await waitFor("one sent", () => limited.calls === 1);
    await waitFor("deferred", async () => (await infra.redis.xlen(STREAMS.SCHEDULED)) === 2);
    const rows = await infra.sql`SELECT payload FROM scheduled_payloads`;
    expect(rows.map((r) => r.payload.throttleAttemptCount).sort()).toEqual([1, 4]);
    for (const r of rows) expect(Date.parse(r.payload.scheduledAt)).toBeGreaterThan(Date.now());

    await waitFor("exhausted one failed", async () =>
      (await events()).some(
        (e) =>
          e.type === "notification.failed" &&
          e.payload.failureCode === "provider_throttle_exceeded",
      ),
    );
    expect(limited.calls).toBe(1);
  });

  describe("provider rate limits are per provider, not per channel", () => {
    const ok = () => ({ success: true, providerMessageId: "x" });

    it("sends through the backup once the primary's limit is spent", async () => {
      const primary = new FakeProvider("email", ok, { limit: 1, windowSeconds: 60 });
      const backup = new FakeProvider("email", ok, { limit: 5, windowSeconds: 60 });
      const w = worker(registry(primary, backup));
      for (let i = 0; i < 3; i++) await w.processInline(dispatched() as any);

      expect(primary.calls).toBe(1);
      expect(backup.calls).toBe(2);
      expect(await parked()).toEqual([]);
    });

    it("uses an unlimited backup behind a limited primary", async () => {
      const primary = new FakeProvider("email", ok, { limit: 1, windowSeconds: 60 });
      const backup = new FakeProvider("email", ok);
      const w = worker(registry(primary, backup));
      for (let i = 0; i < 3; i++) await w.processInline(dispatched() as any);

      expect([primary.calls, backup.calls]).toEqual([1, 2]);
    });

    it("defers a send only once every provider for the channel is at its limit", async () => {
      const primary = new FakeProvider("email", ok, { limit: 1, windowSeconds: 60 });
      const backup = new FakeProvider("email", ok, { limit: 1, windowSeconds: 60 });
      const w = worker(registry(primary, backup));
      for (let i = 0; i < 3; i++) await w.processInline(dispatched() as any);

      expect([primary.calls, backup.calls]).toEqual([1, 1]);
      const deferred = await parked();
      expect(deferred).toHaveLength(1);
      expect(deferred[0].throttleAttemptCount).toBe(1);
    });
  });

  it("dead-letters a task whose template was deleted after it was dispatched", async () => {
    const ok = new FakeProvider("email", () => ({ success: true, providerMessageId: "x" }));
    const w = worker(registry(ok));
    await w.start();
    await publish(dispatched({ renderedContent: undefined, templateId: "gone" }));
    await waitFor("dead-lettered", async () => (await dlq()).length === 1);
    expect((await dlq())[0].dlq.reason).toMatch(/template "gone" not found/);
    expect(ok.calls).toBe(0);
  });

  it("renders an unrendered task from its template at send time", async () => {
    let seen: any;
    const capture = new FakeProvider("email", () => ({ success: true, providerMessageId: "x" }));
    (capture as any).send = async (task: any) => {
      seen = task.renderedContent;
      return { success: true, providerMessageId: "x" };
    };
    await new TemplateRepository(infra.db).upsertMany(project, [
      { id: "t", channel: "email", content: { subject: "Hi {{n}}" } },
    ]);
    await worker(registry(capture)).processInline(
      dispatched({
        renderedContent: undefined,
        templateId: "t",
        templateVariables: { n: "Bo" },
      }) as any,
    );
    expect(seen).toEqual({ content: { subject: "Hi Bo" } });
  });

  it("with no provider for the channel, falls back along the chain or records the failure", async () => {
    const w = worker(registry());
    await w.processInline(dispatched({ channel: "sms", fallbackChain: ["email"] }) as any);
    const enriched = await infra.redis.xrange(STREAMS.ENRICHED_NORMAL, "-", "+");
    const next = JSON.parse(enriched[0]![1][1]!).payload;
    expect(next.channel).toBe("email");
    expect(next.fallbackChain).toBeUndefined();

    await w.processInline(dispatched({ channel: "sms" }) as any);
    await w.stop();
    const failed = (await events()).find((e) => e.type === "notification.failed");
    expect(failed.payload.failureCode).toBe("no_transport");
  });

  describe("push", () => {
    async function pushUser(token: string) {
      await new UserRepository(infra.db).upsertFull(project, {
        userId: "u",
        segments: [],
        preferences: {},
      });
      await new ContactRepository(infra.db).upsert(project, "u", "push", token);
    }

    it("deactivates a dead token and falls back to the next channel", async () => {
      await pushUser("dead");
      const push = new FakeProvider("push", () => ({ success: false, invalidToken: true }));
      await worker(registry(push)).processInline(
        dispatched({ channel: "push", destination: "dead", fallbackChain: ["email"] }) as any,
      );

      const [contact] = await new ContactRepository(infra.db).findByUserId(project, "u");
      expect(contact!.active).toBe(false);
      expect(await infra.redis.xrange(STREAMS.ENRICHED_NORMAL, "-", "+")).toHaveLength(1);
    });

    it("retries a push that failed, and dead-letters it once out of attempts", async () => {
      await pushUser("tok");
      const push = new FakeProvider("push", () => ({ success: false, error: "FCM unavailable" }));
      const w = worker(registry(push));
      await w.processInline(dispatched({ channel: "push", destination: "tok" }) as any);
      expect(await dlq()).toEqual([]);
      expect(await parked()).toHaveLength(1);

      await w.processInline(
        dispatched({ channel: "push", destination: "tok", deliveryAttemptCount: 2 }) as any,
      );
      expect((await dlq())[0].dlq.reason).toBe("FCM unavailable");
      const [contact] = await new ContactRepository(infra.db).findByUserId(project, "u");
      expect(contact!.active).toBe(true);
    });

    it("delivers a push and records the provider's id", async () => {
      const push = new FakeProvider("push", () => ({ success: true, providerMessageId: "fcm-1" }));
      const w = worker(registry(push));
      await w.processInline(dispatched({ channel: "push", destination: "tok" }) as any);
      await w.stop();
      const delivered = (await events()).find((e) => e.type === "notification.delivered");
      expect(delivered.payload).toMatchObject({ providerMessageId: "fcm-1", channel: "push" });
      // The dispatch entry rides on the outcome rather than being a second event.
      expect(delivered.payload.dispatchedAt).toBeDefined();
    });
  });
});
