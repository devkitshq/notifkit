import { Redis, type RedisOptions } from "ioredis";
import type { Logger } from "@/index.js";

declare module "ioredis" {
  interface Redis {
    leaseApiRateLimit(
      currentKey: string,
      prevKey: string,
      now: number | string,
      window: number | string,
      maxReqs: number | string,
      requested: number | string,
      ttl?: number | string,
    ): Promise<number>;
    releaseLock(lockKey: string, lockToken: string): Promise<number>;
    countRequest(key: string, ttlSeconds: number | string): Promise<number>;
    renewLock(lockKey: string, lockToken: string, ttlSeconds: number | string): Promise<number>;
    throttleUser(
      key: string,
      windowStart: number | string,
      limit: number | string,
      targetTime: number | string,
      memberId: string,
      ttlSeconds: number | string,
      pruneBefore?: number | string,
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
 * Sliding-window token leasing for high-throughput API rate limiting.
 * Atomically checks available capacity and reserves up to N tokens in one round trip.
 */
export const LUA_LEASE_API_RATE_LIMIT = `
  local currentKey = KEYS[1]
  local prevKey = KEYS[2]
  local now = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])
  local maxReqs = tonumber(ARGV[3])
  local requested = tonumber(ARGV[4]) or 1
  local ttl = tonumber(ARGV[5]) or (math.ceil((window * 2) / 1000) + 60)

  if not now or not window or window <= 0 then
    return -1
  end
  if not maxReqs or maxReqs <= 0 then
    return 0
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
  local available = maxReqs - estimated

  if available <= 0 then
    return 0
  end

  local toGrant = math.min(requested, available)
  local newCount = redis.call("INCRBY", currentKey, toGrant)
  if newCount == toGrant then
    redis.call("EXPIRE", currentKey, ttl)
  end

  return toGrant
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

/**
 * User-level sliding window notification throttle.
 *
 * Members are sends scored by when they go out, which for a scheduled send is
 * in the future. A send at targetTime is checked against the window ending at
 * it, (windowStart, targetTime], so sends scheduled later do not count against
 * it. Pruning uses pruneBefore (now minus one window), never windowStart: a
 * check for a far-future send must not delete sends that went out today.
 *
 * A member already present was counted by an earlier attempt at the same
 * message (a replay after a crash), so it is allowed again without counting
 * twice. Returns 0 in that case, otherwise the would-be count.
 *
 * ARGV: windowStart, limit, targetTime, member, ttlSeconds, pruneBefore
 */
export const LUA_USER_THROTTLE = `
  local limit = tonumber(ARGV[2])
  local targetTime = tonumber(ARGV[3])
  local ttl = tonumber(ARGV[5])
  redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[6] or ARGV[1])
  if redis.call("ZSCORE", KEYS[1], ARGV[4]) then
    return 0
  end
  local count = redis.call("ZCOUNT", KEYS[1], "(" .. ARGV[1], targetTime)
  if count < limit then
    redis.call("ZADD", KEYS[1], targetTime, ARGV[4])
    -- Only ever extend: a send today must not cut short the life of a key
    -- that is still holding a send scheduled for next week.
    if redis.call("TTL", KEYS[1]) < ttl then
      redis.call("EXPIRE", KEYS[1], ttl)
    end
  end
  return count + 1
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
 * Fixed-window request counter: INCR, and an expiry whenever the key has none.
 * One script so the two cannot come apart. With INCR and EXPIRE sent
 * separately, a failure between them left a counter with no expiry, and the
 * address it counted stayed over its limit for good.
 */
export const LUA_COUNT_REQUEST = `
  local count = redis.call('INCR', KEYS[1])
  if redis.call('TTL', KEYS[1]) < 0 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
  return count
`;

/** Two-phase idempotency lease acquisition. Checks sent/legacy, then attempts SET NX lock. */
export const LUA_ACQUIRE_LEASE = `
  if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[3]) == 1 then
    return 'completed'
  end
  local lockAcquired = redis.call('SET', KEYS[2], '1', 'EX', ARGV[1], 'NX')
  if lockAcquired then
    return 'acquired'
  end
  if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[3]) == 1 then
    return 'completed'
  end
  return 'locked'
`;

/** Two-phase idempotency completion marker. Atomically sets completed + legacy and deletes lock. */
export const LUA_MARK_PROCESSED = `
  redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])
  redis.call('SET', KEYS[2], '1', 'EX', ARGV[1])
  redis.call('DEL', KEYS[3])
  return 1
`;

/**
 * Registers pre-compiled custom commands on an ioredis instance.
 * Calls defineCommand so ioredis uses EVALSHA rather than re-transmitting
 * full script strings over the wire.
 */
export function registerCustomCommands(redis: Redis): void {
  redis.defineCommand("leaseApiRateLimit", {
    numberOfKeys: 2,
    lua: LUA_LEASE_API_RATE_LIMIT,
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

  redis.defineCommand("acquireLease", {
    numberOfKeys: 3,
    lua: LUA_ACQUIRE_LEASE,
  });

  redis.defineCommand("countRequest", {
    numberOfKeys: 1,
    lua: LUA_COUNT_REQUEST,
  });

  redis.defineCommand("markProcessed", {
    numberOfKeys: 3,
    lua: LUA_MARK_PROCESSED,
  });
}

export interface RedisClientOptions {
  url: string;
  name?: string;
  logger?: Logger;
  redisOptions?: Partial<RedisOptions>;
}

const sharedClients = new Map<string, { client: RedisClient; refs: number }>();

export class RedisClient {
  readonly native: Redis;

  /**
   * One command connection per Redis URL for every service in this process.
   *
   * Each service used to open its own, so a single notification's commands
   * reached Redis over three or four sockets, one round trip each. Sharing a
   * connection lets auto-pipelining merge whatever the services issue in the
   * same tick into one write, and Redis spends most of its time per round trip
   * rather than per command. Blocking reads and subscribers still duplicate
   * their own connections.
   *
   * The handle's `disconnect()` releases this caller's reference; the
   * connection closes when the last service lets go.
   */
  static shared(options: RedisClientOptions): RedisClient {
    let entry = sharedClients.get(options.url);
    if (!entry) {
      entry = { client: new RedisClient({ ...options, name: "notifkit" }), refs: 0 };
      sharedClients.set(options.url, entry);
    }
    entry.refs++;

    const owner = entry;
    let released = false;
    const handle = Object.create(owner.client) as RedisClient;
    handle.disconnect = async () => {
      if (released) return;
      released = true;
      owner.refs--;
      if (owner.refs === 0) {
        if (sharedClients.get(options.url) === owner) sharedClients.delete(options.url);
        await owner.client.disconnect();
      }
    };
    return handle;
  }

  private readonly logger?: Logger;
  private isClosing = false;

  constructor({ url, name = "notifkit", logger, redisOptions }: RedisClientOptions) {
    this.logger = logger;

    this.native = new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
      connectionName: name,
      // Every worker keeps hundreds of commands in flight (idempotency SETs,
      // throttle scripts, acks). Coalescing the ones issued in the same tick
      // into one write cuts syscalls and Redis read events by an order of
      // magnitude under load. Blocking and subscriber connections opt out
      // when they duplicate this client.
      enableAutoPipelining: true,
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
