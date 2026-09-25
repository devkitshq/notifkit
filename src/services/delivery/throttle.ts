import type { Redis } from "ioredis";
import { LUA_THROTTLE_PROVIDER as LUA_THROTTLE } from "@/redis/index.js";

export { LUA_THROTTLE };

export interface ThrottleResult {
  allowed: boolean;
  retryAfterMs: number;
}

export async function throttleProvider(
  redis: Redis,
  channel: string,
  config: { limit: number; windowSeconds: number },
  logger: any,
): Promise<ThrottleResult> {
  const key = `rate-limit:provider:${channel}`;
  const now = Date.now();
  const zmember = `${now}:${Math.random()}`;

  const result =
    typeof redis.throttleProvider === "function"
      ? await redis.throttleProvider(
          key,
          now.toString(),
          config.windowSeconds.toString(),
          config.limit.toString(),
          zmember,
        )
      : ((await redis.eval(
          LUA_THROTTLE,
          1,
          key,
          now.toString(),
          config.windowSeconds.toString(),
          config.limit.toString(),
          zmember,
        )) as [number, number]);

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
