import type { Redis } from "@/index.js";

export interface IdempotencyOptions {
  redis: Redis;
  keyPrefix: string;
  ttlSeconds?: number;
}

export type LeaseResult = "acquired" | "locked" | "completed";

/** One Redis key per id: `L` while a worker holds it, `1` once processed. */
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

  async acquireLease(id: string, lockTtlSeconds: number = 30): Promise<LeaseResult> {
    const key = this.key(id);
    if ((await this.redis.set(key, "L", "EX", lockTtlSeconds, "NX")) === "OK") return "acquired";

    const val = await this.redis.get(key);
    if (val === "1") return "completed";
    if (val === "L") return "locked";

    // The key expired between the SET and the GET.
    const retry = await this.redis.set(key, "L", "EX", lockTtlSeconds, "NX");
    return retry === "OK" ? "acquired" : "locked";
  }

  /** Marks the id processed. Returns false if it was already seen. */
  async checkAndMark(id: string, customTtlSeconds?: number): Promise<boolean> {
    const ttl = customTtlSeconds ?? this.ttlSeconds;
    const result = await this.redis.set(this.key(id), "1", "EX", ttl, "NX");
    return result === "OK";
  }

  /** Marks the id processed, replacing a lease with the full TTL. */
  async markProcessed(id: string, customTtlSeconds?: number): Promise<void> {
    const ttl = customTtlSeconds ?? this.ttlSeconds;
    await this.redis.set(this.key(id), "1", "EX", ttl);
  }

  async isProcessed(id: string): Promise<boolean> {
    const val = await this.redis.get(this.key(id));
    return val !== null && val !== undefined;
  }

  async unmark(id: string): Promise<void> {
    await this.redis.del(this.key(id));
  }
}
