import { Redis, type RedisOptions } from "ioredis";
import type { Logger } from "@/index.js";

declare module "ioredis" {
  interface Redis {
    checkApiRateLimit(
      currentKey: string,
      prevKey: string,
      now: number | string,
      window: number | string,
      maxReqs: number | string,
      ttl?: number | string,
    ): Promise<number>;
    checkApiRateLimit1Key(
      baseKey: string,
      now: number | string,
      window: number | string,
      maxReqs: number | string,
      ttl?: number | string,
    ): Promise<number>;
    throttleProvider(
      key: string,
      now: number | string,
      windowSeconds: number | string,
      limit: number | string,
      member: string,
    ): Promise<[number, number]>;
    releaseLock(lockKey: string, lockToken: string): Promise<number>;
    renewLock(lockKey: string, lockToken: string, ttlSeconds: number | string): Promise<number>;
    throttleUser(
      key: string,
      windowStart: number | string,
      limit: number | string,
      targetTime: number | string,
      memberId: string,
      ttlSeconds: number | string,
    ): Promise<number>;
    schedulerPoll(
      key: string,
      maxScore: number | string,
      limit: number | string,
      visibilityTimeout: number | string,
    ): Promise<string[]>;
  }

  interface ChainableCommander {
    schedulerPoll(
      key: string,
      maxScore: number | string,
      limit: number | string,
      visibilityTimeout: number | string,
    ): this;
  }
}

/**
 * Sliding-window counter approximation for API rate limiting.
 */
export const LUA_CHECK_API_RATE_LIMIT = `
  local currentKey = KEYS[1]
  local prevKey = KEYS[2]
  local now = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])
  local maxReqs = tonumber(ARGV[3])
  local ttl = tonumber(ARGV[4]) or (math.ceil((window * 2) / 1000) + 60)

  if not now or not window or window <= 0 then
    return -1
  end
  if not maxReqs or maxReqs <= 0 then
    return -1
  end

  if not prevKey then
    local currentBucket = math.floor(now / window)
    local prevBucket = currentBucket - 1
    currentKey = KEYS[1] .. ":" .. currentBucket
    prevKey = KEYS[1] .. ":" .. prevBucket
  end

  local currentCount = tonumber(redis.call("GET", currentKey) or "0")
  local prevCount = tonumber(redis.call("GET", prevKey) or "0")

  local timeIntoCurrent = now % window
  local weight = (window - timeIntoCurrent) / window
  local estimated = math.floor(prevCount * weight + currentCount)

  if estimated < maxReqs then
    local newCount = redis.call("INCR", currentKey)
    if newCount == 1 then
      redis.call("EXPIRE", currentKey, ttl)
    end
    return estimated + 1
  end

  return -1
`;

/**
 * Sliding-window rate limiter for external provider dispatch.
 */
export const LUA_THROTTLE_PROVIDER = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local windowSeconds = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])
  local member = ARGV[4]

  local clearBefore = now - (windowSeconds * 1000)
  
  -- Cleanup expired scores
  redis.call('ZREMRANGEBYSCORE', key, 0, clearBefore)
  
  -- Get current count
  local count = redis.call('ZCARD', key)
  
  if count >= limit then
    -- Find the oldest score
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    if oldest and oldest[2] then
      return {0, tonumber(oldest[2])}
    end
    return {0, now}
  end
  
  -- Add new request
  redis.call('ZADD', key, now, member)
  redis.call('EXPIRE', key, windowSeconds * 2)
  return {1, 0}
`;

/** Release a lock only if we still hold it (value matches our token). */
export const LUA_RELEASE_LOCK = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

/** Extend a lock's TTL only if we still hold it. */
export const LUA_RENEW_LOCK = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('EXPIRE', KEYS[1], ARGV[2])
  end
  return 0
`;

/** User-level sliding window notification throttle. */
export const LUA_USER_THROTTLE = `
  redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
  local count = redis.call("ZCARD", KEYS[1])
  if tonumber(count) < tonumber(ARGV[2]) then
    redis.call("ZADD", KEYS[1], tonumber(ARGV[3]), ARGV[4])
    redis.call("EXPIRE", KEYS[1], tonumber(ARGV[5]))
    return tonumber(count) + 1
  end
  return tonumber(count) + 1
`;

/** Polls scheduler zsets with visibility timeouts. */
export const LUA_SCHEDULER_POLL = `
  local key = KEYS[1]
  local maxScore = tonumber(ARGV[1])
  local limit = tonumber(ARGV[2])
  local visibilityTimeout = tonumber(ARGV[3]) or 0
  local tasks = redis.call('ZRANGE', key, 0, maxScore, 'BYSCORE', 'LIMIT', 0, limit)
  if #tasks > 0 then
    for i, task in ipairs(tasks) do
      redis.call('ZADD', key, maxScore + visibilityTimeout, task)
    end
  end
  return tasks
`;

/**
 * Registers pre-compiled custom commands on an ioredis instance.
 * Calls defineCommand so ioredis uses EVALSHA rather than re-transmitting
 * full script strings over the wire.
 */
export function registerCustomCommands(redis: Redis): void {
  redis.defineCommand("checkApiRateLimit", {
    numberOfKeys: 2,
    lua: LUA_CHECK_API_RATE_LIMIT,
  });

  redis.defineCommand("checkApiRateLimit1Key", {
    numberOfKeys: 1,
    lua: LUA_CHECK_API_RATE_LIMIT,
  });

  redis.defineCommand("throttleProvider", {
    numberOfKeys: 1,
    lua: LUA_THROTTLE_PROVIDER,
  });

  redis.defineCommand("releaseLock", {
    numberOfKeys: 1,
    lua: LUA_RELEASE_LOCK,
  });

  redis.defineCommand("renewLock", {
    numberOfKeys: 1,
    lua: LUA_RENEW_LOCK,
  });

  redis.defineCommand("throttleUser", {
    numberOfKeys: 1,
    lua: LUA_USER_THROTTLE,
  });

  redis.defineCommand("schedulerPoll", {
    numberOfKeys: 1,
    lua: LUA_SCHEDULER_POLL,
  });
}

export interface RedisClientOptions {
  url: string;
  name?: string;
  logger?: Logger;
  redisOptions?: Partial<RedisOptions>;
}

export class RedisClient {
  readonly native: Redis;

  private readonly logger?: Logger;
  private isClosing = false;

  constructor({ url, name = "notifkit", logger, redisOptions }: RedisClientOptions) {
    this.logger = logger;

    this.native = new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
      connectionName: name,
      ...redisOptions,
    });

    registerCustomCommands(this.native);

    this.native.on("connect", () => {
      this.logger?.info({ url: redactUrl(url) }, "redis connected");
    });

    this.native.on("ready", () => {
      this.logger?.debug("redis ready");
    });

    this.native.on("error", (err: Error) => {
      this.logger?.error({ err }, "redis client error");
    });

    this.native.on("close", () => {
      if (!this.isClosing) {
        this.logger?.warn("redis connection closed unexpectedly");
      }
    });

    this.native.on("reconnecting", () => {
      this.logger?.warn("redis reconnecting");
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const pong = await this.native.ping();
      return pong === "PONG";
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.isClosing) return;
    this.isClosing = true;
    this.logger?.info("disconnecting redis");
    try {
      if (this.native.status !== "end" && this.native.status !== "close") {
        await this.native.quit();
      }
    } catch {
      try {
        this.native.disconnect();
      } catch {
        // ignore errors on forced disconnect
      }
    }
    this.logger?.info("redis disconnected");
  }
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "[invalid-url]";
  }
}

export { Redis, type RedisOptions };
