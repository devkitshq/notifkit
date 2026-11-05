import { describe, it, expect } from "vitest";
import { baseConfigSchema, parseConfig } from "@/config/index.js";

describe("LOG_RETENTION_DAYS", () => {
  it("is unset by default, so no delivery logs are deleted", () => {
    expect(parseConfig(baseConfigSchema, {}).LOG_RETENTION_DAYS).toBeUndefined();
  });

  it("parses a day count when set", () => {
    expect(parseConfig(baseConfigSchema, { LOG_RETENTION_DAYS: "30" }).LOG_RETENTION_DAYS).toBe(30);
  });
});
