import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDb, type MockDb } from "./helpers/mock-db.js";
import { suppressions } from "@/db/schema.js";
import { ProjectSettingsCache } from "@/rate-limiter/index.js";
import { EngineWorker } from "@/services/engine/main.js";

describe("EngineWorker", () => {
  let worker: EngineWorker;
  let mockRegistry: any;
  let mockIdempotency: any;
  let mockThrottle: any;
  let mockProjectSettingsLoader: any;
  let mockRedis: any;
  let mockGetCachedTemplate: any;
  let mockAiPendingProducer: any;
  let mockScheduledProducer: any;
  let mockOutboundProducers: any;
  let mockGlobalEmitter: any;
  let mockDb: MockDb;

  beforeEach(() => {
    mockRegistry = {
      safeParsePayload: vi.fn().mockReturnValue({
        success: true,
        data: {
          projectId: "123e4567-e89b-12d3-a456-426614174000",
          rawEventId: "evt-1",
          recipientId: "usr-1",
          channel: "email",
          priority: "normal",
          recipient: {
            locale: "en",
            timezone: "UTC",
            preferences: { optedOut: false, quietHours: [] },
          },
          templateVariables: { name: "Alice" },
          fallbackChain: [],
        },
      }),
    };
    mockIdempotency = {
      isProcessed: vi.fn().mockResolvedValue(false),
      checkAndMark: vi.fn().mockResolvedValue(true),
      markProcessed: vi.fn().mockResolvedValue(true),
      unmark: vi.fn().mockResolvedValue(undefined),
    };
    mockThrottle = { check: vi.fn().mockResolvedValue({ allowed: true, count: 1 }) };
    mockProjectSettingsLoader = vi.fn().mockResolvedValue(null);
    mockRedis = {
      set: vi.fn(),
      pipeline: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnThis(),
        zadd: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      }),
    };
    mockGetCachedTemplate = vi.fn().mockResolvedValue(null);
    mockAiPendingProducer = { publish: vi.fn() };
    mockScheduledProducer = { publish: vi.fn() };
    mockOutboundProducers = { normal: { publish: vi.fn(), publishBatch: vi.fn() } };
    mockGlobalEmitter = { emit: vi.fn() };

    const mockLogger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };

    mockDb = createMockDb();

    worker = new EngineWorker({
      consumer: { ack: vi.fn(), nack: vi.fn() } as any,
      pendingScanner: {} as any,
      logger: mockLogger as any,
      maxRetriesBeforeDlq: 5,
      registry: mockRegistry,
      idempotency: mockIdempotency,
      throttle: mockThrottle,
      projectSettings: new ProjectSettingsCache((id: string) => mockProjectSettingsLoader(id)),
      redis: mockRedis,
      templateCache: { getCachedTemplate: mockGetCachedTemplate } as any,
      aiPendingProducer: mockAiPendingProducer,
      scheduledProducer: mockScheduledProducer,
      outboundProducers: mockOutboundProducers,
      globalEmitter: mockGlobalEmitter,
      contactRepo: {
        findActiveByUserIds: vi
          .fn()
          .mockResolvedValue(
            new Map([["usr-1", [{ channel: "email", target: "alice@example.com", active: true }]]]),
          ),
      } as any,
      db: mockDb.db,
    });
  });

  /** A minimal enriched message that reaches the throttle check. */
  const enrichedMsg = (id = "msg-throttle") => ({
    id,
    event: {
      id: "evt-throttle",
      type: "notification.enriched",
      metadata: { traceId: "trace-throttle" },
      payload: {},
    },
  });

  it("passes the project's throttle overrides to the rate limiter", async () => {
    mockProjectSettingsLoader.mockResolvedValue({
      throttleLimit: 50,
      throttleWindowHours: 24,
    });

    await worker.process(enrichedMsg() as any);

    expect(mockThrottle.check).toHaveBeenCalledWith(
      "123e4567-e89b-12d3-a456-426614174000",
      "usr-1",
      "normal",
      expect.objectContaining({ limit: 50, windowHours: 24 }),
    );
  });

  it("sends null overrides when the project has none, so the global default applies", async () => {
    mockProjectSettingsLoader.mockResolvedValue(null);

    await worker.process(enrichedMsg() as any);

    expect(mockThrottle.check).toHaveBeenCalledWith(
      expect.any(String),
      "usr-1",
      "normal",
      expect.objectContaining({ limit: null, windowHours: null }),
    );
  });

  it("looks the project's settings up once, not once per message", async () => {
    mockProjectSettingsLoader.mockResolvedValue({
      throttleLimit: 50,
      throttleWindowHours: null,
    });

    await worker.process(enrichedMsg("msg-1") as any);
    await worker.process(enrichedMsg("msg-2") as any);
    await worker.process(enrichedMsg("msg-3") as any);

    expect(mockThrottle.check).toHaveBeenCalledTimes(3);
    expect(mockProjectSettingsLoader).toHaveBeenCalledTimes(1);
  });

  it("still delivers when the settings lookup fails", async () => {
    mockProjectSettingsLoader.mockRejectedValue(new Error("db unreachable"));

    await worker.process(enrichedMsg() as any);

    // Falls back to the global default rather than dropping the notification.
    expect(mockThrottle.check).toHaveBeenCalledWith(
      expect.any(String),
      "usr-1",
      "normal",
      expect.objectContaining({ limit: null, windowHours: null }),
    );
    expect(mockOutboundProducers.normal.publish).toHaveBeenCalled();
  });

  it("hands due tasks to an in-process delivery instead of the outbound stream when fused", async () => {
    mockProjectSettingsLoader.mockResolvedValue(null);
    const inline = vi.fn().mockResolvedValue(undefined);
    worker.setInlineNext(inline);

    await worker.process(enrichedMsg() as any);

    expect(mockOutboundProducers.normal.publish).not.toHaveBeenCalled();
    expect(inline).toHaveBeenCalledTimes(1);
    const handed = inline.mock.calls[0]![0];
    expect(handed.type).toBe("notification.dispatched");
    // A full envelope: delivery parses it exactly as if it had come off a stream.
    expect(typeof handed.id).toBe("string");
    expect(typeof handed.timestamp).toBe("string");
  });

  it("skips its own idempotency marker for inline messages, keeping it for stream reads", async () => {
    mockProjectSettingsLoader.mockResolvedValue(null);

    await worker.process({ ...enrichedMsg("inline-1"), inline: true } as any);
    expect(mockIdempotency.checkAndMark).not.toHaveBeenCalled();
    expect(mockIdempotency.markProcessed).not.toHaveBeenCalled();
    // The throttle still sees a stable id, which is what makes skipping safe.
    expect(mockThrottle.check.mock.calls[0]![3].messageId).toBeDefined();

    await worker.process(enrichedMsg("stream-1") as any);
    expect(mockIdempotency.checkAndMark).toHaveBeenCalledTimes(1);
    expect(mockIdempotency.markProcessed).toHaveBeenCalledTimes(1);
  });

  it("propagates an inline delivery failure so the enriched message is retried", async () => {
    mockProjectSettingsLoader.mockResolvedValue(null);
    worker.setInlineNext(vi.fn().mockRejectedValue(new Error("provider down")));

    await expect(worker.process(enrichedMsg() as any)).rejects.toThrow("provider down");
  });

  it("does not warn about a missing UNSUBSCRIBE_SECRET once per email", async () => {
    const enrichedWithTemplate = mockRegistry.safeParsePayload().data;
    mockRegistry.safeParsePayload.mockReturnValue({
      success: true,
      data: { ...enrichedWithTemplate, templateId: "newsletter" },
    });
    mockGetCachedTemplate.mockResolvedValue({ id: "newsletter", topics: ["marketing"] });

    await worker.process(enrichedMsg("msg-1") as any);
    await worker.process(enrichedMsg("msg-2") as any);

    expect(mockOutboundProducers.normal.publish).toHaveBeenCalledTimes(2);
    const warnings = (worker as any).logger.warn.mock.calls.map((c: unknown[]) => c.at(-1));
    expect(warnings).not.toContainEqual(expect.stringContaining("UNSUBSCRIBE_SECRET"));
  });

  it("gracefully drops message if template is nonexistent", async () => {
    // Override safeParsePayload to include templateId
    mockRegistry.safeParsePayload.mockReturnValueOnce({
      success: true,
      data: {
        projectId: "proj-1",
        rawEventId: "evt-no-template",
        recipientId: "usr-1",
        channel: "email",
        priority: "normal",
        recipient: { preferences: { optedOut: false, quietHours: [] } },
        templateId: "missing-template",
      },
    });

    // Mock getCachedTemplate to return null
    mockGetCachedTemplate.mockResolvedValueOnce(null);

    const msg = {
      id: "msg-no-template",
      event: {
        id: "evt-no-template",
        type: "notification.enriched",
        metadata: { traceId: "trace-3" },
        payload: {
          templateId: "missing-template",
          projectId: "proj-1",
        },
      },
    };

    const emitSpy = vi.spyOn(mockGlobalEmitter, "emit");

    await worker.process(msg as any);

    expect(mockOutboundProducers.normal.publish).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith(
      "notification:skipped",
      expect.objectContaining({ reason: "template_not_found" }),
    );
    expect(mockIdempotency.markProcessed).toHaveBeenCalledWith(
      "evt-no-template:usr-1:email",
      undefined,
    );
  });

  it("marks idempotency as processed when dropping an opted-out recipient", async () => {
    mockRegistry.safeParsePayload.mockReturnValueOnce({
      success: true,
      data: {
        projectId: "proj-1",
        rawEventId: "evt-opted-out",
        recipientId: "usr-opted-out",
        channel: "email",
        priority: "normal",
        recipient: { preferences: { optedOut: true, quietHours: [] } },
      },
    });

    const msg = {
      id: "msg-opted-out",
      event: {
        id: "evt-opted-out",
        type: "notification.enriched",
        metadata: { traceId: "trace-opt-out" },
        payload: {},
      },
    };

    await worker.process(msg as any);

    expect(mockOutboundProducers.normal.publish).not.toHaveBeenCalled();
    expect(mockGlobalEmitter.emit).toHaveBeenCalledWith("notification:skipped", {
      projectId: "proj-1",
      eventId: "evt-opted-out",
      recipientId: "usr-opted-out",
      reason: "user_opted_out",
    });
    expect(mockIdempotency.markProcessed).toHaveBeenCalledWith(
      "evt-opted-out:usr-opted-out:email",
      undefined,
    );
  });

  it("marks idempotency as processed when dropping a throttled recipient", async () => {
    mockRegistry.safeParsePayload.mockReturnValueOnce({
      success: true,
      data: {
        projectId: "proj-1",
        rawEventId: "evt-throttled",
        recipientId: "usr-throttled",
        channel: "email",
        priority: "normal",
        recipient: { preferences: { optedOut: false, quietHours: [] } },
      },
    });

    mockThrottle.check.mockResolvedValueOnce({ allowed: false, count: 100, limit: 10 });

    const msg = {
      id: "msg-throttled",
      event: {
        id: "evt-throttled",
        type: "notification.enriched",
        metadata: { traceId: "trace-throttle" },
        payload: {},
      },
    };

    await worker.process(msg as any);

    expect(mockOutboundProducers.normal.publish).not.toHaveBeenCalled();
    expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
      "notification:throttled",
      "usr-throttled",
      100,
    );
    expect(mockIdempotency.markProcessed).toHaveBeenCalledWith(
      "evt-throttled:usr-throttled:email",
      undefined,
    );
  });

  it("dispatches unrendered, carrying the template and variables for delivery to render", async () => {
    mockGetCachedTemplate.mockResolvedValue({
      content: { subject: "Hello {{name}}", text: "Welcome {{name}}" },
    });
    mockRegistry.safeParsePayload.mockReturnValue({
      success: true,
      data: {
        projectId: "123e4567-e89b-12d3-a456-426614174000",
        rawEventId: "evt-1",
        recipientId: "usr-1",
        channel: "email",
        priority: "normal",
        recipient: {
          locale: "en",
          timezone: "UTC",
          preferences: { optedOut: false, quietHours: [] },
        },
        templateId: "tmpl-1",
        templateVariables: { name: "Alice" },
        fallbackChain: [],
      },
    });

    await worker.process({
      id: "msg-1",
      event: {
        id: "evt-1",
        type: "notification.enriched",
        metadata: { traceId: "t" },
        payload: {},
      },
    } as any);

    expect(mockOutboundProducers.normal.publish).toHaveBeenCalledTimes(1);
    const published = mockOutboundProducers.normal.publish.mock.calls[0]![0];
    expect(published.payload.renderedContent).toBeUndefined();
    expect(published.payload.templateId).toBe("tmpl-1");
    expect(published.payload.templateVariables).toEqual({ name: "Alice" });
  });

  it("sends to the contact the enricher resolved without re-reading the user's contacts", async () => {
    mockRegistry.safeParsePayload.mockReturnValue({
      success: true,
      data: {
        projectId: "123e4567-e89b-12d3-a456-426614174000",
        rawEventId: "evt-1",
        recipientId: "usr-1",
        channel: "email",
        priority: "normal",
        recipient: { locale: "en", timezone: "UTC", preferences: { optedOut: false } },
        templateVariables: {},
        contactId: "contact-7",
        destination: "second@example.com",
      },
    });
    const findActive = (worker as any).contactRepo.findActiveByUserIds;
    findActive.mockClear();

    await worker.process({
      id: "msg-1",
      event: {
        id: "evt-1",
        type: "notification.enriched",
        metadata: { traceId: "t" },
        payload: {},
      },
    } as any);

    expect(findActive).not.toHaveBeenCalled();
    const published = mockOutboundProducers.normal.publish.mock.calls[0]![0];
    expect(published.payload.taskId).toBe("evt-1:contact-7");
    expect(published.payload.destination).toBe("second@example.com");
    // Two contacts on one channel are two messages, not a duplicate.
    expect(mockIdempotency.markProcessed).toHaveBeenCalledWith(
      "evt-1:usr-1:email:contact-7",
      undefined,
    );
  });

  // ── Suppression gate ──────────────────────────────────────────────────────
  //
  // The last thing standing between an opted-out address and a send. Every one
  // of these is a "we mailed someone who asked us not to" incident if it breaks.

  describe("suppression gate", () => {
    /** An enriched payload with the fields the gate reads, plus overrides. */
    const enrichedPayload = (overrides: Record<string, unknown> = {}) => ({
      success: true,
      data: {
        projectId: "123e4567-e89b-12d3-a456-426614174000",
        rawEventId: "evt-1",
        recipientId: "usr-1",
        channel: "email",
        priority: "normal",
        recipient: {
          locale: "en",
          timezone: "UTC",
          preferences: { optedOut: false, quietHours: [] },
        },
        templateVariables: { name: "Alice" },
        fallbackChain: [],
        ...overrides,
      },
    });

    it("drops a message addressed to a suppressed destination", async () => {
      mockDb.queueSelect([{ target: "alice@example.com" }]);

      await worker.process(enrichedMsg() as any);

      expect(mockOutboundProducers.normal.publish).not.toHaveBeenCalled();
      expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
        "notification:skipped",
        expect.objectContaining({ reason: "suppressed", recipientId: "usr-1" }),
      );
    });

    it("delivers when the suppression list holds a different address", async () => {
      mockDb.queueSelect([{ target: "someone-else@example.com" }]);

      await worker.process(enrichedMsg() as any);

      expect(mockOutboundProducers.normal.publish).toHaveBeenCalledTimes(1);
    });

    it("delivers when nothing is suppressed for the project", async () => {
      mockDb.queueSelect([]);

      await worker.process(enrichedMsg() as any);

      expect(mockOutboundProducers.normal.publish).toHaveBeenCalledTimes(1);
    });

    it("matches a suppression stored in canonical form against a mixed-case contact", async () => {
      // Writers normalise before storing; the gate normalises before looking
      // up. If those two ever drift, opt-outs silently stop matching.
      mockDb.queueSelect([{ target: "alice@example.com" }]);
      worker["contactRepo"].findActiveByUserIds.mockResolvedValue(
        new Map([["usr-1", [{ channel: "email", target: "  Alice@Example.COM ", active: true }]]]),
      );

      await worker.process(enrichedMsg() as any);

      expect(mockOutboundProducers.normal.publish).not.toHaveBeenCalled();
    });

    it("suppresses a critical notification too — an opt-out outranks priority", async () => {
      mockRegistry.safeParsePayload.mockReturnValue(enrichedPayload({ priority: "critical" }));
      mockDb.queueSelect([{ target: "alice@example.com" }]);

      await worker.process(enrichedMsg() as any);

      // No critical producer is configured, so a critical send would fall back
      // to the normal one — which is exactly what must not happen here.
      expect(mockOutboundProducers.normal.publish).not.toHaveBeenCalled();
      expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
        "notification:skipped",
        expect.objectContaining({ reason: "suppressed" }),
      );
    });

    it("holds the message when the suppression lookup fails, rather than sending", async () => {
      // A failed query must not read as "nothing is suppressed". The worker
      // rethrows so the message stays pending and gets retried.
      mockDb.failWith(new Error("db unreachable"));

      await expect(worker.process(enrichedMsg() as any)).rejects.toThrow("db unreachable");

      expect(mockOutboundProducers.normal.publish).not.toHaveBeenCalled();
    });

    it("releases the idempotency marker when the lookup fails, so the retry is not a duplicate", async () => {
      mockDb.failWith(new Error("db unreachable"));

      await expect(worker.process(enrichedMsg() as any)).rejects.toThrow("db unreachable");

      expect(mockIdempotency.unmark).toHaveBeenCalledTimes(1);
      expect(mockIdempotency.markProcessed).not.toHaveBeenCalled();
    });

    it("queries suppressions scoped to the message's project and channel", async () => {
      mockDb.queueSelect([]);

      await worker.process(enrichedMsg() as any);

      expect(mockDb.selects).toHaveLength(1);
      expect(mockDb.selects[0]!.table).toBe(suppressions);
    });

    it("does not re-query for a second message on the same project and channel in one batch", async () => {
      mockDb.queueSelect([]);

      // Both loads land in the same tick, which is what the batching is for.
      await Promise.all([
        worker.process(enrichedMsg("msg-a") as any),
        worker.process(enrichedMsg("msg-b") as any),
      ]);

      expect(mockDb.selects).toHaveLength(1);
      expect(mockOutboundProducers.normal.publish).toHaveBeenCalledTimes(2);
    });

    it("keeps a suppression on one channel from blocking another", async () => {
      mockRegistry.safeParsePayload.mockReturnValue(enrichedPayload({ channel: "sms" }));
      worker["contactRepo"].findActiveByUserIds.mockResolvedValue(
        new Map([["usr-1", [{ channel: "sms", target: "+15551234567", active: true }]]]),
      );
      // The email suppression list is irrelevant to an SMS send.
      mockDb.queueSelect([]);

      await worker.process(enrichedMsg() as any);

      expect(mockOutboundProducers.normal.publish).toHaveBeenCalledTimes(1);
    });

    it("isolates multi-contact recipient where one address is suppressed and another is active", async () => {
      mockRegistry.safeParsePayload.mockReturnValue(enrichedPayload({ channel: "email" }));
      worker["contactRepo"].findActiveByUserIds.mockResolvedValue(
        new Map([
          [
            "usr-1",
            [
              { id: "c1", channel: "email", target: "bad@example.com", active: true },
              { id: "c2", channel: "email", target: "good@example.com", active: true },
            ],
          ],
        ]),
      );

      // bad@example.com is suppressed, good@example.com is not
      mockDb.queueSelect([
        {
          projectId: "123e4567-e89b-12d3-a456-426614174000",
          channel: "email",
          target: "bad@example.com",
        },
      ]);

      await worker.process(enrichedMsg() as any);

      // Only the unsuppressed contact gets published
      expect(mockOutboundProducers.normal.publish).toHaveBeenCalledTimes(1);
      const published = mockOutboundProducers.normal.publish.mock.calls[0][0].payload;
      expect(published.destination).toBe("good@example.com");

      // The suppressed contact emits notification:skipped
      expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
        "notification:skipped",
        expect.objectContaining({ reason: "suppressed", recipientId: "usr-1" }),
      );
    });

    it("calculates extended idempotency TTL for far-future scheduled notifications", async () => {
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days in future
      mockRegistry.safeParsePayload.mockReturnValue(
        enrichedPayload({ channel: "email", scheduledAt: futureDate }),
      );
      mockDb.queueSelect([]);

      await worker.process(enrichedMsg() as any);

      // markProcessed should be called with TTL >= 7 days in seconds + 86400 (minimum 691200 seconds)
      expect(mockIdempotency.markProcessed).toHaveBeenCalled();
      const passedTtl = mockIdempotency.markProcessed.mock.calls[0][1];
      expect(passedTtl).toBeGreaterThan(7 * 24 * 60 * 60);
    });
  });
});
