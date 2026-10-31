/** Seconds per unit. Everything is read as seconds first, then scheduled in ms. */
const DURATION_UNIT_SECONDS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
};

/**
 * `"500ms"`, `"0.5s"`, `"15m"`, `"1.5h"`, `"2.5d"` to seconds. Decimals are
 * read exactly; anything that is not a number and a unit throws. The old
 * parser matched on the last character, so "500ms" meant 500 seconds, and ran
 * parseInt, so "1.5h" meant one hour.
 */
export function parseDurationSeconds(value: string, what: string): number {
  const match = /^(\d+(?:\.\d+)?|\.\d+)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid ${what}: ${value}`);
  return Number(match[1]) * DURATION_UNIT_SECONDS[match[2]!]!;
}

export function durationToMs(value: string, what: string): number {
  return Math.round(parseDurationSeconds(value, what) * 1000);
}
