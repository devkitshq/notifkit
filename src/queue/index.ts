import type { Redis } from "@/index.js";
import type { Logger } from "@/index.js";
import {
  StreamEventSchema,
  type StreamEvent,
  type StreamName,
  type ConsumerGroup,
  readBaseConfig,
  STREAMS,
} from "@/index.js";
import { metrics } from "@/metrics/index.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface StreamMessage {
  id: string;
  event: StreamEvent;
  /** Stream this message was read from. Required to ack/claim against the right one. */
  stream?: string;
}

export interface PendingEntry {
  id: string;
  consumer: string;
  idleMs: number;
  deliveryCount: number;
  /** Stream this entry is pending on. Stream ids are not unique across streams. */
  stream: StreamName;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function parseMessage(id: string, fields: string[] | null, logger?: Logger): StreamMessage | null {
  if (!fields) return null;

  const dataIndex = fields.indexOf("data");
  if (dataIndex === -1) return null;

  const raw = fields[dataIndex + 1];
  if (!raw) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (err) {
    logger?.warn({ id, err }, "failed to parse stream event JSON");
    return null;
  }

  const parsed = StreamEventSchema.safeParse(decoded);
  if (!parsed.success) {
    logger?.warn({ id, error: parsed.error.issues }, "failed to parse stream event");
    return null;
  }

  return { id, event: parsed.data };
}

// ─── StreamProducer ────────────────────────────────────────────────────────

export interface StreamProducerOptions {
  redis: Redis;
  stream: StreamName;
  logger?: Logger;
  maxLen?: number;
}

export class StreamProducer {
  private readonly redis: Redis;
  private readonly stream: StreamName;
  private readonly logger?: Logger;
  private readonly maxLen: number;

  constructor({ redis, stream, logger, maxLen }: StreamProducerOptions) {
    this.redis = redis;
    this.stream = stream;
    this.logger = logger;
    this.maxLen = maxLen ?? readBaseConfig().QUEUE_MAX_LEN;
  }

  async publish(partial: Omit<StreamEvent, "id" | "timestamp">): Promise<string> {
    const event: StreamEvent = {
      ...partial,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };

    const messageId = await this.redis.xadd(
      this.stream,
      "MAXLEN",
      "~",
      String(this.maxLen),
      "*",
      "data",
      JSON.stringify(event),
    );

    if (!messageId) throw new Error(`XADD to ${this.stream} returned null`);

    this.logger?.debug(
      { stream: this.stream, messageId, eventType: event.type, eventId: event.id },
      "event published",
    );

    return messageId;
  }

  private async monitorMaxLen(stream: string) {
    if (Math.random() < 0.05) {
      // Check ~5% of the time to avoid overhead
      try {
        const len = await this.redis.xlen(stream);
        metrics.queueSize.set({ stream }, len);

        if (len > this.maxLen * 0.8) {
          this.logger?.warn(
            { stream, len, maxLen: this.maxLen },
            "stream is nearing MAXLEN limit (80%+)",
          );
        }

        const dlqLen = await this.redis.xlen(STREAMS.DEAD_LETTER);
        metrics.queueSize.set({ stream: STREAMS.DEAD_LETTER }, dlqLen);
      } catch (err) {
        this.logger?.debug({ err }, "failed to monitor stream length");
      }
    }
  }

  async publishBatch(
    partials: Omit<StreamEvent, "id" | "timestamp">[],
  ): Promise<{ messageIds: string[]; eventIds: string[] }> {
    if (partials.length === 0) return { messageIds: [], eventIds: [] };

    const pipeline = this.redis.pipeline();
    const timestamp = new Date().toISOString();

    const eventIds: string[] = [];

    for (const partial of partials) {
      const id = crypto.randomUUID();
      eventIds.push(id);
      const event: StreamEvent = {
        ...partial,
        id,
        timestamp,
      };

      pipeline.xadd(
        this.stream,
        "MAXLEN",
        "~",
        String(this.maxLen),
        "*",
        "data",
        JSON.stringify(event),
      );
    }

    const results = await pipeline.exec();
    if (!results) throw new Error(`Pipeline execution failed for ${this.stream}`);

    const messageIds: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (!result) throw new Error("Pipeline result is undefined");
      const [err, msgId] = result;
      if (err) throw err;
      messageIds.push(msgId as string);
    }

    this.logger?.debug({ stream: this.stream, count: partials.length }, "batch events published");

    this.monitorMaxLen(this.stream).catch(() => {});

    return { messageIds, eventIds };
  }
}

// ─── StreamConsumer ────────────────────────────────────────────────────────

export interface StreamConsumerOptions {
  redis: Redis;
  stream: StreamName | StreamName[];
  group: ConsumerGroup;
  consumer: string;
  dlqStream?: StreamName;
  logger?: Logger;
  batchSize?: number;
  blockMs?: number;
}

