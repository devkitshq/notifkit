export class AsyncSemaphore {
  private count = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.count < this.max) {
      this.count++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      // Hand the permit straight over rather than decrementing and letting the
      // next acquire take it back — occupancy is unchanged either way.
      const next = this.queue.shift()!;
      next();
    } else if (this.count > 0) {
      this.count--;
    }
    // A release with nothing held is a caller bug, but silently going negative
    // turns it into over-admission later, which is far harder to trace back.
  }

  get activeCount(): number {
    return this.count;
  }
}
