import type { Redis } from "@/index.js";
import { LRUCache } from "@/shared/index.js";

import { randomUUID } from "crypto";

export interface ThrottleResult {
  allowed: boolean;
  count: number;
  limit: number;
}

// ─── Per-project overrides ──────────────────────────────────────────────────

/**
 * Throttle overrides stored on the project row. `null` on either field means
 * "no override" — fall back to the process-wide default.
 */
export interface ProjectThrottleSettings {
  throttleLimit: number | null;
  throttleWindowHours: number | null;
}

const NO_OVERRIDES: ProjectThrottleSettings = {
  throttleLimit: null,
  throttleWindowHours: null,
};

export interface ProjectSettingsCacheOptions {
  maxSize?: number;
  ttlMs?: number;
}

/**
 * Caches per-project throttle overrides for the engine.
 *
 * The throttle check runs once per notification, so an uncached lookup here
 * would put a Postgres round trip on the hot path. Projects with no overrides
 * are cached as well — the common case must not cost a query per message.
 *
 * The TTL bounds staleness on its own; `invalidate()` exists so a settings
 * change published over pub/sub applies immediately rather than at expiry.
 */
export class ProjectSettingsCache {
  private readonly cache: LRUCache<string, ProjectThrottleSettings>;
  /**
   * Lookups already on the wire, keyed by project.
   *
   * The cache only fills once a query has come back, so without this a cold
   * project at the start of a campaign puts one query per in-flight message on
   * Postgres before the first answer lands — exactly when the database is
   * busiest. Followers wait on the leader's promise instead.
   */
  private readonly inFlight = new Map<string, Promise<ProjectThrottleSettings>>();

  constructor(
    private readonly load: (projectId: string) => Promise<ProjectThrottleSettings | null>,
    { maxSize = 1000, ttlMs = 60_000 }: ProjectSettingsCacheOptions = {},
  ) {
    this.cache = new LRUCache<string, ProjectThrottleSettings>(maxSize, ttlMs);
  }

  /**
   * Throws whatever the loader throws. The caller decides whether a settings
   * lookup failure should drop the message or fall back to defaults.
   */
  async get(projectId: string): Promise<ProjectThrottleSettings> {
    const cached = this.cache.get(projectId);
    if (cached) return cached;

    const existing = this.inFlight.get(projectId);
    if (existing) return existing;

    // Assigned before any callback below can run, since `load` cannot settle
    // within this synchronous block.
    let pending!: Promise<ProjectThrottleSettings>;
    pending = this.load(projectId)
      .then((settings) => {
        const resolved = settings ?? NO_OVERRIDES;
        // Only cache while this is still the current lookup: an invalidate()
        // that landed while the query was on the wire means the answer in hand
        // already describes the old settings.
        if (this.inFlight.get(projectId) === pending) {
          this.cache.set(projectId, resolved);
        }
        return resolved;
      })
      .finally(() => {
        // Cleared on failure too, so one bad lookup does not pin every later
        // caller to the same rejection.
        if (this.inFlight.get(projectId) === pending) {
          this.inFlight.delete(projectId);
        }
      });

    this.inFlight.set(projectId, pending);
    return pending;
  }

  invalidate(projectId: string): void {
    this.cache.delete(projectId);
    // A lookup that started before the change would write a stale value on
    // arrival; dropping it here sends the next caller back to the database.
    this.inFlight.delete(projectId);
  }

  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }
}

// ─── UserThrottle ──────────────────────────────────────────────────────────
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
    const memberId = randomUUID();

    const LUA_THROTTLE = `
      redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
      local count = redis.call("ZCARD", KEYS[1])
      if tonumber(count) < tonumber(ARGV[2]) then
        redis.call("ZADD", KEYS[1], tonumber(ARGV[3]), ARGV[4])
        redis.call("EXPIRE", KEYS[1], tonumber(ARGV[5]))
        return tonumber(count) + 1
      end
      return tonumber(count) + 1
    `;

    // The key must outlive the window it is counting. For a future-dated send
    // that means surviving until targetTime plus one more window, so a task
    // scheduled for next week still counts against the right bucket.
    const windowSeconds = Math.ceil(windowMs / 1000);
    const ttlSeconds = Math.max(
      windowSeconds,
      Math.ceil((targetTime - Date.now()) / 1000) + windowSeconds,
    );

    const count = (await this.redis.eval(
      LUA_THROTTLE,
      1,
      key,
      windowStart,
      limit,
      targetTime,
      memberId,
      ttlSeconds,
    )) as number;

    return { allowed: count <= limit, count, limit };
  }
}
