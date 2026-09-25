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

export { LUA_SCHEDULER_POLL } from "@/redis/index.js";

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
export { LUA_RELEASE_LOCK, LUA_RENEW_LOCK } from "@/redis/index.js";
