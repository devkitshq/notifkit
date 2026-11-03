import { describe, it, expect } from "vitest";
import { baseConfigSchema, parseConfig } from "@/config/index.js";

describe("RATE_LIMIT_PER_HOUR", () => {
  it("defaults to 100", () => {
    expect(parseConfig(baseConfigSchema, {}).RATE_LIMIT_PER_HOUR).toBe(100);
  });

  it("refuses a value that is not a number instead of throttling every send", () => {
    expect(() => parseConfig(baseConfigSchema, { RATE_LIMIT_PER_HOUR: "1OO" })).toThrow();
  });
});
