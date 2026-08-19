export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
}

type State = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitBreaker {
  private state: State = "CLOSED";
  private failures = 0;
  private nextAttemptAt = 0;
  /** True while one caller is testing whether the dependency has recovered. */
  private probeInFlight = false;
  private readonly threshold: number;
  private readonly timeout: number;

  constructor(options: CircuitBreakerOptions) {
    this.threshold = options.failureThreshold;
    this.timeout = options.resetTimeoutMs;
  }

  async execute<T>(action: () => Promise<T>): Promise<T> {
    // Only one caller gets to find out whether the dependency is back. Letting
    // the whole waiting crowd through on the first tick after the timeout is
    // how a struggling provider gets knocked over again the moment it recovers.
    let isProbe = false;

    if (this.state === "OPEN") {
      if (Date.now() > this.nextAttemptAt && !this.probeInFlight) {
        this.state = "HALF_OPEN";
        this.probeInFlight = true;
        isProbe = true;
      } else {
        throw new Error("Circuit breaker is OPEN");
      }
    } else if (this.state === "HALF_OPEN") {
      if (this.probeInFlight) {
        throw new Error("Circuit breaker is OPEN");
      }
      this.probeInFlight = true;
      isProbe = true;
    }

    try {
      const result = await action();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    } finally {
      if (isProbe) this.probeInFlight = false;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = "CLOSED";
  }

  private onFailure() {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.state = "OPEN";
      // Restart the clock so the next probe waits a full timeout rather than
      // firing immediately off the previous deadline.
      this.nextAttemptAt = Date.now() + this.timeout;
    }
  }

  getState(): State {
    return this.state;
  }
}
