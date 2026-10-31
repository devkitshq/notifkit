import type { Redis } from "@/index.js";
import type { Logger } from "@/logger/index.js";

// Leases token chunks from Redis sliding-window counters into local memory.
// Eliminates per-request Redis network roundtrips on API ingress.

export interface ApiRateLimiterOptions {
  redis: Redis;
  windowMs?: number;
  maxBatchSize?: number;
  logger?: Logger;
  /** Redis key namespace. Distinct limiters must not share one. */
  keyPrefix?: string;
}

/**
 * Computes dynamic token lease batch size based on RPM.
 * Targets ~5s of limit capacity so Redis is contacted at most ~12 times/min
 * regardless of instantaneous request rate. Bounded between 1 and maxBatchSize.
 */
export function calculateTokenBatchSize(limitRpm: number, maxBatchSize = 500): number {
  if (limitRpm <= 0) return 0;
  if (limitRpm <= 10) return 1;
  if (limitRpm <= 60) return 5;
  const perSecond = limitRpm / 60;
  // 5 s window = perSecond * 5; at least 10 to absorb jitter.
  return Math.min(Math.max(Math.ceil(perSecond * 5), 10), maxBatchSize);
}

interface ProjectTokenLeaseState {
  bucketIndex: number;
  tokens: number;
  batchSize: number;
  inFlightLease: Promise<number> | null;
}

export class ApiRateLimiter {
  private readonly redis: Redis;
  private readonly windowMs: number;
  private readonly maxBatchSize: number;
  private readonly logger?: Logger;
  private readonly keyPrefix: string;
  private readonly leases = new Map<string, ProjectTokenLeaseState>();

  constructor({
    redis,
    windowMs = 60_000,
    maxBatchSize = 500,
    logger,
    keyPrefix = "rate-limit:api:req",
  }: ApiRateLimiterOptions) {
    this.redis = redis;
    this.windowMs = windowMs;
    this.maxBatchSize = maxBatchSize;
    this.logger = logger;
    this.keyPrefix = keyPrefix;
  }

  /**
   * Evaluates if a request for `projectId` is allowed within its `limitRpm`.
   * Fast-path uses local in-memory token lease (0ms Redis network latency).
   * Refills in the background before tokens are depleted.
   */
  async check(projectId: string, limitRpm: number): Promise<boolean> {
    if (limitRpm <= 0) return false;

    const nowMs = Date.now();
    const currentBucket = Math.floor(nowMs / this.windowMs);

    let state = this.leases.get(projectId);
    if (!state) {
      state = {
        bucketIndex: currentBucket,
        tokens: 0,
        batchSize: calculateTokenBatchSize(limitRpm, this.maxBatchSize),
        inFlightLease: null,
      };
      this.leases.set(projectId, state);
      this.maybePrune(currentBucket);
    }

    // Rollover to new bucket window when minute boundary elapses.
    // Kick off a prefill immediately so the first request of the new window
    // doesn't have to wait — it will land before tokens hit 0 again.
    if (state.bucketIndex !== currentBucket) {
      state.bucketIndex = currentBucket;
      state.tokens = 0;
      state.batchSize = calculateTokenBatchSize(limitRpm, this.maxBatchSize);
      state.inFlightLease = null;
      // Fire the first lease for the new window now, don't await it here.
      this.refill(projectId, state, limitRpm, nowMs, currentBucket).catch(() => {});
    }

    // 1. Fast Path: Local token available in memory (0ms network latency)
    if (state.tokens > 0) {
      state.tokens--;

      // Background refill when tokens drop below 25% of batch size
      const refillThreshold = Math.max(1, Math.floor(state.batchSize * 0.25));
      if (state.tokens <= refillThreshold && !state.inFlightLease) {
        this.refill(projectId, state, limitRpm, nowMs, currentBucket).catch(() => {});
      }

      return true;
    }

    // 2. Slow Path: tokens are depleted, block on the in-flight lease or start one.
    // Concurrent requests racing here all join the *same* promise so one Redis
    // round trip serves them. A lease only grants `batchSize` tokens, so a
    // burst larger than that leases again rather than rejecting requests the
    // window still has room for: a request is refused only once Redis itself
    // reports the window spent.
    for (;;) {
      if (!state.inFlightLease) {
        this.refill(projectId, state, limitRpm, nowMs, currentBucket).catch(() => {});
      }
      const granted = state.inFlightLease ? await state.inFlightLease : 0;

      // Only claim a token if the lease came back for the same bucket we waited on.
      if (state.bucketIndex !== currentBucket) return false;
      if (state.tokens > 0) {
        state.tokens--;
        return true;
      }
      if (granted <= 0) return false;
    }
  }

  private async refill(
    projectId: string,
    state: ProjectTokenLeaseState,
    limitRpm: number,
    nowMs: number,
    bucketIndex: number,
  ): Promise<number> {
    if (state.inFlightLease) {
      return state.inFlightLease;
    }

    const prevBucket = bucketIndex - 1;
    const rlTag = `{${this.keyPrefix}:${projectId || "global"}}`;
    const currentKey = `${rlTag}:${bucketIndex}`;
    const prevKey = `${rlTag}:${prevBucket}`;
    const requested = state.batchSize;
    let inFlightRef: Promise<number> | null = null;
    const executeLease = async (): Promise<number> => {
      try {
        let granted = await this.redis.leaseApiRateLimit(
          currentKey,
          prevKey,
          nowMs,
          this.windowMs,
          limitRpm,
          requested,
        );

        // On invalid return or negative, fail-open
        if (typeof granted !== "number" || granted < 0) {
          granted = requested;
        }

        if (state.bucketIndex === bucketIndex) {
          state.tokens += granted;
        }
        return granted;
      } catch (err) {
        this.logger?.warn(
          { err, projectId },
          "project rate limit lease failed — allowing request (fail-open)",
        );
        // Fail-open: credit requested tokens locally to prevent tight retry loops during Redis hiccups
        if (state.bucketIndex === bucketIndex) {
          state.tokens += requested;
        }
        return requested;
      } finally {
        if (state.inFlightLease === inFlightRef) {
          state.inFlightLease = null;
        }
      }
    };

    const promise = executeLease();
    inFlightRef = promise;
    state.inFlightLease = promise;
    return promise;
  }

  private maybePrune(currentBucket: number): void {
    if (this.leases.size > 2000) {
      for (const [id, s] of this.leases) {
        if (currentBucket - s.bucketIndex > 1) {
          this.leases.delete(id);
        }
      }
    }
  }

  /** Reset all local cached leases */
  clear(): void {
    this.leases.clear();
  }

  /** Invalidate local lease for a specific project */
  invalidate(projectId: string): void {
    this.leases.delete(projectId);
  }
}
