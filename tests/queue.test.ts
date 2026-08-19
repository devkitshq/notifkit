import { describe, it, expect, vi, afterEach } from "vitest";
import { StreamConsumer, PendingMessageScanner } from "@/queue/index.js";
import { IdempotencyGuard } from "@/idempotency/index.js";

/** A well-formed envelope, since anything else is dropped before it is yielded. */
function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    type: "notification.requested",
    timestamp: new Date().toISOString(),
    payload: { hello: "world" },
    metadata: { traceId: "t1", source: "test", retryCount: 0 },
    ...overrides,
  };
}

/** One XREADGROUP reply carrying a single entry. */
function reply(stream: string, id: string, raw: string) {
  return [[stream, [[id, ["data", raw]]]]];
}

const silentLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
});

describe("StreamConsumer", () => {
  it("creates a new group from the start of the stream", async () => {
    const mockRedis = {
      xgroup: vi.fn().mockResolvedValue("OK"),
      duplicate: vi.fn().mockReturnThis(),
    };
    const consumer = new StreamConsumer({
      redis: mockRedis as any,
      stream: "stream-1" as any,
      group: "my-group" as any,
      consumer: "my-consumer",
    });

    await consumer.ensureGroup();

    expect(mockRedis.xgroup).toHaveBeenCalledWith(
      "CREATE",
      "stream-1",
      "my-group",
      "0",
      "MKSTREAM",
    );
  });

  it("acks a message on a specific stream in multi-stream mode", async () => {
    const mockRedis = {
      xack: vi.fn().mockResolvedValue(1),
      duplicate: vi.fn().mockReturnThis(),
    };

    const consumer = new StreamConsumer({
      redis: mockRedis as any,
      stream: ["stream-1", "stream-2"] as any,
      group: "my-group" as any,
      consumer: "my-consumer",
    });

    await consumer.ack("123-0", "stream-2");

    expect(mockRedis.xack).toHaveBeenCalledWith("stream-2", "my-group", "123-0");
  });

  it("defaults to the first stream if no stream is provided to ack", async () => {
    const mockRedis = {
      xack: vi.fn().mockResolvedValue(1),
      duplicate: vi.fn().mockReturnThis(),
    };

    const consumer = new StreamConsumer({
      redis: mockRedis as any,
      stream: ["stream-1", "stream-2"] as any,
      group: "my-group" as any,
      consumer: "my-consumer",
    });

    await consumer.ack("123-0");

    expect(mockRedis.xack).toHaveBeenCalledWith("stream-1", "my-group", "123-0");
  });
});

describe("StreamConsumer.ensureGroup", () => {
  it("treats an existing group as success and carries on to the next stream", async () => {
    const mockRedis = {
      xgroup: vi
        .fn()
        .mockRejectedValueOnce(new Error("BUSYGROUP Consumer Group name already exists"))
        .mockResolvedValueOnce("OK"),
      duplicate: vi.fn().mockReturnThis(),
    };
    const consumer = new StreamConsumer({
      redis: mockRedis as any,
      stream: ["stream-1", "stream-2"] as any,
      group: "g" as any,
      consumer: "c",
      logger: silentLogger() as any,
    });

    await expect(consumer.ensureGroup()).resolves.toBeUndefined();
    expect(mockRedis.xgroup).toHaveBeenCalledTimes(2);
  });

  it("rethrows anything that is not BUSYGROUP, so a broken redis is not mistaken for a ready one", async () => {
    const mockRedis = {
      xgroup: vi.fn().mockRejectedValue(new Error("NOAUTH Authentication required")),
      duplicate: vi.fn().mockReturnThis(),
    };
    const consumer = new StreamConsumer({
      redis: mockRedis as any,
      stream: "stream-1" as any,
      group: "g" as any,
      consumer: "c",
    });

    await expect(consumer.ensureGroup()).rejects.toThrow("NOAUTH");
  });
});

