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
    expect(BatchAddContactsSchema.safeParse({ channel: "slack", target: "C0123" }).success).toBe(
      true,
    );
    expect(
      BatchAddContactsSchema.safeParse({
        channel: "teams",
        target: "https://prod-00.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke",
      }).success,
    ).toBe(true);
    expect(
      registry.safeParsePayload("notification.requested", {
        projectId: "33eb2225-c6f3-4e4b-91bb-000000000000",
        target: { type: "user", userId: "user-456" },
        templateId: "tmpl-789",
        channels: ["teams"],
        data: {},
      }).success,
    ).toBe(true);
  });

  it("rejects sms and whatsapp targets that are not E.164", () => {
    // Transports keep only the digits, so "ext 12" would be dialled as part of
    // the number; suppressions also match the "+447700900000" webhooks report.
    const bad = [
      "+44 7700 900000",
      "447700900000",
      "07700900000",
      "+44770090000012345",
      "+0447700900000",
      "+44 7700 900000 ext 12",
    ];
    for (const target of bad) {
      for (const channel of ["sms", "whatsapp"]) {
        const contact = { channel, target };
        expect(AddUserSchema.safeParse({ id: "u1", contacts: [contact] }).success).toBe(false);
        expect(BatchAddContactsSchema.safeParse(contact).success).toBe(false);
      }
      expect(UpdateUserSchema.safeParse({ phone: target }).success).toBe(false);
    }
    for (const target of ["+447700900000", "+15550000001", "+6831234"]) {
      for (const channel of ["sms", "whatsapp"]) {
        const contact = { channel, target };
        expect(AddUserSchema.safeParse({ id: "u1", contacts: [contact] }).success).toBe(true);
        expect(BatchAddContactsSchema.safeParse([contact]).success).toBe(true);
      }
      expect(AddUserSchema.safeParse({ id: "u1", phone: [target] }).success).toBe(true);
    }
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
