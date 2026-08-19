import { describe, it, expect } from "vitest";
import { generateId, sleep, AppError, ValidationError } from "@/shared/index.js";

describe("Shared Utils", () => {
  it("generateId should return a string", () => {
    const id = generateId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("sleep should delay execution", async () => {
    const start = Date.now();
    await sleep(50);
    const end = Date.now();
    expect(end - start).toBeGreaterThanOrEqual(49);
  });

  it("AppError should set properties correctly", () => {
    const error = new AppError("Test error", "TEST_CODE");
    expect(error.message).toBe("Test error");
    expect(error.code).toBe("TEST_CODE");
    expect(error.name).toBe("AppError");
  });

  it("ValidationError should set properties correctly", () => {
    const fields = { email: ["Invalid format"] };
    const error = new ValidationError("Validation failed", fields);
    expect(error.message).toBe("Validation failed");
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.name).toBe("ValidationError");
    expect(error.fields).toEqual(fields);
  });
});

import { getPriorityBucket, normaliseTarget } from "@/shared/index.js";

describe("getPriorityBucket (Priority Classification)", () => {
  it("defaults undefined and empty string to 'normal'", () => {
    expect(getPriorityBucket(undefined)).toBe("normal");
    expect(getPriorityBucket("")).toBe("normal");
  });

  it("maps 'critical' and 'high' to 'critical'", () => {
    expect(getPriorityBucket("critical")).toBe("critical");
    expect(getPriorityBucket("high")).toBe("critical");
  });

  it("maps 'low' to 'low'", () => {
    expect(getPriorityBucket("low")).toBe("low");
  });

  it("maps unrecognized/custom priorities to 'normal'", () => {
    expect(getPriorityBucket("urgent")).toBe("normal");
    expect(getPriorityBucket("immediate")).toBe("normal");
    expect(getPriorityBucket("custom_bulk")).toBe("normal");
  });
});

describe("normaliseTarget (Address & Destination Normalization)", () => {
  it("lowercases email address and trims whitespace", () => {
    expect(normaliseTarget("  Alice.Smith+Tag@DOMAIN.COM \n")).toBe("alice.smith+tag@domain.com");
  });

  it("preserves case on push tokens and phone numbers while trimming whitespace", () => {
    expect(normaliseTarget("  ExponentPushToken[AbCdEf123]  ")).toBe(
      "ExponentPushToken[AbCdEf123]",
    );
    expect(normaliseTarget(" +1-800-555-0199 ")).toBe("+1-800-555-0199");
  });
});
