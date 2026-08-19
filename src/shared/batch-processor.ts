export interface BatchItem<T, R> {
  item: T;
  resolve: (value: R) => void;
  reject: (reason?: any) => void;
}

export class BatchProcessor<T, R = void> {
  private buffer: BatchItem<T, R>[] = [];
  private timer: NodeJS.Timeout | null = null;
  private isFlushing = false;

  constructor(
    private readonly maxSize: number,
    private readonly maxWaitMs: number,
    private readonly flushFn: (items: T[]) => Promise<R[]>,
  ) {}

  add(item: T): Promise<R> {
    return new Promise((resolve, reject) => {
      this.buffer.push({ item, resolve, reject });
      if (this.buffer.length >= this.maxSize && !this.isFlushing) {
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        void this.flush();
      } else if (!this.timer && !this.isFlushing) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.flush();
        }, this.maxWaitMs);
      }
    });
  }

  async flush(): Promise<void> {
    if (this.isFlushing || this.buffer.length === 0) return;

    this.isFlushing = true;
    const batch = this.buffer;
    this.buffer = [];

    try {
      const items = batch.map((b) => b.item);
      const results = await this.flushFn(items);
      for (let i = 0; i < batch.length; i++) {
        batch[i]!.resolve(results[i] as R);
      }
    } catch (err) {
      for (const b of batch) {
        b.reject(err);
      }
    } finally {
      this.isFlushing = false;
      if (this.buffer.length > 0 && !this.timer) {
        if (this.buffer.length >= this.maxSize) {
          void this.flush();
        } else {
          this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
          }, this.maxWaitMs);
        }
      }
    }
  }
}