type XReadGroupResult = Array<[string, Array<[string, string[] | null]>]> | null;

export class StreamConsumer {
  readonly redis: Redis;
  private readonly blockingRedis: Redis;
  private readonly streams: StreamName[];
  private readonly group: ConsumerGroup;
  private readonly consumer: string;
  private readonly dlqStream?: StreamName;
  private readonly logger?: Logger;
  private readonly batchSize: number;
  private readonly blockMs: number;
  private running = false;

  constructor({
    redis,
    stream,
    group,
    consumer,
    dlqStream,
    logger,
    batchSize = 10,
    blockMs = 5_000,
  }: StreamConsumerOptions) {
    this.redis = redis;
    this.blockingRedis = redis.duplicate();
    this.streams = Array.isArray(stream) ? stream : [stream];
    this.group = group;
    this.consumer = consumer;
    this.dlqStream = dlqStream;
    this.logger = logger;
    this.batchSize = batchSize;
    this.blockMs = blockMs;
  }

  async ensureGroup(): Promise<void> {
    for (const s of this.streams) {
      try {
        // Start from the beginning so events published before the first worker
        // comes online are not silently skipped. Retention is controlled by the
        // producer's MAXLEN policy rather than consumer-group creation time.
        await this.redis.xgroup("CREATE", s, this.group, "0", "MKSTREAM");
        this.logger?.info({ stream: s, group: this.group }, "consumer group created");
      } catch (err) {
        if (err instanceof Error && err.message.includes("BUSYGROUP")) {
          this.logger?.debug({ stream: s, group: this.group }, "consumer group already exists");
          continue;
        }
        throw err;
      }
    }
  }

  async *readBatch(): AsyncGenerator<StreamMessage[], void, unknown> {
    this.running = true;
    let retryDelay = 1000;

    while (this.running) {
      try {
        let currentStreams = [...this.streams];
        // Weighted fair queuing: 10% of the time, rotate the priority order
        // to prevent starvation of low priority queues.
        if (currentStreams.length > 1 && Math.random() < 0.1) {
          const offset = Math.floor(Math.random() * (currentStreams.length - 1)) + 1;
          for (let i = 0; i < offset; i++) {
            currentStreams.push(currentStreams.shift()!);
          }
        }

        let results;
        let deadConnectionTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          results = (await Promise.race([
            this.blockingRedis.xreadgroup(
              "GROUP",
              this.group,
              this.consumer,
              "COUNT",
              String(this.batchSize),
              "BLOCK",
              String(this.blockMs),
              "STREAMS",
              ...currentStreams,
              ...currentStreams.map(() => ">"),
            ),
            new Promise((_, reject) => {
              deadConnectionTimer = setTimeout(
                () => reject(new Error("XREADGROUP_TIMEOUT_DEAD_CONNECTION")),
                this.blockMs + 5000,
              );
            }),
          ])) as XReadGroupResult;
        } catch (err: any) {
          if (err.message === "XREADGROUP_TIMEOUT_DEAD_CONNECTION") {
            this.logger?.warn(
              "XREADGROUP took too long, assuming dead connection. Disconnecting...",
            );
            this.blockingRedis.disconnect();
            throw err;
          }
          throw err;
        } finally {
          // Whichever side of the race loses stays pending, so the guard timer
          // outlives the read it was guarding. Normally the loop turns over once
          // per `blockMs` and only a couple accumulate — but whenever the read
          // returns straight away, one timer per iteration piles up unbounded.
          clearTimeout(deadConnectionTimer);
        }

        retryDelay = 1000; // reset on success

        if (!results) continue;

        const batch: StreamMessage[] = [];
        for (const [streamName, messages] of results) {
          for (const [id, fields] of messages) {
            const msg = parseMessage(id, fields, this.logger);
            if (!msg) {
              await this.redis.xack(streamName, this.group, id);
              continue;
            }
            // Attach original stream name for dynamic acking
            msg.stream = streamName as StreamName;
            batch.push(msg);
          }
        }
        if (batch.length > 0) yield batch;
      } catch (err) {
        if (
          !this.running &&
          err instanceof Error &&
          err?.message?.toLowerCase?.().includes("connection is closed")
        ) {
          break; // Expected during graceful shutdown
        }
        this.logger?.error({ err }, "error reading from stream");
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 2, 30_000); // Exponential backoff up to 30s
      }
    }
  }

  async ack(messageId: string | string[], stream?: string): Promise<void> {
    const s = stream ?? this.streams[0]!;
    const ids = Array.isArray(messageId) ? messageId : [messageId];
    if (ids.length === 0) return;
    await this.redis.xack(s, this.group, ...ids);
    this.logger?.debug({ stream: s, count: ids.length }, "messages acknowledged");
  }

  async nack(messageId: string, event: StreamEvent, stream?: string): Promise<void> {
    const s = stream ?? this.streams[0]!;
    if (this.dlqStream) {
      // Sequential rather than pipelined, and in this order: the ack is what
      // makes the drop final, so it must never run against a DLQ write that
      // did not land. A pipeline is not a transaction — both commands execute
      // regardless — so inspecting its results afterwards would be too late.
      // Throwing here leaves the message pending for the recovery loop, which
      // is the recoverable end of the trade.
      const dlqId = await this.redis.xadd(
        this.dlqStream,
        "*",
        "data",
        JSON.stringify({
          ...event,
          dlq: { originalStream: s, ackedAt: new Date().toISOString() },
        }),
      );

      if (!dlqId) {
        throw new Error(`XADD to dead-letter stream ${this.dlqStream} returned null`);
      }

      await this.redis.xack(s, this.group, messageId);
      this.logger?.warn(
        { stream: s, dlqStream: this.dlqStream, messageId, eventId: event.id, dlqId },
        "message moved to dead-letter queue and acked",
      );
    } else {
      await this.ack(messageId, s);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    try {
      await this.blockingRedis.quit();
    } catch (err: any) {
      if (!err?.message?.toLowerCase?.().includes("connection is closed")) {
        throw err;
      }
    }
  }
}

