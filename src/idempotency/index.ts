import type { Redis } from "@/index.js";

export interface IdempotencyOptions {
  redis: Redis;
  keyPrefix: string;
  ttlSeconds?: number;
}

export type LeaseResult = "acquired" | "locked" | "completed";

/**
 * SET NX-based idempotency guard.
 * One key per id: `L` while leased, `1` once processed.
 */
export class IdempotencyGuard {
  private readonly redis: Redis;
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;

  constructor({ redis, keyPrefix, ttlSeconds = 86_400 }: IdempotencyOptions) {
    this.redis = redis;
    this.keyPrefix = keyPrefix;
    this.ttlSeconds = ttlSeconds;
  }

  private key(id: string): string {
    return `${this.keyPrefix}:${id}`;
  }

  /** @deprecated Nothing writes `:lock` keys any more; read only for markers from older versions. Remove in the next minor. */
  private lockKey(id: string): string {
    return `${this.keyPrefix}:${id}:lock`;
  }

  /** @deprecated Nothing writes `:sent` keys any more; read only for markers from older versions. Remove in the next minor. */
  private completedKey(id: string): string {
    return `${this.keyPrefix}:${id}:sent`;
  }

  /**
   * Leases the id with SET NX. One key per id: `L` while leased, `1` once processed.
   * Returns "completed" if already processed, "locked" if another worker holds the lease.
   */
  async acquireLease(id: string, lockTtlSeconds: number = 30): Promise<LeaseResult> {
    const mainKey = this.key(id);
    const lockKey = this.lockKey(id);

    // Fast path: attempt native atomic SET NX
    const acquired = await this.redis.set(mainKey, "L", "EX", lockTtlSeconds, "NX");
    if (acquired === "OK") {
      return "acquired";
    }

    // Key exists — check whether it's completed ("S" / "1" / :sent) or in-flight ("L" / :lock)
    const [val, sent, lockVal] = await Promise.all([
      this.redis.get(mainKey),
      this.redis.get(this.completedKey(id)),
      this.redis.get(lockKey),
    ]);

    if (val === "S" || val === "1" || sent !== null) {
      return "completed";
    }

    if (val === "L" || lockVal !== null) {
      return "locked";
    }

    // Key may have expired between initial SET NX and GETs; retry once
    const retryAcquired = await this.redis.set(mainKey, "L", "EX", lockTtlSeconds, "NX");
    if (retryAcquired === "OK") return "acquired";

    return "locked";
  }

  /** Atomically mark id as processed. Returns true on first call; false if already seen. */
  async checkAndMark(id: string, customTtlSeconds?: number): Promise<boolean> {
    const ttl = customTtlSeconds ?? this.ttlSeconds;
    const result = await this.redis.set(this.key(id), "1", "EX", ttl, "NX");
    return result === "OK";
  }

  /** Unconditionally mark id as processed (upgrades lock to completed "1" with full TTL). */
  async markProcessed(id: string, customTtlSeconds?: number): Promise<void> {
    const ttl = customTtlSeconds ?? this.ttlSeconds;
    await this.redis.set(this.key(id), "1", "EX", ttl);
  }

  async isProcessed(id: string): Promise<boolean> {
    const val = await this.redis.get(this.key(id));
    return val !== null && val !== undefined;
  }

  /** Remove the idempotency marker (useful in tests or manual rollbacks). */
  async unmark(id: string): Promise<void> {
    await Promise.all([
      this.redis.del(this.key(id)),
      this.redis.del(this.lockKey(id)),
      this.redis.del(this.completedKey(id)),
    ]);
  }
}