describe("StreamConsumer.ack", () => {
  it("acks a batch of ids in one call", async () => {
    const mockRedis = { xack: vi.fn().mockResolvedValue(2), duplicate: vi.fn().mockReturnThis() };
    const consumer = new StreamConsumer({
      redis: mockRedis as any,
      stream: "stream-1" as any,
      group: "g" as any,
      consumer: "c",
    });

    await consumer.ack(["1-0", "2-0"]);

    expect(mockRedis.xack).toHaveBeenCalledWith("stream-1", "g", "1-0", "2-0");
  });

  it("does not call redis for an empty id list", async () => {
    // XACK with no ids is a syntax error, so the guard has to hold.
    const mockRedis = { xack: vi.fn(), duplicate: vi.fn().mockReturnThis() };
    const consumer = new StreamConsumer({
      redis: mockRedis as any,
      stream: "stream-1" as any,
      group: "g" as any,
      consumer: "c",
    });

    await consumer.ack([]);

    expect(mockRedis.xack).not.toHaveBeenCalled();
  });
});

describe("StreamConsumer.nack", () => {
  /** A redis whose DLQ write succeeds unless `xadd` is overridden. */
  function dlqConsumer(over: Record<string, any> = {}, streams: any = "stream-1") {
    const mockRedis = {
      xadd: vi.fn().mockResolvedValue("9-0"),
      xack: vi.fn().mockResolvedValue(1),
      pipeline: vi.fn(),
      duplicate: vi.fn().mockReturnThis(),
      ...over,
    };
    const consumer = new StreamConsumer({
      redis: mockRedis as any,
      stream: streams,
      group: "g" as any,
      consumer: "c",
      dlqStream: "dlq" as any,
      logger: silentLogger() as any,
    });
    return { consumer, mockRedis };
  }

  it("writes the event to the DLQ, then acks it", async () => {
    const { consumer, mockRedis } = dlqConsumer({}, ["stream-1", "stream-2"]);

    await consumer.nack("5-0", validEvent() as any, "stream-2");

    expect(mockRedis.xadd).toHaveBeenCalledWith("dlq", "*", "data", expect.any(String));
    expect(mockRedis.xack).toHaveBeenCalledWith("stream-2", "g", "5-0");
    expect(mockRedis.xadd.mock.invocationCallOrder[0]!).toBeLessThan(
      mockRedis.xack.mock.invocationCallOrder[0]!,
    );
  });

  it("records where the message came from, so a replay knows the origin stream", async () => {
    const { consumer, mockRedis } = dlqConsumer();

    await consumer.nack("5-0", validEvent() as any);

    const written = JSON.parse(mockRedis.xadd.mock.calls[0]![3] as string);
    expect(written.dlq.originalStream).toBe("stream-1");
    expect(written.dlq.ackedAt).toEqual(expect.any(String));
    expect(written.id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("does not ack when the DLQ write fails, so the message is not lost", async () => {
    // Acking here would delete the only copy of a message that never reached
    // the dead-letter stream. Throwing leaves it pending for the recovery loop.
    const { consumer, mockRedis } = dlqConsumer({
      xadd: vi.fn().mockRejectedValue(new Error("OOM command not allowed")),
    });

    await expect(consumer.nack("5-0", validEvent() as any)).rejects.toThrow("OOM");
    expect(mockRedis.xack).not.toHaveBeenCalled();
  });

  it("does not ack when the DLQ write is refused without an error", async () => {
    // XADD answers null rather than throwing when the write did not happen.
    const { consumer, mockRedis } = dlqConsumer({ xadd: vi.fn().mockResolvedValue(null) });

    await expect(consumer.nack("5-0", validEvent() as any)).rejects.toThrow("dead-letter");
    expect(mockRedis.xack).not.toHaveBeenCalled();
  });

  it("falls back to a plain ack when no DLQ stream is configured", async () => {
    const mockRedis = {
      xack: vi.fn().mockResolvedValue(1),
      xadd: vi.fn(),
      pipeline: vi.fn(),
      duplicate: vi.fn().mockReturnThis(),
    };
    const consumer = new StreamConsumer({
      redis: mockRedis as any,
      stream: "stream-1" as any,
      group: "g" as any,
      consumer: "c",
    });

    await consumer.nack("5-0", validEvent() as any);

    expect(mockRedis.xadd).not.toHaveBeenCalled();
    expect(mockRedis.xack).toHaveBeenCalledWith("stream-1", "g", "5-0");
  });
});

describe("StreamConsumer.readBatch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Builds a consumer whose blocking reads come from `replies`, in order. */
  function consumerReading(replies: any[], logger = silentLogger()) {
    let call = 0;
    const xreadgroup = vi.fn(async () => replies[Math.min(call++, replies.length - 1)]);
    const mockRedis: any = {
      xreadgroup,
      xack: vi.fn().mockResolvedValue(1),
      duplicate: vi.fn(),
      quit: vi.fn().mockResolvedValue("OK"),
      disconnect: vi.fn(),
    };
    mockRedis.duplicate.mockReturnValue(mockRedis);

    const consumer = new StreamConsumer({
      redis: mockRedis,
      stream: "stream-1" as any,
      group: "g" as any,
      consumer: "c",
      logger: logger as any,
      blockMs: 10,
    });
    return { consumer, mockRedis, logger };
  }

  it("yields parsed messages tagged with the stream they came from", async () => {
    const { consumer } = consumerReading([reply("stream-1", "1-0", JSON.stringify(validEvent()))]);

    const gen = consumer.readBatch();
    const { value } = await gen.next();
    await gen.return(undefined);

    expect(value).toHaveLength(1);
    expect(value![0]!.id).toBe("1-0");
    expect(value![0]!.stream).toBe("stream-1");
    expect(value![0]!.event.type).toBe("notification.requested");
  });

  it("acks and drops an entry whose JSON does not parse, rather than wedging the group", async () => {
    const { consumer, mockRedis, logger } = consumerReading([
      reply("stream-1", "bad-0", "{not json"),
      reply("stream-1", "1-0", JSON.stringify(validEvent())),
    ]);

    const gen = consumer.readBatch();
    const { value } = await gen.next();
    await gen.return(undefined);

    expect(mockRedis.xack).toHaveBeenCalledWith("stream-1", "g", "bad-0");
    expect(logger.warn).toHaveBeenCalled();
    // Only the good entry is handed to the worker.
    expect(value).toHaveLength(1);
    expect(value![0]!.id).toBe("1-0");
  });

  it("acks and drops an entry that parses but fails the envelope schema", async () => {
    const { consumer, mockRedis } = consumerReading([
      reply("stream-1", "bad-0", JSON.stringify({ id: "not-a-uuid", type: "x" })),
      reply("stream-1", "1-0", JSON.stringify(validEvent())),
    ]);

    const gen = consumer.readBatch();
    await gen.next();
    await gen.return(undefined);

    expect(mockRedis.xack).toHaveBeenCalledWith("stream-1", "g", "bad-0");
  });

  it("acks and drops an entry with no data field", async () => {
    const { consumer, mockRedis } = consumerReading([
      [["stream-1", [["bad-0", ["other", "value"]]]]],
      reply("stream-1", "1-0", JSON.stringify(validEvent())),
    ]);

    const gen = consumer.readBatch();
    await gen.next();
    await gen.return(undefined);

    expect(mockRedis.xack).toHaveBeenCalledWith("stream-1", "g", "bad-0");
  });

  it("keeps waiting when a blocking read returns nothing", async () => {
    const { consumer } = consumerReading([
      null,
      reply("stream-1", "1-0", JSON.stringify(validEvent())),
    ]);

    const gen = consumer.readBatch();
    const { value } = await gen.next();
    await gen.return(undefined);

    expect(value).toHaveLength(1);
  });

  it("does not yield an empty batch when every entry in a read was dropped", async () => {
    const { consumer } = consumerReading([
      reply("stream-1", "bad-0", "{not json"),
      reply("stream-1", "1-0", JSON.stringify(validEvent())),
    ]);

    const gen = consumer.readBatch();
    const { value } = await gen.next();
    await gen.return(undefined);

    // The first read produced no usable message, so the generator looped
    // instead of handing the worker an empty array to process.
    expect(value!.length).toBeGreaterThan(0);
  });

  it("logs a read failure and retries after a backoff instead of exiting the loop", async () => {
    vi.useFakeTimers();
    const logger = silentLogger();
    let call = 0;
    const mockRedis: any = {
      xreadgroup: vi.fn(async () => {
        call++;
        if (call === 1) throw new Error("READONLY You can't write against a replica");
        return reply("stream-1", "1-0", JSON.stringify(validEvent()));
      }),
      xack: vi.fn(),
      duplicate: vi.fn(),
      quit: vi.fn().mockResolvedValue("OK"),
      disconnect: vi.fn(),
    };
    mockRedis.duplicate.mockReturnValue(mockRedis);

    const consumer = new StreamConsumer({
      redis: mockRedis,
      stream: "stream-1" as any,
      group: "g" as any,
      consumer: "c",
      logger: logger as any,
      blockMs: 10,
    });

    const gen = consumer.readBatch();
    const pending = gen.next();
    await vi.advanceTimersByTimeAsync(1_500);
    const { value } = await pending;
    await gen.return(undefined);

    expect(logger.error).toHaveBeenCalled();
    expect(value).toHaveLength(1);
    expect(mockRedis.xreadgroup).toHaveBeenCalledTimes(2);
  });

  it("drops the blocking connection when a read overruns its own block timeout", async () => {
    vi.useFakeTimers();
    const logger = silentLogger();
    let call = 0;
    const mockRedis: any = {
      xreadgroup: vi.fn(() => {
        call++;
        // The first read never settles, so only the dead-connection guard can
        // end the race; the second lets the generator reach a yield.
        if (call === 1) return new Promise(() => {});
        return Promise.resolve(reply("stream-1", "1-0", JSON.stringify(validEvent())));
      }),
      xack: vi.fn(),
      duplicate: vi.fn(),
      quit: vi.fn().mockResolvedValue("OK"),
      disconnect: vi.fn(),
    };
    mockRedis.duplicate.mockReturnValue(mockRedis);

    const consumer = new StreamConsumer({
      redis: mockRedis,
      stream: "stream-1" as any,
      group: "g" as any,
      consumer: "c",
      logger: logger as any,
      blockMs: 10,
    });

    const gen = consumer.readBatch();
    const pending = gen.next();
    // blockMs + 5s for the guard to fire, then the loop's own retry backoff.
    await vi.advanceTimersByTimeAsync(5_020);
    await vi.advanceTimersByTimeAsync(1_100);
    const { value } = await pending;
    await gen.return(undefined);

    expect(mockRedis.disconnect).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
    // The consumer recovered rather than falling out of the read loop.
    expect(value).toHaveLength(1);
  });
});

describe("PendingMessageScanner", () => {
  it("fetches pending messages across multiple streams", async () => {
    const mockRedis = {
      xpending: vi.fn().mockImplementation(async (stream) => {
        if (stream === "stream-1") {
          return [["123-0", "my-consumer", 5000, 1]];
        }
        if (stream === "stream-2") {
          return [["124-0", "my-consumer", 10000, 2]];
        }
        return [];
      }),
    };

    const scanner = new PendingMessageScanner({
      redis: mockRedis as any,
      stream: ["stream-1", "stream-2"] as any,
      group: "my-group" as any,
      consumer: "my-consumer",
    });

    const entries = await scanner.getPendingEntries(10);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.id).toBe("123-0");
    expect(entries[1]!.id).toBe("124-0");
  });

  it("calculates total pending count", async () => {
    const mockRedis = {
      xpending: vi.fn().mockImplementation(async (stream) => {
        if (stream === "stream-1") return [5];
        if (stream === "stream-2") return [10];
        return [];
      }),
    };

    const scanner = new PendingMessageScanner({
      redis: mockRedis as any,
      stream: ["stream-1", "stream-2"] as any,
      group: "my-group" as any,
      consumer: "my-consumer",
    });

    const count = await scanner.getPendingCount();
    expect(count).toBe(15);
  });

  it("caps the entries it returns at the requested limit", async () => {
    const mockRedis = {
      xpending: vi.fn().mockResolvedValue([
        ["1-0", "c", 5, 1],
        ["2-0", "c", 5, 1],
        ["3-0", "c", 5, 1],
      ]),
    };
    const scanner = new PendingMessageScanner({
      redis: mockRedis as any,
      stream: ["stream-1", "stream-2"] as any,
      group: "g" as any,
      consumer: "c",
    });

    const entries = await scanner.getPendingEntries(2);
    expect(entries).toHaveLength(2);
  });
});

describe("PendingMessageScanner.autoclaim", () => {
  /** XPENDING replies keyed by stream, plus a recording XCLAIM. */
  function scannerWith(
    pendingByStream: Record<string, any[]>,
    claimResult: any[] = [],
    streams: string[] = ["stream-1"],
  ) {
    const xclaim = vi.fn().mockResolvedValue(claimResult);
    const redis: any = {
      xpending: vi.fn(async (stream: string) => pendingByStream[stream] ?? []),
      xclaim,
    };
    const scanner = new PendingMessageScanner({
      redis,
      stream: streams as any,
      group: "g" as any,
      consumer: "me",
      logger: silentLogger() as any,
    });
    return { scanner, redis, xclaim };
  }

  it("claims an entry that has been idle past its backoff and returns it parsed", async () => {
    const raw = JSON.stringify(validEvent());
    const { scanner, xclaim } = scannerWith({ "stream-1": [["1-0", "dead-worker", 60_000, 1]] }, [
      ["1-0", ["data", raw]],
    ]);

    const recovered = await scanner.autoclaim(1_000, 10);

    expect(xclaim).toHaveBeenCalledTimes(1);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.id).toBe("1-0");
    expect(recovered[0]!.stream).toBe("stream-1");
    expect(recovered[0]!.event.type).toBe("notification.requested");
  });

  it("leaves an entry alone until its delivery-count backoff has elapsed", async () => {
    // 4th delivery ⇒ threshold is minIdle * 2^3 = 8s, and it has idled 5s.
    const { scanner, xclaim } = scannerWith({ "stream-1": [["1-0", "c", 5_000, 4]] });

    const recovered = await scanner.autoclaim(1_000, 10);

    expect(xclaim).not.toHaveBeenCalled();
    expect(recovered).toEqual([]);
  });

  it("claims that same entry once it has idled past the doubled window", async () => {
    const raw = JSON.stringify(validEvent());
    const { scanner, xclaim } = scannerWith({ "stream-1": [["1-0", "c", 9_000, 4]] }, [
      ["1-0", ["data", raw]],
    ]);

    const recovered = await scanner.autoclaim(1_000, 10);

    expect(xclaim).toHaveBeenCalledTimes(1);
    expect(recovered).toHaveLength(1);
  });

  it("returns nothing when no stream has a claimable entry", async () => {
    const { scanner, xclaim } = scannerWith({});

    await expect(scanner.autoclaim(1_000, 10)).resolves.toEqual([]);
    expect(xclaim).not.toHaveBeenCalled();
  });

  it("stops once it has recovered the requested number of messages", async () => {
    const raw = JSON.stringify(validEvent());
    const xclaim = vi.fn().mockResolvedValue([
      ["1-0", ["data", raw]],
      ["2-0", ["data", raw]],
    ]);
    const redis: any = {
      xpending: vi.fn(async () => [
        ["1-0", "c", 60_000, 1],
        ["2-0", "c", 60_000, 1],
        ["3-0", "c", 60_000, 1],
      ]),
      xclaim,
    };
    const scanner = new PendingMessageScanner({
      redis,
      stream: ["stream-1", "stream-2"] as any,
      group: "g" as any,
      consumer: "me",
      logger: silentLogger() as any,
    });

    await scanner.autoclaim(1_000, 2);

    // Two recovered on the first stream fills the budget, so the second is
    // never scanned.
    expect(xclaim).toHaveBeenCalledTimes(1);
    const claimedIds = xclaim.mock.calls[0]!.slice(4);
    expect(claimedIds).toEqual(["1-0", "2-0"]);
  });

  it("drops a claimed entry whose body no longer parses", async () => {
    const { scanner } = scannerWith({ "stream-1": [["1-0", "c", 60_000, 1]] }, [
      ["1-0", ["data", "{not json"]],
    ]);

    // The claim still happened — it just yields nothing to reprocess, rather
    // than crashing the scan.
    await expect(scanner.autoclaim(1_000, 10)).resolves.toEqual([]);
  });

  it("tolerates a null entry in the claim reply", async () => {
    const raw = JSON.stringify(validEvent());
    const { scanner } = scannerWith({ "stream-1": [["1-0", "c", 60_000, 1]] }, [
      null,
      ["1-0", ["data", raw]],
    ]);

    const recovered = await scanner.autoclaim(1_000, 10);
    expect(recovered).toHaveLength(1);
  });

  it("lets redis arbitrate the claim, so two scanners cannot both take an entry", async () => {
    // The idle threshold goes to XCLAIM rather than being applied only here:
    // whichever scanner claims first resets the entry's idle time, so the
    // loser's claim is refused rather than handing it the same message.
    const raw = JSON.stringify(validEvent());
    const { scanner, xclaim } = scannerWith({ "stream-1": [["1-0", "c", 60_000, 1]] }, [
      ["1-0", ["data", raw]],
    ]);

    await scanner.autoclaim(1_000, 10);

    const [stream, group, consumer, minIdle] = xclaim.mock.calls[0]!;
    expect(stream).toBe("stream-1");
    expect(group).toBe("g");
    expect(consumer).toBe("me");
    expect(minIdle).toBe(1_000);
  });

  it("recovers nothing when another scanner claimed the entry first", async () => {
    // Redis answers the losing claim with an empty reply.
    const { scanner } = scannerWith({ "stream-1": [["1-0", "c", 60_000, 1]] }, []);

    await expect(scanner.autoclaim(1_000, 10)).resolves.toEqual([]);
  });
});

