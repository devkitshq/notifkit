export interface BatchItem<T, R> {
  item: T;
  resolve: (value: R) => void;
  reject: (reason?: any) => void;
}

/**
 * Batches `add()` calls into `flushFn` calls, at `maxSize` items or after
 * `maxWaitMs`. Several flushes may run at once so one slow flush doesn't cap
 * the worker's throughput.
 */
export class BatchProcessor<T, R = void> {
  private buffer: BatchItem<T, R>[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly maxSize: number,
    private readonly maxWaitMs: number,
    private readonly flushFn: (items: T[]) => Promise<R[]>,
    private readonly maxConcurrent: number = 1,
  ) {}

  add(item: T): Promise<R> {
    return new Promise((resolve, reject) => {
      this.buffer.push({ item, resolve, reject });
      if (this.buffer.length >= this.maxSize && this.inFlight.size < this.maxConcurrent) {
        this.clearTimer();
        void this.flushOnce();
      } else if (!this.timer && this.inFlight.size < this.maxConcurrent) {
        this.armTimer();
      }
    });
  }

  /** Flushes everything buffered, waiting for a free flush slot if needed. */
  async flush(): Promise<void> {
    while (this.buffer.length > 0) {
      while (this.inFlight.size >= this.maxConcurrent) {
        await Promise.race(this.inFlight);
      }
      this.clearTimer();
      await this.flushOnce();
    }
  }

  private flushOnce(): Promise<void> {
    if (this.buffer.length === 0 || this.inFlight.size >= this.maxConcurrent) {
      return Promise.resolve();
    }

    const batch = this.buffer;
    this.buffer = [];

    const run = (async () => {
      try {
        const results = await this.flushFn(batch.map((b) => b.item));
        for (let i = 0; i < batch.length; i++) {
          batch[i]!.resolve(results[i] as R);
        }
      } catch (err) {
        for (const b of batch) {
          b.reject(err);
        }
      }
    })();

    this.inFlight.add(run);
    return run.finally(() => {
      this.inFlight.delete(run);
      // Items that arrived while every slot was busy were not given a timer.
      if (this.buffer.length === 0 || this.timer) return;
      if (this.buffer.length >= this.maxSize) {
        void this.flushOnce();
      } else {
        this.armTimer();
      }
    });
  }

  private armTimer(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushOnce();
    }, this.maxWaitMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
