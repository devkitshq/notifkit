import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, connect, type Socket, type AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { StreamProducer, StreamConsumer, PendingMessageScanner } from "@/queue/index.js";
import { STREAMS, CONSUMER_GROUPS, buildStreamEvent, type StreamName } from "@/contracts/index.js";
import { createLogger } from "@/logger/index.js";
import { useInfra, waitFor, settle } from "./support/infra.js";

const infra = useInfra();
const logger = createLogger({ name: "test", level: "silent" });

const A = STREAMS.INBOUND_NORMAL;
const B = STREAMS.INBOUND_LOW;
const DLQ = STREAMS.DEAD_LETTER;
const GROUP = CONSUMER_GROUPS.ENRICHER;

function event(n = 0) {
  return buildStreamEvent("test.event", { n }, "test");
}

/** A full envelope, as it would sit in a stream. */
function envelope(n = 0) {
  return { ...event(n), id: randomUUID(), timestamp: new Date().toISOString() };
}

const consumers: StreamConsumer[] = [];
function consumer(opts: Partial<ConstructorParameters<typeof StreamConsumer>[0]> = {}) {
  const c = new StreamConsumer({
    redis: infra.redis,
    stream: A,
    group: GROUP,
    consumer: `c-${randomUUID().slice(0, 6)}`,
    blockMs: 100,
    logger,
    ...opts,
  });
  consumers.push(c);
  return c;
}

/** Reads until `count` messages arrived or the timeout passes. */
async function readN(c: StreamConsumer, count: number, timeoutMs = 5_000) {
  const got: any[] = [];
  const it = c.readBatch();
  const deadline = Date.now() + timeoutMs;
  while (got.length < count && Date.now() < deadline) {
    const next = await Promise.race([
      it.next(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now()),
      ),
    ]);
    if (next.done) break;
    got.push(...next.value);
  }
  await c.stop();
  return got;
}

async function pendingCount(stream: string, group = GROUP): Promise<number> {
  const summary = (await infra.redis.xpending(stream, group)) as any[];
  return Number(summary[0]);
}

beforeEach(async () => {
  await infra.redis.flushdb();
});

afterEach(async () => {
  await Promise.all(consumers.splice(0).map((c) => c.stop().catch(() => {})));
});

describe("StreamProducer", () => {
  it("writes an envelope with a fresh id and timestamp, and returns the stream entry id", async () => {
    const producer = new StreamProducer({ redis: infra.redis, stream: A, logger, maxLen: 1000 });
    const entryId = await producer.publish(event(7));

    const entries = await infra.redis.xrange(A, "-", "+");
    expect(entries).toHaveLength(1);
    expect(entries[0]![0]).toBe(entryId);
    const stored = JSON.parse(entries[0]![1][1]!);
    expect(stored.payload).toEqual({ n: 7 });
    expect(stored.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(stored.timestamp))).toBe(false);
  });

  it("keeps every message and their order when hundreds are published at once", async () => {
    const producer = new StreamProducer({ redis: infra.redis, stream: A, logger, maxLen: 10_000 });
    const ids = await Promise.all(
      Array.from({ length: 350 }, (_, n) => producer.publish(event(n))),
    );

    expect(new Set(ids).size).toBe(350);
    const entries = await infra.redis.xrange(A, "-", "+");
    expect(entries.map((e) => JSON.parse(e[1][1]!).payload.n)).toEqual(
      Array.from({ length: 350 }, (_, n) => n),
    );
  });

  it("keeps every unprocessed message when the backlog grows past maxLen", async () => {
    // Acked entries are deleted, so whatever is in a stream is work not yet
    // done. Trimming it to maxLen dropped notifications nobody had sent.
    const producer = new StreamProducer({ redis: infra.redis, stream: A, logger, maxLen: 10 });
    for (let batch = 0; batch < 10; batch++) {
      await Promise.all(Array.from({ length: 100 }, (_, n) => producer.publish(event(n))));
    }
    expect(await infra.redis.xlen(A)).toBe(1000);
  });

  it("keeps a message that was read but not yet acked when the backlog grows past maxLen", async () => {
    const producer = new StreamProducer({ redis: infra.redis, stream: A, logger, maxLen: 10 });
    await infra.redis.xgroup("CREATE", A, GROUP, "0", "MKSTREAM");
    const inFlight = await producer.publish(event(-1));
    await infra.redis.xreadgroup("GROUP", GROUP, "busy", "COUNT", 1, "STREAMS", A, ">");

    for (let batch = 0; batch < 5; batch++) {
      await Promise.all(Array.from({ length: 100 }, (_, n) => producer.publish(event(n))));
    }

    // The worker holding it must still be able to re-read it after a crash.
    expect(await infra.redis.xrange(A, inFlight, inFlight)).toHaveLength(1);
  });

  it("rejects the publish when Redis refuses the write", async () => {
    await infra.redis.set(A, "not a stream");
    const producer = new StreamProducer({ redis: infra.redis, stream: A, logger, maxLen: 100 });
    await expect(producer.publish(event())).rejects.toThrow(/WRONGTYPE/);
  });

  it("publishBatch returns the ids of the events it actually published", async () => {
    const producer = new StreamProducer({ redis: infra.redis, stream: A, logger, maxLen: 1000 });
    const { messageIds, eventIds } = await producer.publishBatch([event(1), event(2), event(3)]);

    const entries = await infra.redis.xrange(A, "-", "+");
    expect(entries.map((e) => e[0])).toEqual(messageIds);
    // Callers record eventIds as the notification id (workflow step.notify
    // does), so each must be the id of the event that entry holds.
    expect(entries.map((e) => JSON.parse(e[1][1]!).id)).toEqual(eventIds);
  });

  it("publishBatch of nothing writes nothing", async () => {
    const producer = new StreamProducer({ redis: infra.redis, stream: A, logger, maxLen: 1000 });
    expect(await producer.publishBatch([])).toEqual({ messageIds: [], eventIds: [] });
    expect(await infra.redis.exists(A)).toBe(0);
  });
});