describe("IdempotencyGuard", () => {
  it("allows execution if key is not seen", async () => {
    const mockRedis = {
      set: vi.fn().mockResolvedValue("OK"),
    };

    const guard = new IdempotencyGuard({ redis: mockRedis as any, keyPrefix: "test" });
    const result = await guard.checkAndMark("msg-123");

    expect(result).toBe(true);
  });

  it("blocks execution if key is already seen", async () => {
    const mockRedis = {
      set: vi.fn().mockResolvedValue(null), // Redis SET NX returns null if exists
    };

    const guard = new IdempotencyGuard({ redis: mockRedis as any, keyPrefix: "test" });
    const result = await guard.checkAndMark("msg-123");

    expect(result).toBe(false);
  });
});

describe("StreamProducer", () => {
  it("publishes a single event", async () => {
    const mockRedis = {
      xadd: vi.fn().mockResolvedValue("123-0"),
      xlen: vi.fn().mockResolvedValue(100),
    };
    const { StreamProducer } = await import("../src/queue/index.js");
    const producer = new StreamProducer({
      redis: mockRedis as any,
      stream: "my-stream" as any,
    });

    const msgId = await producer.publish({
      type: "notification.requested",
      payload: { test: true },
      metadata: { traceId: "t1" } as any,
    });

    expect(msgId).toBe("123-0");
    expect(mockRedis.xadd).toHaveBeenCalledWith(
      "my-stream",
      "MAXLEN",
      "~",
      "10000000",
      "*",
      "data",
      expect.any(String),
    );
  });

  it("publishes a batch of events via pipeline", async () => {
    const mockPipeline = {
      xadd: vi.fn(),
      exec: vi.fn().mockResolvedValue([
        [null, "123-0"],
        [null, "124-0"],
      ]),
    };
    const mockRedis = {
      pipeline: vi.fn().mockReturnValue(mockPipeline),
    };

    const { StreamProducer } = await import("../src/queue/index.js");
    const producer = new StreamProducer({
      redis: mockRedis as any,
      stream: "my-stream" as any,
    });

    const msgIds = await producer.publishBatch([
      { type: "notification.requested", payload: {}, metadata: { traceId: "1" } as any },
      { type: "notification.requested", payload: {}, metadata: { traceId: "2" } as any },
    ]);

    expect(msgIds.messageIds).toEqual(["123-0", "124-0"]);
    expect(msgIds.eventIds).toHaveLength(2);
    expect(mockPipeline.xadd).toHaveBeenCalledTimes(2);
    expect(mockPipeline.exec).toHaveBeenCalled();
  });
});
