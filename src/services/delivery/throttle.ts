import type { Redis } from "ioredis";

export interface ThrottleResult {
  allowed: boolean;
  retryAfterMs: number;
}

const LUA_THROTTLE = `
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

export async function throttleProvider(
  redis: Redis,
  channel: string,
  config: { limit: number; windowSeconds: number },
  logger: any,
): Promise<ThrottleResult> {
  const key = `rate-limit:provider:${channel}`;
  const now = Date.now();
  const zmember = `${now}:${Math.random()}`;

  const result = (await redis.eval(
    LUA_THROTTLE,
    1,
    key,
    now.toString(),
    config.windowSeconds.toString(),
    config.limit.toString(),
    zmember,
  )) as [number, number];

  const allowed = result[0] === 1;
  const oldestTimestamp = result[1];

  let retryAfterMs = 0;
  if (!allowed) {
    retryAfterMs = Math.max(0, oldestTimestamp + config.windowSeconds * 1000 - now);
    logger.warn(
      { channel, limit: config.limit, windowSeconds: config.windowSeconds, retryAfterMs },
      "Provider rate limit hit — task must be rescheduled",
    );
  }

  return { allowed, retryAfterMs };
}
