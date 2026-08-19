import type { Redis } from "@/index.js";

export interface IdempotencyOptions {
  redis: Redis;
  keyPrefix: string;
  ttlSeconds?: number;
}

/**
 * SETNX-based idempotency guard.
 * Returns true from checkAndMark() only the first time a given ID is seen
 * within the TTL window; subsequent calls return false (duplicate / retry).
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

  /** Atomically mark id as processed. Returns true on first call; false if already seen. */
  async checkAndMark(id: string, customTtlSeconds?: number): Promise<boolean> {
    const ttl = customTtlSeconds ?? this.ttlSeconds;
    const result = await this.redis.set(this.key(id), "1", "EX", ttl, "NX");
    return result === "OK";
  }

  /** Unconditionally mark id as processed (e.g. to upgrade a short-lived lock). */
  async markProcessed(id: string, customTtlSeconds?: number): Promise<void> {
    const ttl = customTtlSeconds ?? this.ttlSeconds;
    await this.redis.set(this.key(id), "1", "EX", ttl);
  }

  async isProcessed(id: string): Promise<boolean> {
    return (await this.redis.get(this.key(id))) !== null;
  }

  /** Remove the idempotency marker (useful in tests or manual rollbacks). */
  async unmark(id: string): Promise<void> {
    await this.redis.del(this.key(id));
  }
}
