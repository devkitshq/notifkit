import type { Redis } from "@/index.js";
import { randomUUID } from "crypto";

export interface ThrottleResult {
  allowed: boolean;
  count: number;
  limit: number;
}

// True sliding window counter using Redis ZSET: max N sends per window per user.

export interface UserThrottleOptions {
  redis: Redis;
  maxPerHour?: number;
  windowHours?: number;
}

export interface ThrottleCheckOptions {
  /** Per-project cap for this window. `0` blocks every non-critical send. */
  limit?: number | null;
  /** Per-project window length in hours. */
  windowHours?: number | null;
  /** Future send time. The window is evaluated at that instant, not at now. */
  scheduledAt?: string;
  /**
   * Stable id of the message being counted. A retry of the same message is
   * then counted once, not once per attempt. Random when omitted.
   */
  messageId?: string;
}

/** Reject stored values that would make the window meaningless. */
function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** A limit of 0 is a legitimate kill switch, so zero is allowed here. */
function nonNegativeOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export class UserThrottle {
  private readonly redis: Redis;
  private readonly maxPerHour: number;
  private readonly windowHours: number;

  constructor({ redis, maxPerHour = 3, windowHours = 1 }: UserThrottleOptions) {
    this.redis = redis;
    this.maxPerHour = maxPerHour;
    this.windowHours = windowHours;
  }

  /**
   * @param projectId Tenant that owns `userId`. User ids are caller-supplied
   *   external ids, so they collide across tenants and MUST be namespaced —
   *   otherwise one tenant's traffic throttles another's.
   * @param options Per-project overrides. Values that are absent, null, or
   *   nonsensical fall back to this instance's defaults.
   */
  async check(
    projectId: string,
    userId: string,
    priority?: string,
    options: ThrottleCheckOptions = {},
  ): Promise<ThrottleResult> {
    const limit = nonNegativeOrNull(options.limit) ?? this.maxPerHour;
    const windowHours = positiveOrNull(options.windowHours) ?? this.windowHours;

    if (priority === "critical") {
      return { allowed: true, count: 0, limit };
    }

    const windowMs = windowHours * 3600_000;
    const key = `throttle:${projectId}:user:${userId}`;
    const targetTime = options.scheduledAt ? new Date(options.scheduledAt).getTime() : Date.now();
    const windowStart = targetTime - windowMs;
    const memberId = options.messageId ?? randomUUID();

    // The key must outlive the window it is counting. For a future-dated send
    // that means surviving until targetTime plus one more window, so a task
    // scheduled for next week still counts against the right bucket.
    const windowSeconds = Math.ceil(windowMs / 1000);
    const ttlSeconds = Math.max(
      windowSeconds,
      Math.ceil((targetTime - Date.now()) / 1000) + windowSeconds,
    );

    const count = await this.redis.throttleUser(
      key,
      windowStart,
      limit,
      targetTime,
      memberId,
      ttlSeconds,
      Date.now() - windowMs,
    );

    return { allowed: count <= limit, count, limit };
  }
}
