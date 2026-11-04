import type { Logger } from "@/index.js";
import type { StreamConsumer, PendingMessageScanner, StreamMessage, StreamEvent } from "@/index.js";
import { globalEmitter, AsyncSemaphore } from "@/shared/index.js";
import { metrics } from "@/metrics/index.js";
export * from "./health.js";

export class NonRetryableError extends Error {
  readonly nonRetryable = true;
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

export class LockHeldError extends Error {
  readonly lockHeld = true;
  constructor(message: string = "Idempotency lock held — leaving message pending") {
    super(message);
    this.name = "LockHeldError";
  }
}

export type ProcessResult = void | { ack?: boolean };

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

export abstract class BaseWorker {
  protected readonly logger: Logger;

  private readonly consumer: StreamConsumer;
  private readonly pendingScanner: PendingMessageScanner;
  protected readonly concurrency: number;
  private readonly recoveryIntervalMs: number;
  private readonly maxRetriesBeforeDlq: number;

  private state: WorkerState = "idle";
  private stopping = false;
  private processedCount = 0;
  private errorCount = 0;
  private lastProcessedAt: string | null = null;
  private lastErrorAt: string | null = null;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private recovering = false;
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

  protected abstract process(message: StreamMessage, attempt?: number): Promise<ProcessResult>;

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
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.runLoop,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Worker stop timeout")), 30_000);
        }),
      ])
        .catch((err) => this.logger.warn({ err }, "Worker shutdown timeout or error"))
        .finally(() => clearTimeout(timer));
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

  /**
   * Processes an event produced by an upstream stage in this same process,
   * skipping the stream hop in between.
   *
   * The caller is still holding its own stream entry, and does not ack it until
   * this returns. A thrown error therefore leaves that entry pending and the
   * whole chain is replayed from the upstream stage; the idempotency keys each
   * stage already checks make the replay safe. Non-retryable failures go to the
   * dead-letter stream here, as they would have from this worker's own stream,
   * so they do not send the upstream message there instead.
   */
  async processInline(event: StreamEvent): Promise<void> {
    try {
      // `{ ack: false }` means another holder owns this message right now. Its
      // own stream entry is what gets retried if it fails, so there is nothing
      // for the caller to wait on.
      await this.process({ id: event.id, event, deliveryCount: 1, inline: true }, 1);
      this.processedCount += 1;
      this.lastProcessedAt = new Date().toISOString();
      metrics.messagesProcessed.inc({ worker: this.constructor.name, status: "success" });
    } catch (err) {
      if (err instanceof LockHeldError || (err as any)?.lockHeld) return;

      this.errorCount += 1;
      this.lastErrorAt = new Date().toISOString();
      metrics.messagesProcessed.inc({ worker: this.constructor.name, status: "error" });

      if (err instanceof NonRetryableError || (err as any)?.nonRetryable) {
        this.logger.warn(
          { err, eventId: event.id },
          "non-retryable error on inline message — moving to dead-letter queue",
        );
        await this.consumer.deadLetter(event, (err as Error).message);
        globalEmitter.emit("notification:failed", event.id, (err as Error).message, event.type);
        return;
      }
      throw err;
    }
  }

  private async processWithTracking(message: StreamMessage): Promise<void> {
    const start = Date.now();
    const stream = message.stream;
    const retryCount = message.deliveryCount ?? 1;

    try {
      if (retryCount > this.maxRetriesBeforeDlq) {
        this.logger.warn(
          { messageId: message.id, retryCount },
          "max retries exceeded, moving to dead-letter queue",
        );
        await this.consumer.nack(
          message.id,
          message.event,
          stream,
          `max retries exceeded (${retryCount - 1} attempts)`,
        );
        globalEmitter.emit(
          "notification:failed",
          message.event.id,
          "Poison pill: max retries exceeded",
          message.event.type,
        );
        return;
      }

      const result = await this.processHoldingLease(message, retryCount);
      if (result && (result as any).ack === false) {
        this.logger.debug(
          { messageId: message.id, eventType: message.event.type },
          "message skipped without ack — leaving pending in stream",
        );
        return;
      }

      await this.consumer.ack(message.id, stream);
      this.processedCount += 1;
      this.lastProcessedAt = new Date().toISOString();
      metrics.messagesProcessed.inc({ worker: this.constructor.name, status: "success" });

      this.logger.debug(
        { messageId: message.id, eventType: message.event.type, durationMs: Date.now() - start },
        "message processed",
      );
    } catch (err) {
      if (err instanceof LockHeldError || (err as any)?.lockHeld) {
        this.logger.debug(
          { err, messageId: message.id, eventType: message.event.type },
          "lock held by another worker — leaving message pending in stream",
        );
        return;
      }

      this.errorCount += 1;
      this.lastErrorAt = new Date().toISOString();
      metrics.messagesProcessed.inc({ worker: this.constructor.name, status: "error" });

      if (err instanceof NonRetryableError || (err as any)?.nonRetryable) {
        this.logger.warn(
          { err, messageId: message.id },
          "non-retryable error encountered, immediately moving to dead-letter queue without retry loop",
        );
        await this.consumer.nack(message.id, message.event, stream, (err as Error).message);
        globalEmitter.emit(
          "notification:failed",
          message.event.id,
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

  /**
   * Runs `process` while keeping the entry's idle time below the reclaim
   * threshold. Without this, a handler that outlasts `recoveryIntervalMs` (a
   * large segment fan-out) is reclaimed mid-run and started again elsewhere,
   * over and over, until it is dead-lettered while the first run still works.
   * If this process dies the touches stop, so the entry is reclaimed as before.
   */
  private async processHoldingLease(message: StreamMessage, attempt: number) {
    const stream = message.stream;
    const timer = stream
      ? setInterval(
          () => {
            this.pendingScanner.touch(message.id, stream).catch((err: unknown) => {
              this.logger.warn({ err, messageId: message.id }, "failed to extend message lease");
            });
          },
          Math.max(Math.floor(this.recoveryIntervalMs / 2), 10),
        )
      : undefined;
    try {
      return await this.process(message, attempt);
    } finally {
      clearInterval(timer);
    }
  }

  /**
   * `recoveryIntervalMs` is how long an entry must sit idle before it is
   * claimed, not how often to look. Scanning only once per interval, timed from
   * this worker's start, meant a worker restarted more often than that (a crash
   * loop, an eager autoscaler) never scanned at all, and whatever its
   * predecessors held stayed pending for good. So scan on start and then
   * several times per interval; the idle threshold alone decides what is taken.
   */
  private startRecoveryLoop(): void {
    const scan = () => {
      if (this.state !== "running" || this.recovering) return;
      this.recovering = true;
      this.recover()
        .catch((err: unknown) => {
          this.logger.error({ err }, "recovery loop error");
        })
        .finally(() => {
          this.recovering = false;
        });
    };
    scan();
    this.recoveryTimer = setInterval(scan, Math.max(Math.floor(this.recoveryIntervalMs / 4), 10));
  }

  private stopRecoveryLoop(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }
}
