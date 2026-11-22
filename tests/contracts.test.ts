import { describe, it, expect } from "vitest";
import {
  registry,
  QuietHoursSchema,
  AddUserSchema,
  UpdateUserSchema,
  BatchAddContactsSchema,
} from "@/contracts/index.js";

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

  it("rejects user timezones that are not IANA zones", () => {
    for (const timezone of ["America/NewYork", "IST", "not a zone"]) {
      expect(AddUserSchema.safeParse({ id: "u1", timezone }).success).toBe(false);
      expect(UpdateUserSchema.safeParse({ timezone }).success).toBe(false);
    }
    for (const timezone of ["America/New_York", "Asia/Kolkata", "UTC"]) {
      expect(AddUserSchema.safeParse({ id: "u1", timezone }).success).toBe(true);
      expect(UpdateUserSchema.safeParse({ timezone }).success).toBe(true);
    }
  });

  it("rejects email targets that are not one plain address", () => {
    // Suppressions match the stored target, and nodemailer delivers to every
    // address it can parse out of `to`, so a list or display name must not be stored.
    for (const target of ["Alice <a@example.com>", "a@example.com, b@example.com", "nope"]) {
      const contact = { channel: "email", target };
      expect(AddUserSchema.safeParse({ id: "u1", contacts: [contact] }).success).toBe(false);
      expect(UpdateUserSchema.safeParse({ email: target }).success).toBe(false);
      expect(BatchAddContactsSchema.safeParse(contact).success).toBe(false);
    }
    for (const target of ["a@example.com", "o'brien@example.com", "üser@exämple.com"]) {
      const contact = { channel: "email", target };
      expect(AddUserSchema.safeParse({ id: "u1", contacts: [contact] }).success).toBe(true);
      expect(UpdateUserSchema.safeParse({ email: [target] }).success).toBe(true);
      expect(BatchAddContactsSchema.safeParse([contact]).success).toBe(true);
    }
    // Other channels keep free-form targets.
    expect(
      BatchAddContactsSchema.safeParse({ channel: "sms", target: "+15550000001" }).success,
    ).toBe(true);
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

  it("accepts the teams channel with a Workflows webhook URL", () => {
    const requested = registry.safeParsePayload("notification.requested", {
      projectId: "33eb2225-c6f3-4e4b-91bb-000000000000",
      target: { type: "user", userId: "user-456" },
      templateId: "tmpl-789",
      channels: ["teams"],
      data: { name: "Alice" },
      fallback: false,
    });
    expect(requested.success).toBe(true);

    const enriched = registry.safeParsePayload("notification.enriched", {
      projectId: "33eb2225-c6f3-4e4b-91bb-000000000000",
      rawEventId: "44eb2225-c6f3-4e4b-91bb-000000000000",
      recipientId: "user-456",
      channel: "teams",
      priority: "normal",
      templateVariables: { name: "Alice" },
      recipient: {
        id: "cnt-1",
        teams: "https://prod-12.westus.logic.azure.com/workflows/abc",
        locale: "en",
        timezone: "UTC",
        preferences: { optedOut: false, channels: [] },
      },
    });
    expect(enriched.success).toBe(true);
  });
});
