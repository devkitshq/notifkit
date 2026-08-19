import { describe, it, expect } from "vitest";
import { z } from "zod";
import { EventRegistry, registry, buildStreamEvent } from "@/contracts/index.js";

const Schema = z.object({ field: z.string() });

describe("EventRegistry", () => {
  describe("define", () => {
    it("registers a schema and exposes it", () => {
      const r = new EventRegistry();
      r.define("my.event", Schema);

      expect(r.getSchema("my.event")).toBe(Schema);
      expect(r.has("my.event")).toBe(true);
      expect(r.types()).toEqual(["my.event"]);
    });

    it("refuses to redefine a registered type", () => {
      const r = new EventRegistry();
      r.define("my.event", Schema);

      expect(() => r.define("my.event", Schema)).toThrow(
        'Event type "my.event" is already registered',
      );
    });

    it("reports unknown types as absent", () => {
      const r = new EventRegistry();

      expect(r.has("nope")).toBe(false);
      expect(r.getSchema("nope")).toBeUndefined();
      expect(r.types()).toEqual([]);
    });
  });

  describe("parsePayload", () => {
    it("returns the parsed payload", () => {
      const r = new EventRegistry();
      r.define("my.event", Schema);

      expect(r.parsePayload("my.event" as any, { field: "value" })).toEqual({ field: "value" });
    });

    it("throws on an unregistered type", () => {
      const r = new EventRegistry();

      expect(() => r.parsePayload("nope" as any, {})).toThrow('Unknown event type: "nope"');
    });

    it("propagates the schema's own validation error", () => {
      const r = new EventRegistry();
      r.define("my.event", Schema);

      expect(() => r.parsePayload("my.event" as any, { field: 42 })).toThrow(z.ZodError);
    });
  });

  describe("safeParsePayload", () => {
    it("succeeds with the parsed data", () => {
      const r = new EventRegistry();
      r.define("my.event", Schema);
      const result = r.safeParsePayload("my.event" as any, { field: "value" });

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toEqual({ field: "value" });
    });

    it("fails with a synthesised error for an unregistered type", () => {
      const r = new EventRegistry();
      const result = r.safeParsePayload("nope" as any, {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]!.message).toBe('Unknown event type: "nope"');
        expect(result.error.issues[0]!.code).toBe("custom");
      }
    });

    it("fails with the schema's issues for an invalid payload", () => {
      const r = new EventRegistry();
      r.define("my.event", Schema);
      const result = r.safeParsePayload("my.event" as any, { field: 42 });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]!.path).toEqual(["field"]);
    });
  });

  describe("the global registry", () => {
    it("has the built-in notification events registered at import time", () => {
      expect(registry.has("notification.requested")).toBe(true);
      expect(registry.has("notification.delivered")).toBe(true);
      expect(registry.types()).toContain("notification.ai_pending");
    });

    it("parses a built-in payload through the singleton", () => {
      const parsed = registry.parsePayload("notification.requested", {
        projectId: "11111111-1111-4111-8111-111111111111",
        target: { type: "user", userId: "usr_1" },
        templateId: "welcome",
      });

      expect(parsed.priority).toBe("normal");
      expect(parsed.fallback).toBe(false);
    });
  });
});

describe("buildStreamEvent", () => {
  it("carries through the traceId it is given", () => {
    const event = buildStreamEvent("notification.failed", { a: 1 }, "enricher", "trace-1");

    expect(event).toMatchObject({
      type: "notification.failed",
      payload: { a: 1 },
      metadata: { traceId: "trace-1", source: "enricher", retryCount: 0 },
    });
  });

  it("generates a traceId when none is supplied", () => {
    const event = buildStreamEvent("notification.failed", {}, "enricher");

    expect(event.metadata.traceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
