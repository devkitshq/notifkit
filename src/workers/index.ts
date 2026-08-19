import type { Logger } from "@/index.js";
import type { StreamConsumer, PendingMessageScanner, StreamMessage } from "@/index.js";
import { globalEmitter, AsyncSemaphore } from "@/shared/index.js";
import { metrics } from "@/metrics/index.js";
export * from "./health.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export class NonRetryableError extends Error {
  readonly nonRetryable = true;
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

export type WorkerState = "idle" | "running" | "stopping" | "stopped" | "error";

export interface WorkerHealth {
  state: WorkerState;
  processedCount: number;
  errorCount: number;
  lastProcessedAt: string | null;
  lastErrorAt: string | null;
  pendingCount: number | null;
}

export interface WorkerOptions {
  consumer: StreamConsumer;
  pendingScanner: PendingMessageScanner;
  logger: Logger;
  concurrency?: number;
  recoveryIntervalMs?: number;
  maxRetriesBeforeDlq?: number;
}

// ─── BaseWorker ────────────────────────────────────────────────────────────

export abstract class BaseWorker {
  protected readonly logger: Logger;

  private readonly consumer: StreamConsumer;
  private readonly pendingScanner: PendingMessageScanner;
  private readonly concurrency: number;
  private readonly recoveryIntervalMs: number;
  private readonly maxRetriesBeforeDlq: number;

  private state: WorkerState = "idle";
  private stopping = false;
  private processedCount = 0;
  private errorCount = 0;
  private lastProcessedAt: string | null = null;
  private lastErrorAt: string | null = null;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private lastPendingCount: number | null = null;
  private readonly active = new Set<Promise<void>>();
  private readonly semaphore: AsyncSemaphore;
  private runLoop?: Promise<void>;

  constructor({
    consumer,
    pendingScanner,
    logger,
    concurrency = 10,
    recoveryIntervalMs = 60_000,
    maxRetriesBeforeDlq = 3,
  }: WorkerOptions) {
    this.consumer = consumer;
    this.pendingScanner = pendingScanner;
    this.logger = logger.child({ component: this.constructor.name });
    this.concurrency = concurrency;
    this.recoveryIntervalMs = recoveryIntervalMs;
    this.maxRetriesBeforeDlq = maxRetriesBeforeDlq;
    this.semaphore = new AsyncSemaphore(concurrency);
  }

  protected abstract process(message: StreamMessage, attempt?: number): Promise<void>;

  async start(): Promise<void> {
    if (this.state !== "idle") {
      throw new Error(`Worker cannot start from state: ${this.state}`);
    }

    this.state = "running";
    this.logger.info({ concurrency: this.concurrency }, "worker starting");

    await this.consumer.ensureGroup();
    this.startRecoveryLoop();

    this.runLoop = this.consume();
  }

  private async consume(): Promise<void> {
    for await (const batch of this.consumer.readBatch()) {
      if (this.stopping) break;

      for (const message of batch) {
        if (this.stopping) break;

        await this.semaphore.acquire();

        const task = this.processWithTracking(message).finally(() => {
          this.active.delete(task);
          this.semaphore.release();
        });

        this.active.add(task);
      }
    }

    await Promise.allSettled([...this.active]);
    this.state = "stopped";
    this.logger.info("worker stopped");
  }

  async stop(): Promise<void> {
    if (this.stopping || this.state !== "running") return;

    this.logger.info("worker stopping");
    this.stopping = true;
    this.state = "stopping";
    await this.consumer.stop();
    this.stopRecoveryLoop();

    if (this.runLoop) {
      await Promise.race([
        this.runLoop,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Worker stop timeout")), 30_000),
        ),
      ]).catch((err) => this.logger.warn({ err }, "Worker shutdown timeout or error"));
    }

    this.logger.info("worker shutdown complete");
  }

  async recover(): Promise<void> {
    this.logger.debug("scanning for stale pending messages");

    const pendingCount = await this.pendingScanner.getPendingCount();
    this.lastPendingCount = pendingCount;
    if (pendingCount === 0) return;

    this.logger.info({ pendingCount }, "found pending messages, attempting autoclaim");

    const BATCH_SIZE = 1000;
    while (!this.stopping) {
      const messages = await this.pendingScanner.autoclaim(this.recoveryIntervalMs, BATCH_SIZE);
      if (messages.length === 0) {
        break; // No more eligible messages to claim
      }

      for (const message of messages) {
        if (this.stopping) break;

        await this.semaphore.acquire();

        const task = this.processWithTracking(message).finally(() => {
          this.active.delete(task);
          this.semaphore.release();
        });

        this.active.add(task);
      }
    }
  }

  health(): WorkerHealth {
    return {
      state: this.state,
      processedCount: this.processedCount,
      errorCount: this.errorCount,
      lastProcessedAt: this.lastProcessedAt,
      lastErrorAt: this.lastErrorAt,
      // Refreshed by the recovery loop; health() stays synchronous so the
      // reporter never blocks on Redis.
      pendingCount: this.lastPendingCount,
    };
  }

  private async processWithTracking(message: StreamMessage): Promise<void> {
    const start = Date.now();
    const stream = message.stream;
    const retryKey = `notif:worker:retries:${this.constructor.name}:${stream ?? "default"}:${message.id}`;

    try {
      const results = await this.consumer.redis
        .multi()
        .incr(retryKey)
        .expire(retryKey, 7200)
        .exec();
      const retryCount = (results?.[0]?.[1] as number) ?? 1;

      if (retryCount > this.maxRetriesBeforeDlq) {
        this.logger.warn(
          { messageId: message.id, retryCount },
          "max retries exceeded, moving to dead-letter queue",
        );
        await this.consumer.nack(message.id, message.event, stream);
        await this.consumer.redis.del(retryKey);
        globalEmitter.emit(
          "notification:failed",
          message.id,
          "Poison pill: max retries exceeded",
          message.event.type,
        );
        return;
      }

      await this.process(message, retryCount);

      await this.consumer.ack(message.id, stream);
      await this.consumer.redis.del(retryKey);
      this.processedCount += 1;
      this.lastProcessedAt = new Date().toISOString();
      metrics.messagesProcessed.inc({ worker: this.constructor.name, status: "success" });

      this.logger.debug(
        { messageId: message.id, eventType: message.event.type, durationMs: Date.now() - start },
        "message processed",
      );
    } catch (err) {
      this.errorCount += 1;
      this.lastErrorAt = new Date().toISOString();
      metrics.messagesProcessed.inc({ worker: this.constructor.name, status: "error" });

      if (err instanceof NonRetryableError || (err as any)?.nonRetryable) {
        this.logger.warn(
          { err, messageId: message.id },
          "non-retryable error encountered, immediately moving to dead-letter queue without retry loop",
        );
        await this.consumer.nack(message.id, message.event, stream);
        await this.consumer.redis.del(retryKey);
        globalEmitter.emit(
          "notification:failed",
          message.id,
          (err as Error).message,
          message.event.type,
        );
        return;
      }

      this.logger.error(
        { err, messageId: message.id, eventType: message.event.type },
        "failed to process message",
      );
    }
  }

  private startRecoveryLoop(): void {
    this.recoveryTimer = setInterval(() => {
      if (this.state === "running") {
        this.recover().catch((err: unknown) => {
          this.logger.error({ err }, "recovery loop error");
        });
      }
    }, this.recoveryIntervalMs);
  }

  private stopRecoveryLoop(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }
}
