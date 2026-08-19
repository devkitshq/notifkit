import { describe, it, expect } from "vitest";
import {
  resolveStepTarget,
  buildStepNotifyPayload,
  SuspendExecutionError,
} from "@/workflows/sdk.js";
import type { WorkflowNotifyInput } from "@/contracts/sdk.js";

describe("Workflow SDK Target & Payload Resolution (src/workflows/sdk.ts)", () => {
  describe("resolveStepTarget", () => {
    it("returns segment target when segment is provided", () => {
      const stepArgs: WorkflowNotifyInput = {
        template: "promo",
        segment: "power-users",
      };
      const target = resolveStepTarget(stepArgs, null);
      expect(target).toEqual({ type: "segment", segment: "power-users" });
    });

    it("returns topic target when topic is provided", () => {
      const stepArgs: WorkflowNotifyInput = {
        template: "security-alert",
        topic: "security",
      };
      const target = resolveStepTarget(stepArgs, null);
      expect(target).toEqual({ type: "topic", topic: "security" });
    });

    it("returns user target when user is provided as a string", () => {
      const stepArgs: WorkflowNotifyInput = {
        template: "welcome",
        user: "user-123",
      };
      const target = resolveStepTarget(stepArgs, null);
      expect(target).toEqual({ type: "user", userId: "user-123" });
    });

    it("returns user target when user is provided as an object with id", () => {
      const stepArgs: WorkflowNotifyInput = {
        template: "welcome",
        user: { id: "user-456" } as any,
      };
      const target = resolveStepTarget(stepArgs, null);
      expect(target).toEqual({ type: "user", userId: "user-456" });
    });

    it("throws an error when user is provided as an array", () => {
      const stepArgs: WorkflowNotifyInput = {
        template: "broadcast",
        user: ["user-1", "user-2"] as any,
      };
      expect(() => resolveStepTarget(stepArgs, null)).toThrowError(
        /step\.notify\(\) takes a single `user`/,
      );
    });

    it("falls back to instanceInput user id when step target is omitted", () => {
      const stepArgs: WorkflowNotifyInput = {
        template: "daily-digest",
      };
      const instanceInput = { user: { id: "user-inherited-789" } };
      const target = resolveStepTarget(stepArgs, instanceInput);
      expect(target).toEqual({ type: "user", userId: "user-inherited-789" });
    });

    it("throws an error when step names no target and instanceInput has no user id", () => {
      const stepArgs: WorkflowNotifyInput = {
        template: "daily-digest",
      };
      expect(() => resolveStepTarget(stepArgs, {})).toThrowError(/step\.notify\(\) has no target/);
      expect(() => resolveStepTarget(stepArgs, null)).toThrowError(
        /step\.notify\(\) has no target/,
      );
    });
  });

  describe("buildStepNotifyPayload", () => {
    it("maps all fields correctly with default values", () => {
      const stepArgs: WorkflowNotifyInput = {
        template: "welcome-template",
        user: "user-001",
      };

      const payload = buildStepNotifyPayload(stepArgs, null, "proj-1", "idem-key-1");

      expect(payload).toEqual({
        projectId: "proj-1",
        target: { type: "user", userId: "user-001" },
        templateId: "welcome-template",
        priority: "normal",
        channels: undefined,
        data: {},
        aiPrompts: undefined,
        fallback: false,
        scheduledAt: undefined,
        idempotencyKey: "idem-key-1",
      });
    });

    it("maps custom options (sendAt -> scheduledAt, priority, channels, fallback, aiPrompts)", () => {
      const stepArgs: WorkflowNotifyInput = {
        template: "alert-template",
        user: "user-002",
        priority: "critical",
        channels: ["sms", "email"],
        data: { balance: 100 },
        aiPrompts: { summary: "Summarize this account balance" },
        fallback: true,
        sendAt: "2026-08-20T10:00:00Z",
      };

      const payload = buildStepNotifyPayload(stepArgs, null, "proj-2");

      expect(payload).toEqual({
        projectId: "proj-2",
        target: { type: "user", userId: "user-002" },
        templateId: "alert-template",
        priority: "critical",
        channels: ["sms", "email"],
        data: { balance: 100 },
        aiPrompts: { summary: "Summarize this account balance" },
        fallback: true,
        scheduledAt: "2026-08-20T10:00:00Z",
        idempotencyKey: undefined,
      });
    });
  });

  describe("SuspendExecutionError", () => {
    it("constructs error with reason and payload correctly", () => {
      const err = new SuspendExecutionError("wait", { durationSeconds: 60 });
      expect(err.name).toBe("SuspendExecutionError");
      expect(err.message).toBe("Execution suspended for wait");
      expect(err.reason).toBe("wait");
      expect(err.payload).toEqual({ durationSeconds: 60 });
    });
  });

  describe("WorkflowRegistry & workflow helper", () => {
    it("registers and retrieves workflow handlers", async () => {
      const { workflowRegistry, workflow } = await import("@/workflows/index.js");
      const dummyHandler = async () => {};

      workflowRegistry.register("test-registry-direct", dummyHandler);
      expect(workflowRegistry.get("test-registry-direct")).toBe(dummyHandler);

      workflow("test-registry-helper", dummyHandler);
      expect(workflowRegistry.get("test-registry-helper")).toBe(dummyHandler);

      expect(workflowRegistry.get("non-existent-workflow")).toBeUndefined();
    });
  });
});
