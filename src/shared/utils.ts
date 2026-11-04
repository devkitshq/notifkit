export function getPriorityBucket(priority: string | undefined): "critical" | "normal" | "low" {
  const p = priority || "normal";
  return p === "critical" ? "critical" : p === "low" ? "low" : "normal";
}

/**
 * Canonical address for suppression lookups; writers and readers must both use
 * it. Emails are lower-cased; phone numbers and push tokens are case-sensitive.
 */
export function normaliseTarget(target: string): string {
  const trimmed = target.trim();
  return trimmed.includes("@") ? trimmed.toLowerCase() : trimmed;
}
