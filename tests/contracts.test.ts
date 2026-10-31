import { describe, it, expect } from "vitest";
import { registry, QuietHoursSchema } from "@/contracts/index.js";

describe("End-to-End Contract Registry Tests", () => {
  it("successfully parses a valid notification.requested payload", () => {
    const payload = {
      projectId: "33eb2225-c6f3-4e4b-91bb-000000000000",
      target: { type: "user", userId: "user-456" },
      templateId: "tmpl-789",
      channels: ["email"],
      data: { name: "Alice" },
      fallback: false,
    };

    const result = registry.safeParsePayload("notification.requested", payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(
        expect.objectContaining({
          target: { type: "user", userId: "user-456" },
        }),
      );
    }
  });

  it("fails to parse an invalid notification.requested payload (missing projectId)", () => {
    const payload = {
      target: { type: "user", userId: "user-456" },
      templateId: "tmpl-789",
    };

    const result = registry.safeParsePayload("notification.requested", payload);
    expect(result.success).toBe(false);
  });

  it("successfully parses a valid notification.enriched payload", () => {
    const payload = {
      projectId: "33eb2225-c6f3-4e4b-91bb-000000000000",
      rawEventId: "44eb2225-c6f3-4e4b-91bb-000000000000",
      recipientId: "user-456",
      channel: "email",
      priority: "normal",
      templateVariables: { name: "Alice" },
      recipient: {
        id: "cnt-1",
        email: "test@example.com",
        locale: "en",
        timezone: "UTC",
        preferences: { optedOut: false, channels: [] },
      },
    };

    const result = registry.safeParsePayload("notification.enriched", payload);
    expect(result.success).toBe(true);
  });

  it("does not call quiet hours UTC in the validation message", () => {
    const result = QuietHoursSchema.safeParse({ start: "25:00", end: "07:00" });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("expected HH:MM (24h, user's timezone)");
  });

  it("accepts a non-UUID templateId on delivery outcome events", () => {
    const base = {
      projectId: "33eb2225-c6f3-4e4b-91bb-000000000000",
      taskId: "task-1",
      enrichedEventId: "44eb2225-c6f3-4e4b-91bb-000000000000",
      channel: "email",
      templateId: "order-shipped",
    };

    const delivered = registry.safeParsePayload("notification.delivered", {
      ...base,
      deliveredAt: "2026-01-01T00:00:00.000Z",
    });
    const failed = registry.safeParsePayload("notification.failed", {
      ...base,
      failureReason: "boom",
      failureCode: "provider_error",
      retryable: false,
      attempt: 1,
    });

    expect(delivered.success).toBe(true);
    expect(failed.success).toBe(true);
  });
});
