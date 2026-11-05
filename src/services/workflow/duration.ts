/** Seconds per unit. Everything is read as seconds first, then scheduled in ms. */
const DURATION_UNIT_SECONDS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
};

/** `"500ms"`, `"1.5h"`, `"2.5d"` to seconds. Anything else throws. */
export function parseDurationSeconds(value: string, what: string): number {
  const match = /^(\d+(?:\.\d+)?|\.\d+)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid ${what}: ${value}`);
  return Number(match[1]) * DURATION_UNIT_SECONDS[match[2]!]!;
}

export function durationToMs(value: string, what: string): number {
  return Math.round(parseDurationSeconds(value, what) * 1000);
}