describe("StreamConsumer", () => {
  it("delivers messages published before the group existed", async () => {
    await infra.redis.xadd(A, "*", "data", JSON.stringify(envelope(1)));
    const c = consumer();
    await c.ensureGroup();

    const got = await readN(c, 1);
    expect(got.map((m) => m.event.payload.n)).toEqual([1]);
  });

  it("ensureGroup is safe to call repeatedly and creates missing streams", async () => {
    const c = consumer({ stream: [A, B] });
    await c.ensureGroup();
    await c.ensureGroup();
    const groups = (await infra.redis.xinfo("GROUPS", B)) as any[];
    expect(groups).toHaveLength(1);
  });

  it("reads from several streams and tags each message with its stream", async () => {
    const c = consumer({ stream: [A, B] });
    await c.ensureGroup();
    await infra.redis.xadd(A, "*", "data", JSON.stringify(envelope(1)));
    await infra.redis.xadd(B, "*", "data", JSON.stringify(envelope(2)));

    const got = await readN(c, 2);
    const byN = Object.fromEntries(got.map((m) => [m.event.payload.n, m]));
    expect(byN[1]!.stream).toBe(A);
    expect(byN[2].stream).toBe(B);
    expect(byN[1].deliveryCount).toBe(1);
  });

  it("acks and skips entries it cannot parse instead of leaving them pending", async () => {
    const c = consumer();
    await c.ensureGroup();
    await infra.redis.xadd(A, "*", "other", "x");
    await infra.redis.xadd(A, "*", "data", "{not json");
    await infra.redis.xadd(A, "*", "data", JSON.stringify({ hello: "world" }));
    await infra.redis.xadd(A, "*", "data", JSON.stringify(envelope(9)));

    const got = await readN(c, 1);
    expect(got.map((m) => m.event.payload.n)).toEqual([9]);
    // Only the good one is still pending; it has not been acked yet.
    expect(await pendingCount(A)).toBe(1);
  });

  it("ack removes the message from the pending list", async () => {
    const c = consumer();
    await c.ensureGroup();
    await infra.redis.xadd(A, "*", "data", JSON.stringify(envelope()));
    const [msg] = await readN(c, 1);
    expect(await pendingCount(A)).toBe(1);

    await c.ack(msg.id, msg.stream);
    expect(await pendingCount(A)).toBe(0);
  });

  it("buffered acks land once the timer fires, and on flushAcks", async () => {
    const c = consumer({ bufferAcks: true, ackFlushMs: 20, batchSize: 100 });
    await c.ensureGroup();
    for (let n = 0; n < 3; n++) await infra.redis.xadd(A, "*", "data", JSON.stringify(envelope(n)));
    const got = await readN(c, 3);

    await c.ack(got[0].id, A);
    expect(await pendingCount(A)).toBe(3); // still buffered
    await waitFor("timer flush", async () => (await pendingCount(A)) === 2, 2_000);

    await c.ack([got[1].id, got[2].id], A);
    await c.flushAcks();
    expect(await pendingCount(A)).toBe(0);
  });

  it("buffered acks flush immediately once a batch is full", async () => {
    const c = consumer({ bufferAcks: true, ackFlushMs: 60_000, batchSize: 2 });
    await c.ensureGroup();
    for (let n = 0; n < 2; n++) await infra.redis.xadd(A, "*", "data", JSON.stringify(envelope(n)));
    const got = await readN(c, 2);

    await c.ack(got[0].id, A);
    await c.ack(got[1].id, A);
    expect(await pendingCount(A)).toBe(0);
  });

  it("stop() flushes buffered acks", async () => {
    const c = consumer({ bufferAcks: true, ackFlushMs: 60_000, batchSize: 100 });
    await c.ensureGroup();
    await infra.redis.xadd(A, "*", "data", JSON.stringify(envelope()));
    const [msg] = await readN(c, 1);
    await c.ack(msg.id, A);
    await c.stop();
    expect(await pendingCount(A)).toBe(0);
  });

  it("nack moves the message to the dead-letter stream and acks it", async () => {
    const c = consumer({ dlqStream: DLQ });
    await c.ensureGroup();
    const original = envelope(5);
    await infra.redis.xadd(A, "*", "data", JSON.stringify(original));
    const [msg] = await readN(c, 1);

    await c.nack(msg.id, msg.event, msg.stream);

    expect(await pendingCount(A)).toBe(0);
    const dlq = await infra.redis.xrange(DLQ, "-", "+");
    expect(dlq).toHaveLength(1);
    const dead = JSON.parse(dlq[0]![1][1]!);
    expect(dead.id).toBe(original.id);
    expect(dead.dlq.originalStream).toBe(A);
  });

  it("nack leaves the message pending when the dead-letter write fails", async () => {
    await infra.redis.set(DLQ, "wrong type");
    const c = consumer({ dlqStream: DLQ });
    await c.ensureGroup();
    await infra.redis.xadd(A, "*", "data", JSON.stringify(envelope()));
    const [msg] = await readN(c, 1);

    await expect(c.nack(msg.id, msg.event, msg.stream)).rejects.toThrow();
    // Never acked against a DLQ write that did not land.
    expect(await pendingCount(A)).toBe(1);
  });

  it("nack without a dead-letter stream just acks", async () => {
    const c = consumer();
    await c.ensureGroup();
    await infra.redis.xadd(A, "*", "data", JSON.stringify(envelope()));
    const [msg] = await readN(c, 1);
    await c.nack(msg.id, msg.event, msg.stream);
    expect(await pendingCount(A)).toBe(0);
    expect(await infra.redis.exists(DLQ)).toBe(0);
  });

  // Each stream has exactly one consumer group, so once that group has acked an
  // entry nothing will read it again. Left in place it holds Redis memory for
  // good, which under load is the bulk of what Redis stores.
  describe("deletes entries once they are acked", () => {
    async function ids(stream: string) {
      return (await infra.redis.xrange(stream, "-", "+")).map((e) => e[0]);
    }

    it("ack deletes the acked entry and leaves the unacked ones", async () => {
      const c = consumer();
      await c.ensureGroup();
      for (let n = 0; n < 3; n++)
        await infra.redis.xadd(A, "*", "data", JSON.stringify(envelope(n)));
      const got = await readN(c, 3);

      await c.ack(got[0].id, A);
      expect(await ids(A)).toEqual([got[1].id, got[2].id]);

      await c.ack([got[1].id, got[2].id], A);
      expect(await infra.redis.xlen(A)).toBe(0);
    });

    it("buffered acks delete the entries they flush", async () => {
      const c = consumer({ bufferAcks: true, ackFlushMs: 60_000, batchSize: 100 });
      await c.ensureGroup();
      for (let n = 0; n < 2; n++)
        await infra.redis.xadd(A, "*", "data", JSON.stringify(envelope(n)));
      const got = await readN(c, 2);

      await c.ack(got[0].id, A);
      expect(await infra.redis.xlen(A)).toBe(2); // still buffered
      await c.ack(got[1].id, A);
      await c.flushAcks();
      expect(await infra.redis.xlen(A)).toBe(0);
    });

    it("unparseable entries are deleted as they are skipped", async () => {
      const c = consumer();
      await c.ensureGroup();
      await infra.redis.xadd(A, "*", "data", "{not json");
      const good = await infra.redis.xadd(A, "*", "data", JSON.stringify(envelope(9)));

      await readN(c, 1);
      expect(await ids(A)).toEqual([good]);
    });

    it("nack deletes the entry once it is in the dead-letter stream", async () => {
      const c = consumer({ dlqStream: DLQ });
      await c.ensureGroup();
      await infra.redis.xadd(A, "*", "data", JSON.stringify(envelope()));
      const [msg] = await readN(c, 1);

      await c.nack(msg.id, msg.event, msg.stream);
      expect(await infra.redis.xlen(A)).toBe(0);
      expect(await infra.redis.xlen(DLQ)).toBe(1);
    });

    it("nack keeps the entry when the dead-letter write fails", async () => {
      await infra.redis.set(DLQ, "wrong type");
      const c = consumer({ dlqStream: DLQ });
      await c.ensureGroup();
      await infra.redis.xadd(A, "*", "data", JSON.stringify(envelope()));
      const [msg] = await readN(c, 1);

      await expect(c.nack(msg.id, msg.event, msg.stream)).rejects.toThrow();
      expect(await ids(A)).toEqual([msg.id]);
    });

    it("an acked entry is not redelivered when the group is recreated", async () => {
      const c = consumer();
      await c.ensureGroup();
      await infra.redis.xadd(A, "*", "data", JSON.stringify(envelope(1)));
      const [msg] = await readN(c, 1);
      await c.ack(msg.id, A);

      // ensureGroup starts a missing group from "0", so anything still in the
      // stream would be processed a second time.
      await infra.redis.xgroup("DESTROY", A, GROUP);
      const again = consumer();
      await again.ensureGroup();
      await infra.redis.xadd(A, "*", "data", JSON.stringify(envelope(2)));
      const got = await readN(again, 2, 1_000);
      expect(got.map((m) => m.event.payload.n)).toEqual([2]);
    });
  });

  it("deadLetter records an in-process event against the consumer's stream", async () => {
    const c = consumer({ dlqStream: DLQ });
    const ev = envelope(3);
    await c.deadLetter(ev);
    const [[, fields]] = (await infra.redis.xrange(DLQ, "-", "+")) as any;
    const dead = JSON.parse(fields[1]);
    expect(dead.id).toBe(ev.id);
    expect(dead.dlq.originalStream).toBe(A);
  });

  it("recreates its group and keeps reading after Redis loses its data", async () => {
    const c = consumer();
    await c.ensureGroup();
    const it = c.readBatch();

    await infra.redis.xadd(A, "*", "data", JSON.stringify(envelope(1)));
    const first = await it.next();
    expect(first.value![0]!.event.payload.n).toBe(1);

    await infra.redis.flushdb();
    // Give the blocked read a moment to hit NOGROUP before anything is written.
    await settle(300);
    await infra.redis.xadd(A, "*", "data", JSON.stringify(envelope(2)));

    const second = await Promise.race([
      it.next(),
      settle(5_000).then(() => ({ value: [] as any[] })),
    ]);
    expect(second.value!.map((m: any) => m.event.payload.n)).toEqual([2]);
  });

  it("stop() ends the read loop", async () => {
    const c = consumer();
    await c.ensureGroup();
    const it = c.readBatch();
    const pending = it.next();
    await settle(50);
    await c.stop();
    const result = await Promise.race([pending, settle(3_000).then(() => "hung" as const)]);
    expect(result).not.toBe("hung");
  });
});

