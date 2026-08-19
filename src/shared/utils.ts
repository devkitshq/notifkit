export function getPriorityBucket(
  priority: string | undefined,
): "critical" | "high" | "normal" | "low" {
  const p = priority || "normal";
  return p === "critical" || p === "high" ? "critical" : p === "low" ? "low" : "normal";
}

/**
 * Canonical form of a destination, for suppression lookups.
 *
 * Both the writer (the provider webhook) and the reader (the engine's
 * pre-dispatch gate) must agree on this, or an unsubscribe recorded as
 * `Bob@Example.com` will not match a send addressed to `bob@example.com` and
 * the person keeps receiving mail. Case folding is safe for email domains and
 * for the local part in every mailbox provider in practice; phone numbers and
 * push tokens are case-sensitive and are only trimmed.
 */
export function normaliseTarget(target: string): string {
  const trimmed = target.trim();
  return trimmed.includes("@") ? trimmed.toLowerCase() : trimmed;
}

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

export const LUA_SCHEDULER_CLAIM = `
  local payloadKey = KEYS[1]
  local claimedKey = KEYS[2]
  
  if redis.call('EXISTS', payloadKey) == 1 then
    redis.call('RENAME', payloadKey, claimedKey)
    return redis.call('GET', claimedKey)
  elseif redis.call('EXISTS', claimedKey) == 1 then
    return redis.call('GET', claimedKey)
  else
    return nil
  end
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
