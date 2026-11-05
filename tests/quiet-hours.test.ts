import { describe, it, expect, vi } from "vitest";
import { isInQuietHours } from "@/services/engine/main.js";

describe("isInQuietHours (Timezone-Aware Quiet Hours Calculation)", () => {
  it("returns inQuietHours: false when quietHours array is empty or undefined", () => {
    expect(isInQuietHours("UTC", [])).toEqual({ inQuietHours: false });
    expect(isInQuietHours("UTC", undefined as any)).toEqual({ inQuietHours: false });
  });

  it("returns inQuietHours: false gracefully when timezone is invalid", () => {
    const check = isInQuietHours("Invalid/Timezone_Name", [{ start: "22:00", end: "06:00" }]);
    expect(check).toEqual({ inQuietHours: false });
  });

  it("handles daytime quiet hours within same day (e.g. 13:00 - 15:00)", () => {
    const quietHours = [{ start: "13:00", end: "15:00" }];
    const inside = new Date("2026-08-17T14:00:00Z");
    const result = isInQuietHours("UTC", quietHours, inside);

    expect(result.inQuietHours).toBe(true);
    expect(result.nextActiveTime).toEqual(new Date("2026-08-17T15:00:00Z"));

    const outside = new Date("2026-08-17T16:00:00Z");
    expect(isInQuietHours("UTC", quietHours, outside)).toEqual({ inQuietHours: false });
  });

  it("handles midnight-crossing quiet hours (e.g. 22:00 - 06:00) before midnight", () => {
    const quietHours = [{ start: "22:00", end: "06:00" }];
    const beforeMidnight = new Date("2026-08-17T23:30:00Z");
    const result = isInQuietHours("UTC", quietHours, beforeMidnight);

    expect(result.inQuietHours).toBe(true);
    expect(result.nextActiveTime).toEqual(new Date("2026-08-18T06:00:00Z"));
  });

  it("handles midnight-crossing quiet hours (e.g. 22:00 - 06:00) after midnight", () => {
    const quietHours = [{ start: "22:00", end: "06:00" }];
    const afterMidnight = new Date("2026-08-18T04:15:00Z");
    const result = isInQuietHours("UTC", quietHours, afterMidnight);

    expect(result.inQuietHours).toBe(true);
    expect(result.nextActiveTime).toEqual(new Date("2026-08-18T06:00:00Z"));
  });

  it("handles chained quiet hours intervals (e.g. 22:00-06:00 followed by 06:00-08:00)", () => {
    const quietHours = [
      { start: "22:00", end: "06:00" },
      { start: "06:00", end: "08:00" },
    ];
    const atNight = new Date("2026-08-17T23:00:00Z");
    const result = isInQuietHours("UTC", quietHours, atNight);

    expect(result.inQuietHours).toBe(true);
    expect(result.nextActiveTime).toEqual(new Date("2026-08-18T08:00:00Z"));
  });

  it("never returns a release time in the past during a DST fall-back repeated hour", () => {
    // 2026-11-01 New York repeats 01:00-02:00. 06:10Z is the second 01:10
    // (EST); the window still runs until the second 01:30, i.e. 06:30Z.
    const now = new Date("2026-11-01T06:10:00Z");
    const result = isInQuietHours("America/New_York", [{ start: "01:00", end: "01:30" }], now);

    expect(result.inQuietHours).toBe(true);
    expect(result.nextActiveTime).toEqual(new Date("2026-11-01T06:30:00Z"));
  });
});

describe("isInQuietHours (Quiet Hours Deferral)", () => {
  it("returns false if no quiet hours configured", () => {
    const result = isInQuietHours("UTC", []);
    expect(result.inQuietHours).toBe(false);
  });

  it("correctly identifies if time falls within quiet hours and calculates next active time", () => {
    vi.useFakeTimers();
    // 2026-07-29T04:00:00Z is Midnight (00:00) EDT in America/New_York
    vi.setSystemTime(new Date("2026-07-29T04:00:00Z"));

    const tz = "America/New_York";
    const result = isInQuietHours(tz, [{ start: "22:00", end: "08:00" }]);

    expect(result.inQuietHours).toBe(true);
    // 08:00 EDT is 12:00:00Z
    expect(result.nextActiveTime).toEqual(new Date("2026-07-29T12:00:00.000Z"));

    vi.useRealTimers();
  });

  it("handles multiple quiet hours intervals in recipient preferences", () => {
    vi.useFakeTimers();
    // 13:30 UTC
    vi.setSystemTime(new Date("2026-07-29T13:30:00Z"));

    const windows = [
      { start: "13:00", end: "14:00" }, // afternoon quiet period
      { start: "22:00", end: "08:00" }, // night quiet period
    ];

    const result = isInQuietHours("UTC", windows);
    expect(result.inQuietHours).toBe(true);
    expect(result.nextActiveTime).toEqual(new Date("2026-07-29T14:00:00.000Z"));

    vi.useRealTimers();
  });

  it("evaluates exact boundary transitions correctly (21:59 vs 22:00 vs 08:00)", () => {
    vi.useFakeTimers();
    const tz = "UTC";
    const windows = [{ start: "22:00", end: "08:00" }];

    // 21:59:59 -> outside quiet hours
    vi.setSystemTime(new Date("2026-07-29T21:59:59Z"));
    expect(isInQuietHours(tz, windows).inQuietHours).toBe(false);

    // 22:00:00 -> inside quiet hours
    vi.setSystemTime(new Date("2026-07-29T22:00:00Z"));
    expect(isInQuietHours(tz, windows).inQuietHours).toBe(true);

    // 08:00:00 -> outside quiet hours
    vi.setSystemTime(new Date("2026-07-29T08:00:00Z"));
    expect(isInQuietHours(tz, windows).inQuietHours).toBe(false);

    vi.useRealTimers();
  });

  it("chains overlapping and consecutive quiet hours windows to find the final active boundary", () => {
    vi.useFakeTimers();
    // 13:15 UTC
    vi.setSystemTime(new Date("2026-07-29T13:15:00Z"));

    const windows = [
      { start: "13:00", end: "14:00" },
      { start: "13:30", end: "15:30" }, // overlaps and extends window
    ];

    const result = isInQuietHours("UTC", windows);
    expect(result.inQuietHours).toBe(true);
    expect(result.nextActiveTime).toEqual(new Date("2026-07-29T15:30:00.000Z"));

    vi.useRealTimers();
  });

  it("accurately computes next active time across overnight DST transition in America/New_York", () => {
    vi.useFakeTimers();
    // 2026-11-01T03:00:00Z is 23:00 EDT on the night clocks fall back in America/New_York
    vi.setSystemTime(new Date("2026-11-01T03:00:00Z"));

    const tz = "America/New_York";
    const windows = [{ start: "22:00", end: "08:00" }];

    const result = isInQuietHours(tz, windows);
    expect(result.inQuietHours).toBe(true);
    // 08:00 EST (standard time, UTC-5) is 13:00:00Z
    expect(result.nextActiveTime).toEqual(new Date("2026-11-01T13:00:00.000Z"));

    vi.useRealTimers();
  });
});