describe("PendingMessageScanner", () => {
  async function deliverUnacked(stream: StreamName, n: number, consumerName = "dead-worker") {
    // In production the scanner's consumer has already created the group on
    // every stream it reads.
    for (const s of [A, B])
      await infra.redis.xgroup("CREATE", s, GROUP, "0", "MKSTREAM").catch(() => {});
    for (let i = 0; i < n; i++) {
      await infra.redis.xadd(stream, "*", "data", JSON.stringify(envelope(i)));
    }
    await infra.redis.xreadgroup("GROUP", GROUP, consumerName, "COUNT", n, "STREAMS", stream, ">");
  }

  function scanner(name = "rescuer", stream: StreamName | StreamName[] = [A, B]) {
    return new PendingMessageScanner({
      redis: infra.redis,
      stream,
      group: GROUP,
      consumer: name,
      logger,
    });
  }

  it("counts and lists pending entries across its streams", async () => {
    await deliverUnacked(A, 2);
    await deliverUnacked(B, 3);
    const s = scanner();

    expect(await s.getPendingCount()).toBe(5);
    const entries = await s.getPendingEntries(100);
    expect(entries).toHaveLength(5);
    expect(entries.filter((e) => e.stream === B)).toHaveLength(3);
    expect(entries.every((e) => e.consumer === "dead-worker" && e.deliveryCount === 1)).toBe(true);
    expect(await s.getPendingEntries(4)).toHaveLength(4);
    expect(await s.getPendingEntries(100, A)).toHaveLength(2);
  });

  it("claims only entries idle past the threshold and bumps their delivery count", async () => {
    await deliverUnacked(A, 2);
    const s = scanner();

    expect(await s.autoclaim(60_000)).toEqual([]);

    await settle(150);
    const claimed = await s.autoclaim(100);
    expect(claimed).toHaveLength(2);
    expect(claimed.every((m) => m.stream === A && m.deliveryCount === 2)).toBe(true);
    const entries = await s.getPendingEntries(10);
    expect(entries.every((e) => e.consumer === "rescuer")).toBe(true);
  });

  it("backs off exponentially with each redelivery", async () => {
    await deliverUnacked(A, 1);
    const s = scanner();
    await settle(350);
    expect(await s.autoclaim(300)).toHaveLength(1); // delivered once: needs > 300ms idle

    // Delivered twice now, so it needs > 600ms idle. Checked straight after the
    // claim reset its idle time, so a slow machine cannot make this pass or fail.
    expect(await s.autoclaim(300)).toHaveLength(0);
    await settle(700);
    expect(await s.autoclaim(300)).toHaveLength(1);
  });

  it("never hands one entry to two racing scanners", async () => {
    await deliverUnacked(A, 20);
    await settle(150);
    const [x, y] = await Promise.all([
      scanner("x").autoclaim(100, 50),
      scanner("y").autoclaim(100, 50),
    ]);
    const ids = [...x, ...y].map((m) => m.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it("does not claim a message from one stream using an id pending on another", async () => {
    await infra.redis.xgroup("CREATE", A, GROUP, "0", "MKSTREAM");
    await infra.redis.xgroup("CREATE", B, GROUP, "0", "MKSTREAM");
    // Same entry id in both streams; only B's is pending.
    await infra.redis.xadd(A, "1-1", "data", JSON.stringify(envelope(100)));
    await infra.redis.xadd(B, "1-1", "data", JSON.stringify(envelope(200)));
    await infra.redis.xreadgroup("GROUP", GROUP, "dead", "STREAMS", B, ">");
    await settle(150);

    const claimed = await scanner().autoclaim(100);
    expect(claimed.map((m) => [m.stream, m.event.payload.n])).toEqual([[B, 200]]);
    expect(await pendingCount(A)).toBe(0);
  });

  it("respects the claim limit", async () => {
    await deliverUnacked(A, 10);
    await settle(150);
    expect(await scanner().autoclaim(100, 3)).toHaveLength(3);
  });
});

/**
 * A TCP relay to the test Redis that can stop handing replies back, the way a
 * half-open socket does: the client's commands go out and nothing comes in.
 * Replies held while stalled are released when it resumes.
 */
async function stallableRedisProxy(redisUrl: string) {
  const target = new URL(redisUrl);
  let stalled = false;
  const held: { socket: Socket; data: Buffer }[] = [];
  const sockets = new Set<Socket>();
  let clientsClosed = 0;
  const server = createServer((client) => {
    const upstream = connect(Number(target.port), target.hostname);
    sockets.add(client).add(upstream);
    client.on("data", (d) => upstream.write(d));
    upstream.on("data", (d) =>
      stalled ? held.push({ socket: client, data: d }) : client.write(d),
    );
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("close", () => clientsClosed++);
    client.on("close", close).on("error", close);
    upstream.on("close", close).on("error", close);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `redis://127.0.0.1:${port}${target.pathname}`,
    /** Client connections that have hung up, e.g. one given up as dead. */
    clientsClosed: () => clientsClosed,
    stall: () => (stalled = true),
    resume: () => {
      stalled = false;
      for (const { socket, data } of held.splice(0)) if (!socket.destroyed) socket.write(data);
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe("StreamConsumer on a dead connection", () => {
  it("reconnects and keeps reading after a read stalls past its deadline", async () => {
    const proxy = await stallableRedisProxy(infra.redisUrl);
    const viaProxy = new Redis(proxy.url, { maxRetriesPerRequest: null });
    try {
      const c = consumer({ redis: viaProxy });
      await c.ensureGroup();

      proxy.stall();
      const read = readN(c, 1, 60_000);
      // The read's blockMs + 5s guard gives the connection up.
      await waitFor("stalled connection given up", () => proxy.clientsClosed() > 0, 30_000);
      proxy.resume();

      const producer = new StreamProducer({ redis: infra.redis, stream: A, logger, maxLen: 1000 });
      await producer.publish(event(42));

      const got = await read;
      expect(got.map((m) => m.event.payload.n)).toEqual([42]);
    } finally {
      viaProxy.disconnect();
      await proxy.close();
    }
  });
});
