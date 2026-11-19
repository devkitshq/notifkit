import type { Redis } from "ioredis";
import { ApiRateLimiter } from "@/rate-limiter/index.js";

export interface ThrottleResult {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * Provider rate limit enforced through locally leased tokens.
 *
 * A per-message check against one sorted set per channel would serialise every
 * delivery process in the cluster on a single hot key. Instead each process
 * leases a chunk of the window's budget and spends it in memory, contacting
 * Redis only when its chunk runs low. The window is a sliding estimate over
 * two fixed buckets rather than an exact log, the same trade the API ingress
 * limiter already makes.
 */
export class ProviderThrottle {
  private readonly limiters = new Map<number, ApiRateLimiter>();

  constructor(
    private readonly redis: Redis,
    private readonly logger?: any,
  ) {}

  async check(
    channel: string,
    config: { limit: number; windowSeconds: number },
  ): Promise<ThrottleResult> {
    const windowMs = Math.max(1, Math.round(config.windowSeconds * 1000));
    let limiter = this.limiters.get(windowMs);
    if (!limiter) {
      limiter = new ApiRateLimiter({
        redis: this.redis,
        windowMs,
        keyPrefix: "rate-limit:provider",
        logger: this.logger,
      });
      this.limiters.set(windowMs, limiter);
    }

    if (await limiter.check(channel, config.limit)) {
      return { allowed: true, retryAfterMs: 0 };
    }

    const retryAfterMs = windowMs - (Date.now() % windowMs);
    // Debug, not warn: a big send lands here on every deferral of every task.
    this.logger?.debug(
      { channel, limit: config.limit, windowSeconds: config.windowSeconds, retryAfterMs },
      "Provider rate limit hit — task must be rescheduled",
    );
    return { allowed: false, retryAfterMs };
  }
}