// ─── PendingMessageScanner ─────────────────────────────────────────────────

export interface PendingMessageScannerOptions {
  redis: Redis;
  stream: StreamName | StreamName[];
  group: ConsumerGroup;
  consumer: string;
  logger?: Logger;
}

export class PendingMessageScanner {
  private readonly redis: Redis;
  private readonly streams: StreamName[];
  private readonly group: ConsumerGroup;
  private readonly consumer: string;
  private readonly logger?: Logger;

  constructor({ redis, stream, group, consumer, logger }: PendingMessageScannerOptions) {
    this.redis = redis;
    this.streams = Array.isArray(stream) ? stream : [stream];
    this.group = group;
    this.consumer = consumer;
    this.logger = logger;
  }

  async getPendingCount(): Promise<number> {
    let total = 0;
    for (const s of this.streams) {
      const summary = await this.redis.xpending(s, this.group);
      if (Array.isArray(summary) && summary.length > 0) {
        const count = summary[0];
        if (typeof count === "number") total += count;
      }
    }
    return total;
  }

  /** Pending entries for one stream, or across all of them when `stream` is omitted. */
  async getPendingEntries(limit = 100, stream?: StreamName): Promise<PendingEntry[]> {
    const streams = stream ? [stream] : this.streams;
    const allEntries: PendingEntry[] = [];

    for (const s of streams) {
      const result = await this.redis.xpending(s, this.group, "-", "+", limit);
      if (Array.isArray(result)) {
        for (const item of result) {
          if (Array.isArray(item)) {
            allEntries.push({
              id: item[0],
              consumer: item[1],
              idleMs: item[2],
              deliveryCount: item[3],
              stream: s,
            });
          }
        }
      }
      if (allEntries.length >= limit) break;
    }
    return allEntries.slice(0, limit);
  }

  async autoclaim(minIdleMs: number, limit = 10): Promise<StreamMessage[]> {
    const recovered: StreamMessage[] = [];

    for (const s of this.streams) {
      if (recovered.length >= limit) break;

      // Scope the scan to THIS stream. Message ids are `<ms>-<seq>` and are not
      // unique across streams, so claiming an id gathered from another stream
      // can silently claim an unrelated message.
      const pending = await this.getPendingEntries(limit * 2, s);
      const toClaim = pending
        .filter((p) => p.idleMs > minIdleMs * Math.pow(2, p.deliveryCount - 1))
        .slice(0, limit - recovered.length);

      if (toClaim.length === 0) continue;

      const ids = toClaim.map((p) => p.id);
      // Let Redis arbitrate rather than claiming unconditionally. Two scanners
      // routinely list the same entry, and with a min-idle of 0 both claims
      // succeed and the message is processed twice; with the threshold applied
      // server-side the loser sees an entry whose idle time the winner has just
      // reset, and gets nothing back. The filter above is stricter than this,
      // so nothing it selected is excluded here for being too fresh.
      const result = (await this.redis.xclaim(
        s,
        this.group,
        this.consumer,
        minIdleMs,
        ...ids,
      )) as Array<[string, string[] | null]>;

      for (const raw of result) {
        if (!raw) continue;
        const [id, fields] = raw;
        const msg = parseMessage(id, fields, this.logger);
        if (msg) {
          msg.stream = s;
          recovered.push(msg);
        }
      }
    }

    if (recovered.length > 0) {
      this.logger?.info(
        { group: this.group, count: recovered.length },
        "autoclaimed pending messages",
      );
    }

    return recovered;
  }
}
