import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeliveryWorker, MAX_THROTTLE_DEFERRALS } from "@/services/delivery/main.js";
import { NonRetryableError } from "@/workers/index.js";
import { registry } from "@/index.js";

describe("DeliveryWorker", () => {
  let worker: DeliveryWorker;
  let mockTransportRegistry: any;
  let mockRedis: any;
  let mockScheduledProducer: any;
  let mockEnrichedProducers: any;
  let mockDeviceRepo: any;

  let mockGlobalEmitter: any;
  let mockLogger: any;
  let mockConsumer: any;

  beforeEach(() => {
    mockTransportRegistry = {
      getAll: vi.fn(),
    };
    mockRedis = { set: vi.fn(), get: vi.fn() };
    mockScheduledProducer = { publish: vi.fn() };
    mockEnrichedProducers = {
      normal: { publish: vi.fn().mockResolvedValue("msg-2") },
    };
    mockDeviceRepo = {
      findActiveByUserId: vi.fn().mockResolvedValue([{ deviceToken: "token-1" }]),
      deactivate: vi.fn(),
    };

    mockGlobalEmitter = {
      emit: vi.fn(),
    };
    mockLogger = {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    mockConsumer = { ack: vi.fn(), nack: vi.fn(), redis: { incr: vi.fn(), expire: vi.fn() } };

    worker = new DeliveryWorker({
      consumer: mockConsumer as any,
      pendingScanner: {} as any,
      logger: mockLogger as any,
      maxRetriesBeforeDlq: 5,
      transportRegistry: mockTransportRegistry,
      idempotency: {
        checkAndMark: vi.fn().mockResolvedValue(true),
        markProcessed: vi.fn().mockResolvedValue(true),
        unmark: vi.fn().mockResolvedValue(undefined),
      },
      redis: mockRedis,
      scheduledProducer: mockScheduledProducer,
      enrichedProducers: mockEnrichedProducers,
      contactRepo: mockDeviceRepo,
      eventsProducer: { publish: vi.fn(), publishBatch: vi.fn() },
      globalEmitter: mockGlobalEmitter,
      db: {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi
                .fn()
                .mockResolvedValue([
                  { taskId: "123e4567-e89b-12d3-a456-426614174001" },
                  { taskId: "123e4567-e89b-12d3-a456-426614174003" },
                ]),
            }),
            onConflictDoUpdate: vi.fn().mockReturnValue({
              catch: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({}) }),
        }),
      } as any,
    });
  });

  it("handles provider fallback by iterating through available transports until one succeeds", async () => {
    const failingTransport = { send: vi.fn().mockRejectedValue(new Error("Network Error")) };
    const succeedingTransport = {
      send: vi.fn().mockResolvedValue({ success: true, providerMessageId: "provider-id-123" }),
    };
    mockTransportRegistry.getAll.mockReturnValue([failingTransport, succeedingTransport]);

    const msg = {
      id: "msg-1",
      event: {
        id: "evt-1",
        type: "notification.dispatched",
        timestamp: new Date().toISOString(),
        metadata: { traceId: "trace-1", source: "test" },
        payload: {
          projectId: "123e4567-e89b-12d3-a456-426614174000",
          taskId: "123e4567-e89b-12d3-a456-426614174001",
          enrichedEventId: "123e4567-e89b-12d3-a456-426614174002",
          recipientId: "usr-1",
          channel: "email",
          priority: "normal",
          deliveryOptions: {},
          destination: "alice@example.com",
          renderedContent: { content: { body: "Hello World" } },
        },
      },
    };

    await worker.process(msg as any);

    expect(failingTransport.send).toHaveBeenCalledTimes(1);
    expect(succeedingTransport.send).toHaveBeenCalledTimes(1);
    expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
      "delivery:delivered",
      "123e4567-e89b-12d3-a456-426614174001",
      "provider-id-123",
      "email",
      "123e4567-e89b-12d3-a456-426614174000",
    );
  });

  it("handles channel fallback by publishing to the next channel in the fallbackChain once its attempts are spent", async () => {
    const failingTransport = { send: vi.fn().mockRejectedValue(new Error("Fatal Error")) };
    mockTransportRegistry.getAll.mockReturnValue([failingTransport]);

    const msg = {
      id: "msg-2",
      event: {
        id: "evt-2",
        type: "notification.dispatched",
        timestamp: new Date().toISOString(),
        metadata: { traceId: "trace-2", source: "test" },
        payload: {
          projectId: "123e4567-e89b-12d3-a456-426614174000",
          taskId: "123e4567-e89b-12d3-a456-426614174003",
          enrichedEventId: "123e4567-e89b-12d3-a456-426614174004",
          recipientId: "usr-2",
          channel: "email",
          priority: "normal",
          deliveryOptions: {},
          deliveryAttemptCount: 2, // the last of the default 3
          fallbackChain: ["sms", "push"], // Fallback chain provided
          recipient: {
            id: "usr-2",
            locale: "en",
            timezone: "UTC",
            preferences: { optedOut: false, channels: [] },
          }, // Recipient data required for fallback
          destination: "alice@example.com",
          renderedContent: { content: { body: "Hello World" } },
        },
      },
    };

    await worker.process(msg as any);

    expect(failingTransport.send).toHaveBeenCalledTimes(1);
    // Should emit failure for email
    expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
      "delivery:failed",
      "123e4567-e89b-12d3-a456-426614174003",
      "Fatal Error",
      "email",
      "123e4567-e89b-12d3-a456-426614174000",
    );

    // Should publish to enriched producers for the next channel (sms)
    expect(mockEnrichedProducers.normal.publish).toHaveBeenCalledTimes(1);
    const publishedArg = mockEnrichedProducers.normal.publish.mock.calls[0][0];

    expect(publishedArg.payload.channel).toBe("sms");
    expect(publishedArg.payload.fallbackChain).toEqual(["push"]); // Remaining chain
  });

  // ── Paths that do not end in a delivery ───────────────────────────────────

  /** A dispatched task, with room to vary the parts each test cares about. */
  const dispatched = (payload: Record<string, unknown> = {}, source = "test") => ({
    id: "msg-x",
    event: {
      id: "123e4567-e89b-12d3-a456-426614174009",
      type: "notification.dispatched",
      timestamp: new Date().toISOString(),
      metadata: { traceId: "trace-x", source, retryCount: 0 },
      payload: {
        projectId: "123e4567-e89b-12d3-a456-426614174000",
        taskId: "123e4567-e89b-12d3-a456-426614174001",
        enrichedEventId: "123e4567-e89b-12d3-a456-426614174002",
        recipientId: "usr-1",
        channel: "email",
        priority: "normal",
        deliveryOptions: {},
        destination: "alice@example.com",
        renderedContent: { content: { body: "Hello World" } },
        ...payload,
      },
    },
  });

  const recipient = {
    id: "usr-1",
    locale: "en",
    timezone: "UTC",
    preferences: { optedOut: false, channels: [] },
  };

  it("skips a message whose payload does not match the dispatched contract", async () => {
    mockTransportRegistry.getAll.mockReturnValue([{ send: vi.fn() }]);

    await worker.process({
      id: "msg-bad",
      event: {
        id: "123e4567-e89b-12d3-a456-426614174009",
        type: "notification.dispatched",
        timestamp: new Date().toISOString(),
        metadata: { traceId: "t", source: "test", retryCount: 0 },
        payload: { projectId: "not-a-uuid" },
      },
    } as any);

    expect(mockLogger.warn).toHaveBeenCalled();
    expect(mockTransportRegistry.getAll).not.toHaveBeenCalled();
  });

  it("returns { ack: false } when checkAndMark returns false (duplicate delivery in progress)", async () => {
    (worker as any).idempotency.checkAndMark.mockResolvedValueOnce(false);
    const sendFn = vi.fn();
    mockTransportRegistry.getAll.mockReturnValue([{ send: sendFn }]);

    const result = await worker.process(dispatched() as any);

    expect(result).toEqual({ ack: false });
    expect(sendFn).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "123e4567-e89b-12d3-a456-426614174001" }),
      "duplicate delivery — skipping and leaving pending in stream",
    );
  });

  it("returns void and acks duplicate when acquireLease returns 'completed' (already delivered)", async () => {
    (worker as any).idempotency.acquireLease = vi.fn().mockResolvedValueOnce("completed");
    const sendFn = vi.fn();
    mockTransportRegistry.getAll.mockReturnValue([{ send: sendFn }]);

    const result = await worker.process(dispatched() as any);

    expect(result).toBeUndefined(); // Void return signals BaseWorker to ack
    expect(sendFn).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "123e4567-e89b-12d3-a456-426614174001" }),
      "duplicate delivery — already completed, acking message",
    );
  });

  it("returns { ack: false } when acquireLease returns 'locked' (delivery in progress)", async () => {
    (worker as any).idempotency.acquireLease = vi.fn().mockResolvedValueOnce("locked");
    const sendFn = vi.fn();
    mockTransportRegistry.getAll.mockReturnValue([{ send: sendFn }]);

    const result = await worker.process(dispatched() as any);

    expect(result).toEqual({ ack: false });
    expect(sendFn).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "123e4567-e89b-12d3-a456-426614174001" }),
      "duplicate delivery — skipping and leaving pending in stream",
    );
  });

  it("synchronously calls markProcessed immediately upon transport success", async () => {
    (worker as any).idempotency.acquireLease = vi.fn().mockResolvedValueOnce("acquired");
    (worker as any).idempotency.markProcessed = vi.fn().mockResolvedValueOnce(undefined);
    mockTransportRegistry.getAll.mockReturnValue([
      { send: vi.fn().mockResolvedValue({ success: true, providerMessageId: "prov-sync-1" }) },
    ]);

    await worker.process(dispatched() as any);

    expect((worker as any).idempotency.markProcessed).toHaveBeenCalledWith(
      "123e4567-e89b-12d3-a456-426614174001",
    );
  });

  it("reports a failure when no transport is registered for the channel", async () => {
    mockTransportRegistry.getAll.mockReturnValue([]);
    const eventSpy = vi.spyOn(worker["eventProcessor"], "add");

    await worker.process(dispatched() as any);

    expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
      "delivery:failed",
      "123e4567-e89b-12d3-a456-426614174001",
      "no transport",
      "email",
      "123e4567-e89b-12d3-a456-426614174000",
    );
    expect(eventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "notification.failed",
        payload: expect.objectContaining({
          failureReason: "no transport registered for channel",
          failureCode: "no_transport",
        }),
      }),
    );
  });

  it("rolls over to the next channel when none is registered, rather than reporting a failure", async () => {
    mockTransportRegistry.getAll.mockReturnValue([]);

    await worker.process(dispatched({ fallbackChain: ["sms"], recipient }) as any);

    expect(mockEnrichedProducers.normal.publish).toHaveBeenCalledTimes(1);
    expect(mockGlobalEmitter.emit).not.toHaveBeenCalledWith(
      "delivery:failed",
      expect.anything(),
      "no transport",
      expect.anything(),
      expect.anything(),
    );
  });

  it("skips a task that another worker already claimed", async () => {
    const transport = { send: vi.fn() };
    mockTransportRegistry.getAll.mockReturnValue([transport]);
    worker["idempotency"].checkAndMark.mockResolvedValue(false);

    await worker.process(dispatched() as any);

    // The soft lock is what stops the same task being sent twice when the
    // scheduler's visibility timeout re-releases it.
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("holds its claim for 60s — the same window the scheduler makes a task visible again in", async () => {
    // These two numbers are coupled: the delivery lock (60s here) and the
    // scheduler's visibility timeout (60_000ms, pinned in scheduler-poll). A
    // send slower than the lock can be released and re-claimed mid-flight, so
    // shortening this one without lengthening that one duplicates sends.
    mockTransportRegistry.getAll.mockReturnValue([
      { send: vi.fn().mockResolvedValue({ success: true, providerMessageId: "p-1" }) },
    ]);

    await worker.process(dispatched() as any);

    expect(worker["idempotency"].checkAndMark).toHaveBeenCalledWith(
      "123e4567-e89b-12d3-a456-426614174001",
      60,
    );
  });

  it("marks the task processed once it has been delivered", async () => {
    mockTransportRegistry.getAll.mockReturnValue([
      { send: vi.fn().mockResolvedValue({ success: true, providerMessageId: "p-1" }) },
    ]);

    await worker.process(dispatched() as any);

    expect(worker["idempotency"].markProcessed).toHaveBeenCalledWith(
      "123e4567-e89b-12d3-a456-426614174001",
    );
  });

  it("treats a transport that reports failure without throwing as a failure", async () => {
    mockTransportRegistry.getAll.mockReturnValue([
      { send: vi.fn().mockResolvedValue({ success: false, error: "mailbox full" }) },
    ]);

    await expect(worker.process(dispatched({ deliveryAttemptCount: 2 }) as any)).rejects.toThrow(
      "mailbox full",
    );
    expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
      "delivery:failed",
      "123e4567-e89b-12d3-a456-426614174001",
      "mailbox full",
      "email",
      "123e4567-e89b-12d3-a456-426614174000",
    );
  });

  it("releases its lock when delivery fails, so the retry is not seen as a duplicate", async () => {
    mockTransportRegistry.getAll.mockReturnValue([
      { send: vi.fn().mockRejectedValue(new Error("smtp down")) },
    ]);

    await expect(worker.process(dispatched({ deliveryAttemptCount: 2 }) as any)).rejects.toThrow(
      "smtp down",
    );
    expect(worker["idempotency"].unmark).toHaveBeenCalledWith(
      "123e4567-e89b-12d3-a456-426614174001",
    );
    expect(worker["idempotency"].markProcessed).not.toHaveBeenCalled();
  });

  describe("a lock that fails to release", () => {
    const unmarkFails = () =>
      worker["idempotency"].unmark.mockRejectedValue(new Error("redis gone"));
    const loggedRelease = () =>
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "123e4567-e89b-12d3-a456-426614174001" }),
        "failed to release idempotency lock",
      );

    it("is logged after a retry is scheduled, since the retry would be skipped", async () => {
      unmarkFails();
      mockTransportRegistry.getAll.mockReturnValue([
        { send: vi.fn().mockRejectedValue(new Error("smtp down")) },
      ]);

      await worker.process(dispatched() as any);

      expect(mockScheduledProducer.publish).toHaveBeenCalledTimes(1);
      loggedRelease();
    });

    it("is logged when delivery fails", async () => {
      unmarkFails();
      mockTransportRegistry.getAll.mockReturnValue([
        { send: vi.fn().mockRejectedValue(new Error("smtp down")) },
      ]);

      await expect(worker.process(dispatched({ deliveryAttemptCount: 2 }) as any)).rejects.toThrow(
        "smtp down",
      );

      loggedRelease();
    });
  });

  describe("dispatched log entry", () => {
    const published = () =>
      (worker as any).eventsProducer.publishBatch.mock.calls.flatMap((c: any[]) => c[0]);

    it("rides on the outcome event when the send is quick: one stream entry, not two", async () => {
      mockTransportRegistry.getAll.mockReturnValue([
        { send: vi.fn().mockResolvedValue({ success: true, providerMessageId: "p-1" }) },
      ]);

      await worker.process(dispatched() as any);

      const events = published();
      expect(events.map((e: any) => e.type)).toEqual(["notification.delivered"]);
      expect(events[0].payload.dispatchedAt).toEqual(expect.any(String));
      expect(events[0].payload.attempt).toBe(1);
    });

    it("is published on its own once a send has been running for a second", async () => {
      vi.useFakeTimers();
      try {
        let finish: (r: unknown) => void = () => {};
        mockTransportRegistry.getAll.mockReturnValue([
          { send: vi.fn(() => new Promise((resolve) => (finish = resolve))) },
        ]);

        const run = worker.process(dispatched() as any);
        await vi.advanceTimersByTimeAsync(1_100);
        expect(published().map((e: any) => e.type)).toEqual(["notification.dispatched"]);

        finish({ success: true, providerMessageId: "p-1" });
        await vi.runAllTimersAsync();
        await run;

        const [, outcome] = published();
        expect(outcome.type).toBe("notification.delivered");
        expect(outcome.payload.dispatchedAt).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("rendering at send time", () => {
    const unrendered = (over: Record<string, unknown> = {}) => {
      const msg: any = dispatched(over);
      delete msg.event.payload.renderedContent;
      return msg;
    };

    it("renders the task's template before handing it to the transport", async () => {
      const send = vi.fn().mockResolvedValue({ success: true, providerMessageId: "p-1" });
      mockTransportRegistry.getAll.mockReturnValue([{ send }]);
      (worker as any).templateCache = {
        getCachedTemplate: vi.fn().mockResolvedValue({ content: { subject: "Hi {{name}}" } }),
      };

      await worker.process(unrendered({ templateId: "tmpl-1", templateVariables: { name: "Al" } }));

      expect(send.mock.calls[0]![0].renderedContent.content.subject).toBe("Hi Al");
    });

    it("leaves a pre-rendered task (from the AI worker) as it is", async () => {
      const send = vi.fn().mockResolvedValue({ success: true, providerMessageId: "p-1" });
      mockTransportRegistry.getAll.mockReturnValue([{ send }]);
      const getCachedTemplate = vi.fn();
      (worker as any).templateCache = { getCachedTemplate };

      await worker.process(dispatched({ templateId: "tmpl-1" }) as any);

      expect(getCachedTemplate).not.toHaveBeenCalled();
      expect(send.mock.calls[0]![0].renderedContent.content.body).toBe("Hello World");
    });

    it("gives up without sending when the template was deleted since dispatch", async () => {
      const send = vi.fn();
      mockTransportRegistry.getAll.mockReturnValue([{ send }]);
      (worker as any).templateCache = { getCachedTemplate: vi.fn().mockResolvedValue(null) };

      await expect(worker.process(unrendered({ templateId: "gone" }))).rejects.toThrow(
        NonRetryableError,
      );
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe("provider rate limiting", () => {
    const limitedTransport = (send: any) => ({ send, limits: { limit: 5, windowSeconds: 60 } });
    /** The payload parked in Postgres, which is what the scheduler releases. */
    const parkedPayload = () =>
      (worker as any).db.insert.mock.results[0].value.values.mock.calls[0][0].payload;

    it("reschedules the task instead of sending when the provider limit is hit", async () => {
      const send = vi.fn();
      mockTransportRegistry.getAll.mockReturnValue([limitedTransport(send)]);
      // The lease script grants no tokens: the window's budget is spent.
      mockRedis.leaseApiRateLimit = vi.fn().mockResolvedValue(0);

      await worker.process(dispatched() as any);

      expect(send).not.toHaveBeenCalled();
      expect(mockScheduledProducer.publish).toHaveBeenCalledTimes(1);
      const envelope = mockScheduledProducer.publish.mock.calls[0]![0];
      expect(envelope.type).toBe("notification.scheduled");
      expect(new Date(envelope.payload.scheduledAt).getTime()).toBeGreaterThan(Date.now());
      expect(parkedPayload().throttleAttemptCount).toBe(1);
    });

    it("counts each throttled attempt so the retries cannot loop forever", async () => {
      mockTransportRegistry.getAll.mockReturnValue([limitedTransport(vi.fn())]);
      mockRedis.leaseApiRateLimit = vi.fn().mockResolvedValue(0);

      await worker.process(dispatched({ throttleAttemptCount: 2 }) as any);

      expect(parkedPayload().throttleAttemptCount).toBe(3);
    });

    it("keeps waiting past maxAttempts: a deferral is not a failed attempt", async () => {
      mockTransportRegistry.getAll.mockReturnValue([limitedTransport(vi.fn())]);
      mockRedis.leaseApiRateLimit = vi.fn().mockResolvedValue(0);

      await worker.process(
        dispatched({ throttleAttemptCount: 3, deliveryOptions: { maxAttempts: 3 } }) as any,
      );

      expect(mockScheduledProducer.publish).toHaveBeenCalledTimes(1);
      expect(parkedPayload().throttleAttemptCount).toBe(4);
    });

    it("gives up once the deferrals run out", async () => {
      const send = vi.fn();
      mockTransportRegistry.getAll.mockReturnValue([limitedTransport(send)]);
      mockRedis.leaseApiRateLimit = vi.fn().mockResolvedValue(0);

      await worker.process(
        dispatched({
          throttleAttemptCount: MAX_THROTTLE_DEFERRALS,
          deliveryOptions: { maxAttempts: 3 },
        }) as any,
      );

      expect(send).not.toHaveBeenCalled();
      expect(mockScheduledProducer.publish).not.toHaveBeenCalled();
      expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
        "delivery:failed",
        "123e4567-e89b-12d3-a456-426614174001",
        "provider throttle exceeded",
        "email",
        "123e4567-e89b-12d3-a456-426614174000",
      );
    });

    it("falls back to another channel instead of dropping an exhausted task", async () => {
      mockTransportRegistry.getAll.mockReturnValue([limitedTransport(vi.fn())]);
      mockRedis.leaseApiRateLimit = vi.fn().mockResolvedValue(0);

      await worker.process(
        dispatched({
          throttleAttemptCount: MAX_THROTTLE_DEFERRALS,
          deliveryOptions: { maxAttempts: 3 },
          fallbackChain: ["sms"],
          recipient,
        }) as any,
      );

      expect(mockEnrichedProducers.normal.publish).toHaveBeenCalledTimes(1);
      expect(mockEnrichedProducers.normal.publish.mock.calls[0]![0].payload.channel).toBe("sms");
    });

    it("sends normally when the provider limit has room", async () => {
      const send = vi.fn().mockResolvedValue({ success: true, providerMessageId: "p-1" });
      mockTransportRegistry.getAll.mockReturnValue([limitedTransport(send)]);
      mockRedis.leaseApiRateLimit = vi.fn().mockResolvedValue(1);

      await worker.process(dispatched() as any);

      expect(send).toHaveBeenCalledTimes(1);
      expect(mockScheduledProducer.publish).not.toHaveBeenCalled();
    });
  });

  describe("push", () => {
    const pushTask = (over: Record<string, unknown> = {}) =>
      dispatched({ channel: "push", destination: "device-token-1", ...over });

    it("deactivates a token the provider rejects as invalid", async () => {
      mockTransportRegistry.getAll.mockReturnValue([
        { send: vi.fn().mockResolvedValue({ success: false, invalidToken: true }) },
      ]);

      await expect(worker.process(pushTask() as any)).rejects.toThrow("invalid token");

      expect(mockDeviceRepo.deactivate).toHaveBeenCalledWith(
        "123e4567-e89b-12d3-a456-426614174000",
        "usr-1",
        "push",
        "device-token-1",
      );
      expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
        "delivery:failed",
        "123e4567-e89b-12d3-a456-426614174001",
        "invalidToken",
        "push",
        "123e4567-e89b-12d3-a456-426614174000",
      );
    });

    it("rolls over to the next channel after an invalid token, rather than throwing", async () => {
      mockTransportRegistry.getAll.mockReturnValue([
        { send: vi.fn().mockResolvedValue({ success: false, invalidToken: true }) },
      ]);

      await worker.process(pushTask({ fallbackChain: ["email"], recipient }) as any);

      expect(mockDeviceRepo.deactivate).toHaveBeenCalled();
      expect(mockEnrichedProducers.normal.publish).toHaveBeenCalledTimes(1);
    });

    it("reports a delivered push with the provider's message id", async () => {
      mockTransportRegistry.getAll.mockReturnValue([
        { send: vi.fn().mockResolvedValue({ success: true, providerMessageId: "fcm-1" }) },
      ]);

      await worker.process(pushTask() as any);

      expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
        "delivery:delivered",
        "123e4567-e89b-12d3-a456-426614174001",
        "fcm-1",
        "push",
        "123e4567-e89b-12d3-a456-426614174000",
      );
    });

    it("stops at the first transport that accepts the token", async () => {
      const first = vi.fn().mockResolvedValue({ success: true, providerMessageId: "fcm-1" });
      const second = vi.fn();
      mockTransportRegistry.getAll.mockReturnValue([{ send: first }, { send: second }]);

      await worker.process(pushTask() as any);

      expect(second).not.toHaveBeenCalled();
    });
  });

  /** Pins the exact outcome events each path publishes, push and otherwise. */
  describe("outcome events", () => {
    const ids = {
      projectId: "123e4567-e89b-12d3-a456-426614174000",
      taskId: "123e4567-e89b-12d3-a456-426614174001",
      enrichedEventId: "123e4567-e89b-12d3-a456-426614174002",
    };
    const tags = {
      templateId: "order-shipped",
      workflowInstanceId: "123e4567-e89b-12d3-a456-426614174005",
      campaignId: "spring-sale",
    };
    const task = (over: Record<string, unknown> = {}) => dispatched({ ...tags, ...over });
    const pushTask = (over: Record<string, unknown> = {}) =>
      task({ channel: "push", destination: "device-token-1", ...over });
    const sendsBack = (res: unknown) =>
      mockTransportRegistry.getAll.mockReturnValue([{ send: vi.fn().mockResolvedValue(res) }]);
    /** The one event the worker handed to its batch publisher, and when. */
    const added = (spy: any) => {
      expect(spy).toHaveBeenCalledTimes(1);
      return { event: spy.mock.calls[0][0], order: spy.mock.invocationCallOrder[0] };
    };
    const inFlight = { attempt: 3, dispatchedAt: expect.any(String) };

    it("push delivered without a provider id: push-success, logged before the event", async () => {
      sendsBack({ success: true });
      const spy = vi.spyOn(worker["eventProcessor"], "add");

      await worker.process(pushTask() as any);

      const { event, order } = added(spy);
      expect(event.type).toBe("notification.delivered");
      expect(event.payload).toStrictEqual({
        ...ids,
        channel: "push",
        deliveredAt: expect.any(String),
        providerMessageId: "push-success",
        ...tags,
        attempt: 1,
        dispatchedAt: expect.any(String),
      });
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { taskId: ids.taskId, messageId: "push-success" },
        "push delivered",
      );
      expect(mockLogger.debug.mock.invocationCallOrder[0]).toBeLessThan(order);
    });

    it("email delivered without a provider id: success, logged after the event", async () => {
      sendsBack({ success: true });
      const spy = vi.spyOn(worker["eventProcessor"], "add");

      await worker.process(task() as any);

      const { event, order } = added(spy);
      expect(event.type).toBe("notification.delivered");
      expect(event.payload).toStrictEqual({
        ...ids,
        channel: "email",
        deliveredAt: expect.any(String),
        providerMessageId: "success",
        ...tags,
        attempt: 1,
        dispatchedAt: expect.any(String),
      });
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { taskId: ids.taskId, channel: "email", messageId: undefined },
        "notification delivered",
      );
      expect(mockLogger.debug.mock.invocationCallOrder[0]).toBeGreaterThan(order);
    });

    it("push failure carries recipientId and push_failure, logged before the event", async () => {
      sendsBack({ success: false, error: "apns down" });
      const spy = vi.spyOn(worker["eventProcessor"], "add");

      await expect(worker.process(pushTask({ deliveryAttemptCount: 2 }) as any)).rejects.toThrow(
        "apns down",
      );

      const { event, order } = added(spy);
      expect(event.type).toBe("notification.failed");
      expect(event.payload).toStrictEqual({
        ...ids,
        recipientId: "usr-1",
        channel: "push",
        failureReason: "apns down",
        failureCode: "push_failure",
        retryable: false,
        ...inFlight,
        ...tags,
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { taskId: ids.taskId, error: "apns down" },
        "push delivery failed",
      );
      expect(mockLogger.warn.mock.invocationCallOrder.at(-1)).toBeLessThan(order);
      expect(mockGlobalEmitter.emit.mock.invocationCallOrder[0]).toBeLessThan(order);
    });

    it("email failure leaves out recipientId and uses provider_error, logged after the event", async () => {
      sendsBack({ success: false, error: "mailbox full" });
      const spy = vi.spyOn(worker["eventProcessor"], "add");

      await expect(worker.process(task({ deliveryAttemptCount: 2 }) as any)).rejects.toThrow(
        "mailbox full",
      );

      const { event, order } = added(spy);
      expect(event.type).toBe("notification.failed");
      expect(event.payload).toStrictEqual({
        ...ids,
        channel: "email",
        failureReason: "mailbox full",
        failureCode: "provider_error",
        retryable: false,
        ...inFlight,
        ...tags,
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { taskId: ids.taskId, channel: "email", error: "mailbox full" },
        "delivery failed completely across providers",
      );
      expect(mockLogger.warn.mock.invocationCallOrder.at(-1)).toBeGreaterThan(order);
      expect(mockGlobalEmitter.emit.mock.invocationCallOrder[0]).toBeGreaterThan(order);
    });

    it("an invalid push token fails with recipientId, invalid_token and push_failure", async () => {
      sendsBack({ success: false, invalidToken: true });
      const spy = vi.spyOn(worker["eventProcessor"], "add");

      await expect(worker.process(pushTask() as any)).rejects.toThrow("invalid token");

      expect(added(spy).event.payload).toStrictEqual({
        ...ids,
        recipientId: "usr-1",
        channel: "push",
        failureReason: "invalid_token",
        failureCode: "push_failure",
        retryable: false,
        attempt: 1,
        dispatchedAt: expect.any(String),
        ...tags,
      });
    });

    it("an invalid token outside push is an ordinary provider failure", async () => {
      sendsBack({ success: false, invalidToken: true, error: "bad address" });
      const spy = vi.spyOn(worker["eventProcessor"], "add");

      await expect(worker.process(task({ deliveryAttemptCount: 2 }) as any)).rejects.toThrow(
        "bad address",
      );

      expect(mockDeviceRepo.deactivate).not.toHaveBeenCalled();
      expect(added(spy).event.payload.failureCode).toBe("provider_error");
    });

    it("no transport fails with recipientId and no dispatched entry", async () => {
      mockTransportRegistry.getAll.mockReturnValue([]);
      const spy = vi.spyOn(worker["eventProcessor"], "add");

      await worker.process(task() as any);

      expect(added(spy).event.payload).toStrictEqual({
        ...ids,
        recipientId: "usr-1",
        channel: "email",
        failureReason: "no transport registered for channel",
        failureCode: "no_transport",
        retryable: false,
        attempt: 1,
        ...tags,
      });
    });

    it("running out of throttle deferrals fails with recipientId and no dispatched entry", async () => {
      mockTransportRegistry.getAll.mockReturnValue([
        { send: vi.fn(), limits: { limit: 5, windowSeconds: 60 } },
      ]);
      mockRedis.leaseApiRateLimit = vi.fn().mockResolvedValue(0);
      const spy = vi.spyOn(worker["eventProcessor"], "add");

      await worker.process(task({ throttleAttemptCount: MAX_THROTTLE_DEFERRALS }) as any);

      expect(added(spy).event.payload).toStrictEqual({
        ...ids,
        recipientId: "usr-1",
        channel: "email",
        failureReason: "provider rate limit max attempts exceeded",
        failureCode: "provider_throttle_exceeded",
        retryable: false,
        attempt: 1,
        ...tags,
      });
    });
  });

  // ── Circuit breaker ───────────────────────────────────────────────────────

  /**
   * The worker keys one breaker per provider: its channel and class name,
   * numbered when a channel has two of one class. These transports are real
   * classes so the keys read the way production ones do.
   */
  describe("circuit breaker", () => {
    class FlakyTransport {
      send = vi.fn().mockRejectedValue(new Error("Provider down"));
    }
    class HealthyTransport {
      send = vi.fn().mockResolvedValue({ success: true, providerMessageId: "ok-1" });
    }

    /** One delivery, absorbing the NonRetryableError a chainless task ends in. */
    const attempt = (msg: unknown) => worker.process(msg as any).catch((e) => e);

    let nowSpy: ReturnType<typeof vi.spyOn> | undefined;
    afterEach(() => {
      nowSpy?.mockRestore();
      nowSpy = undefined;
    });

    it("stops calling a transport once five consecutive failures trip the breaker", async () => {
      const flaky = new FlakyTransport();
      mockTransportRegistry.getAll.mockReturnValue([flaky]);

      for (let i = 0; i < 5; i++) await attempt(dispatched());
      expect(flaky.send).toHaveBeenCalledTimes(5);

      await attempt(dispatched());

      // The sixth task never reached the provider — that is the whole point.
      expect(flaky.send).toHaveBeenCalledTimes(5);
    });

    it("parks a task an open breaker turned away for a later attempt", async () => {
      const flaky = new FlakyTransport();
      mockTransportRegistry.getAll.mockReturnValue([flaky]);

      for (let i = 0; i < 5; i++) await attempt(dispatched());
      mockScheduledProducer.publish.mockClear();
      const err = await attempt(dispatched());

      // An open circuit says the provider is down, not that the message is bad.
      expect(err).toBeUndefined();
      expect(flaky.send).toHaveBeenCalledTimes(5);
      expect(mockScheduledProducer.publish).toHaveBeenCalledTimes(1);
      expect(mockGlobalEmitter.emit).not.toHaveBeenCalledWith(
        "delivery:failed",
        expect.anything(),
        "Circuit breaker is OPEN",
        expect.anything(),
        expect.anything(),
      );
    });

    it("reports an open breaker on a task's last attempt as a delivery failure", async () => {
      mockTransportRegistry.getAll.mockReturnValue([new FlakyTransport()]);

      for (let i = 0; i < 5; i++) await attempt(dispatched());
      const err = await attempt(dispatched({ deliveryAttemptCount: 2 }));

      // Out of attempts, a short-circuit is a delivery failure like any other:
      // it must reach the emitter and come back as NonRetryableError.
      expect(err).toBeInstanceOf(NonRetryableError);
      expect((err as Error).message).toBe("Circuit breaker is OPEN");
      expect(mockGlobalEmitter.emit).toHaveBeenLastCalledWith(
        "delivery:failed",
        "123e4567-e89b-12d3-a456-426614174001",
        "Circuit breaker is OPEN",
        "email",
        "123e4567-e89b-12d3-a456-426614174000",
      );
    });

    it("keeps one provider's breaker off another's, so a healthy provider still delivers", async () => {
      const flaky = new FlakyTransport();
      const healthy = new HealthyTransport();
      mockTransportRegistry.getAll.mockReturnValue([flaky, healthy]);

      for (let i = 0; i < 6; i++) await attempt(dispatched());

      expect(flaky.send).toHaveBeenCalledTimes(5); // tripped, then skipped
      expect(healthy.send).toHaveBeenCalledTimes(6); // never affected
      expect(mockGlobalEmitter.emit).toHaveBeenLastCalledWith(
        "delivery:delivered",
        "123e4567-e89b-12d3-a456-426614174001",
        "ok-1",
        "email",
        "123e4567-e89b-12d3-a456-426614174000",
      );
    });

    it("keeps a channel's breaker off the same transport on another channel", async () => {
      const flaky = new FlakyTransport();
      mockTransportRegistry.getAll.mockReturnValue([flaky]);

      for (let i = 0; i < 6; i++) await attempt(dispatched());
      expect(flaky.send).toHaveBeenCalledTimes(5); // email is now open

      await attempt(dispatched({ channel: "sms", destination: "+15551234567" }));

      // sms keys a different breaker, so it gets its own five attempts.
      expect(flaky.send).toHaveBeenCalledTimes(6);
    });

    it("resets the count on a success, so intermittent failures never trip it", async () => {
      const intermittent = new FlakyTransport();
      intermittent.send
        .mockRejectedValue(new Error("Provider down"))
        .mockResolvedValueOnce({ success: true, providerMessageId: "ok-2" });
      mockTransportRegistry.getAll.mockReturnValue([intermittent]);

      // One success on the very first call, then eight straight failures. The
      // threshold counts consecutive failures, so four-then-four never trips.
      await attempt(dispatched());
      for (let i = 0; i < 4; i++) await attempt(dispatched());
      intermittent.send.mockResolvedValueOnce({ success: true, providerMessageId: "ok-3" });
      await attempt(dispatched());
      for (let i = 0; i < 4; i++) await attempt(dispatched());

      expect(intermittent.send).toHaveBeenCalledTimes(10);
    });

    it("lets a single probe through once the reset window has passed", async () => {
      const flaky = new FlakyTransport();
      mockTransportRegistry.getAll.mockReturnValue([flaky]);

      for (let i = 0; i < 6; i++) await attempt(dispatched());
      expect(flaky.send).toHaveBeenCalledTimes(5);

      // The provider recovers, but the breaker holds it out for a full 30s.
      flaky.send.mockResolvedValue({ success: true, providerMessageId: "recovered" });
      await attempt(dispatched());
      expect(flaky.send).toHaveBeenCalledTimes(5);

      nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
      await attempt(dispatched());

      expect(flaky.send).toHaveBeenCalledTimes(6);
      expect(mockGlobalEmitter.emit).toHaveBeenLastCalledWith(
        "delivery:delivered",
        "123e4567-e89b-12d3-a456-426614174001",
        "recovered",
        "email",
        "123e4567-e89b-12d3-a456-426614174000",
      );
    });
  });

  // ── Fallback chain exhaustion ─────────────────────────────────────────────

  /**
   * Rolling over to the next channel is well covered; running *out* of channels
   * is the other half. Every path here has to end in NonRetryableError, because
   * a retryable throw would send an already-exhausted task around again.
   */
  describe("fallback chain exhaustion", () => {
    /** A task on the last of its attempts, so a failure is final. */
    const lastAttempt = (payload: Record<string, unknown> = {}) =>
      dispatched({ deliveryAttemptCount: 2, ...payload });
    const allProvidersFail = () =>
      mockTransportRegistry.getAll.mockReturnValue([
        { send: vi.fn().mockRejectedValue(new Error("Provider down")) },
      ]);

    it("ends the task when the only channel fails with nothing to fall back to", async () => {
      allProvidersFail();

      await expect(worker.process(lastAttempt() as any)).rejects.toBeInstanceOf(NonRetryableError);

      expect(mockEnrichedProducers.normal.publish).not.toHaveBeenCalled();
      expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
        "delivery:failed",
        "123e4567-e89b-12d3-a456-426614174001",
        "Provider down",
        "email",
        "123e4567-e89b-12d3-a456-426614174000",
      );
    });

    it("treats an empty fallbackChain as no chain at all", async () => {
      allProvidersFail();

      await expect(
        worker.process(lastAttempt({ fallbackChain: [], recipient }) as any),
      ).rejects.toBeInstanceOf(NonRetryableError);

      expect(mockEnrichedProducers.normal.publish).not.toHaveBeenCalled();
    });

    it("does not roll over when a chain is present but the recipient is missing", async () => {
      allProvidersFail();

      // The rollover rebuilds an enriched payload, which needs the recipient.
      // Without one the chain is inert, so the task has to fail terminally
      // rather than look like it was handed on.
      await expect(
        worker.process(lastAttempt({ fallbackChain: ["sms", "push"] }) as any),
      ).rejects.toBeInstanceOf(NonRetryableError);

      expect(mockEnrichedProducers.normal.publish).not.toHaveBeenCalled();
    });

    it("clears the chain on the final hop instead of passing an empty array on", async () => {
      allProvidersFail();

      await worker.process(lastAttempt({ fallbackChain: ["sms"], recipient }) as any);

      const published = mockEnrichedProducers.normal.publish.mock.calls[0]![0];
      expect(published.payload.channel).toBe("sms");
      // Not [] — an empty array would read as "a chain exists" to the next hop.
      expect(published.payload.fallbackChain).toBeUndefined();
    });

    it("stops at the end of the chain rather than rolling over forever", async () => {
      allProvidersFail();

      // Hop one: email fails and hands the task to sms with the chain spent.
      await worker.process(lastAttempt({ fallbackChain: ["sms"], recipient }) as any);
      const next = mockEnrichedProducers.normal.publish.mock.calls[0]![0].payload;
      expect(next.channel).toBe("sms");

      // Hop two: that sms task fails too, and now there is nowhere left to go.
      mockEnrichedProducers.normal.publish.mockClear();
      await expect(
        worker.process(
          lastAttempt({
            channel: next.channel,
            fallbackChain: next.fallbackChain,
            destination: "+15551234567",
            recipient,
          }) as any,
        ),
      ).rejects.toBeInstanceOf(NonRetryableError);

      expect(mockEnrichedProducers.normal.publish).not.toHaveBeenCalled();
    });
  });
});

describe("DeliveryWorker", () => {
  let worker: DeliveryWorker;
  let mockTransportRegistry: any;
  let mockIdempotency: any;
  let mockRedis: any;
  let mockScheduledProducer: any;
  let mockEnrichedProducers: any;
  let mockContactRepo: any;
  let mockEventsProducer: any;
  let mockGlobalEmitter: any;
  let mockDb: any;

  beforeEach(async () => {
    mockTransportRegistry = {
      getAll: vi.fn().mockReturnValue([]),
    };
    mockIdempotency = {
      checkAndMark: vi.fn().mockResolvedValue(true),
      markProcessed: vi.fn().mockResolvedValue(true),
      // The worker releases its claim with `unmark(...).catch(...)`, so a stub
      // that returns undefined turns every failure path into a TypeError and
      // hides the error the test is actually about.
      unmark: vi.fn().mockResolvedValue(undefined),
    };
    mockRedis = {
      leaseApiRateLimit: vi.fn().mockResolvedValue(1), // Default to allowed
    };
    mockScheduledProducer = { publish: vi.fn() };
    mockEnrichedProducers = { normal: { publish: vi.fn() } };
    mockContactRepo = { deactivate: vi.fn() };
    mockEventsProducer = { publishBatch: vi.fn() };
    mockGlobalEmitter = { emit: vi.fn() };
    mockDb = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({ catch: vi.fn() }),
          onConflictDoNothing: vi.fn().mockReturnValue({ catch: vi.fn() }),
        }),
      }),
    };

    vi.spyOn(registry, "safeParsePayload").mockImplementation(
      (type, payload) =>
        ({
          success: true,
          data: payload,
        }) as any,
    );

    worker = new DeliveryWorker({
      consumer: { ack: vi.fn(), nack: vi.fn() } as any,
      pendingScanner: {} as any,
      logger: {
        child: vi.fn().mockReturnThis(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as any,
      maxRetriesBeforeDlq: 5,
      transportRegistry: mockTransportRegistry,
      idempotency: mockIdempotency,
      redis: mockRedis,
      scheduledProducer: mockScheduledProducer,
      enrichedProducers: mockEnrichedProducers,
      contactRepo: mockContactRepo,
      eventsProducer: mockEventsProducer,
      globalEmitter: mockGlobalEmitter,
      db: mockDb,
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (worker) await worker.stop();
  });

  it("falls back to next channel on transport failure", async () => {
    const mockTransport = {
      send: vi.fn().mockResolvedValue({ success: false, error: "Mock failure" }),
    };
    mockTransportRegistry.getAll.mockReturnValue([mockTransport]);

    const msg = {
      id: "msg-del-2",
      event: {
        payload: {
          taskId: "task-1",
          projectId: "proj-1",
          enrichedEventId: "evt-1",
          recipientId: "usr-1",
          channel: "email",
          destination: "test@example.com",
          priority: "normal",
          deliveryAttemptCount: 2,
          fallbackChain: ["sms"],
          recipient: { phone: "+1234567890" },
        },
        metadata: { traceId: "trace-1" },
      },
    };

    // Allow vitest to fail on throw so we can see the exact error.
    await worker.process(msg as any);

    expect(mockEnrichedProducers.normal.publish).toHaveBeenCalledTimes(1);
    const published = mockEnrichedProducers.normal.publish.mock.calls[0][0];
    expect(published.type).toBe("notification.enriched");
    expect(published.payload.channel).toBe("sms"); // The fallback channel
  });

  it("handles circuit breaker open without fallback by delaying message", async () => {
    const mockTransport = {
      send: vi.fn().mockRejectedValue(new Error("Circuit breaker is OPEN")),
    };
    mockTransportRegistry.getAll.mockReturnValue([mockTransport]);

    const msg = {
      id: "msg-del-cb",
      event: {
        payload: {
          taskId: "task-cb",
          projectId: "proj-1",
          enrichedEventId: "evt-1",
          recipientId: "usr-1",
          channel: "email",
          destination: "test@example.com",
          priority: "normal",
          // no fallbackChain
        },
        metadata: { traceId: "trace-cb" },
      },
    };

    // Parked through the scheduler for a later attempt, not failed.
    await expect(worker.process(msg as any)).resolves.toBeUndefined();
    expect(mockScheduledProducer.publish).toHaveBeenCalledTimes(1);
    expect(mockIdempotency.markProcessed).not.toHaveBeenCalled();
    // Ensure it was NOT fallback-published
    expect(mockEnrichedProducers.normal.publish).not.toHaveBeenCalled();
  });

  it("handles provider transport timeout via AbortController and falls over", async () => {
    const mockTransport = {
      send: vi.fn().mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Transport timeout after 10000ms")), 50);
          }),
      ),
    };
    mockTransportRegistry.getAll.mockReturnValue([mockTransport]);

    const msg = {
      id: "msg-timeout",
      event: {
        payload: {
          taskId: "task-timeout",
          projectId: "proj-1",
          enrichedEventId: "evt-1",
          recipientId: "usr-1",
          channel: "email",
          destination: "test@example.com",
          priority: "normal",
          deliveryAttemptCount: 2,
          fallbackChain: ["sms"],
          recipient: { phone: "+15551234567" },
        },
        metadata: { traceId: "trace-timeout" },
      },
    };

    await worker.process(msg as any);

    // Transport timeout should trigger fallback publication
    expect(mockEnrichedProducers.normal.publish).toHaveBeenCalledTimes(1);
    const published = mockEnrichedProducers.normal.publish.mock.calls[0][0];
    expect(published.payload.channel).toBe("sms");
  });

  it("handles outboxUpdateProcessor database failures gracefully without uncaught rejection", async () => {
    const processor = (worker as any).outboxUpdateProcessor;
    expect(processor).toBeDefined();

    // Mock the flush fn throwing an error
    const updateSpy = vi.fn().mockRejectedValue(new Error("DB connection terminated"));
    mockDb.update = vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: updateSpy }) });

    // Adding an update item to the processor should flush without crashing the worker process
    expect(() => {
      void processor.add({
        taskId: "task-err",
        status: "delivered",
        providerMessageId: "prov-1",
        attempt: 1,
      });
    }).not.toThrow();
  });

  it("publishes notification.failed event and marks failure when no transport is registered", async () => {
    mockTransportRegistry.getAll.mockReturnValue([]);

    const msg = {
      id: "msg-no-trans",
      event: {
        payload: {
          taskId: "task-no-trans",
          projectId: "proj-1",
          enrichedEventId: "evt-1",
          recipientId: "usr-1",
          channel: "email",
          destination: "test@example.com",
          priority: "normal",
        },
        metadata: { traceId: "trace-no-trans" },
      },
    };

    await worker.process(msg as any);
    expect(mockGlobalEmitter.emit).toHaveBeenCalledWith(
      "delivery:failed",
      "task-no-trans",
      "no transport",
      "email",
      "proj-1",
    );
  });

  it("throws NonRetryableError when invalid push token cannot be delivered and has no fallback", async () => {
    const mockPushTransport = {
      send: vi
        .fn()
        .mockResolvedValue({ success: false, error: "invalid token", invalidToken: true }),
    };
    mockTransportRegistry.getAll.mockReturnValue([mockPushTransport]);

    const msg = {
      id: "msg-push-bad",
      event: {
        payload: {
          taskId: "task-push-bad",
          projectId: "proj-1",
          enrichedEventId: "evt-1",
          recipientId: "usr-1",
          channel: "push",
          priority: "normal",
          recipient: { pushToken: "bad_token" },
        },
        metadata: { traceId: "trace-push-bad" },
      },
    };

    const err = await worker.process(msg as any).catch((e) => e);
    expect(err).toBeDefined();
    expect(err.nonRetryable).toBe(true);
    expect(err.message).toContain("invalid token");
  });

  it("throws NonRetryableError when all providers fail without fallback", async () => {
    const mockTransport = {
      send: vi.fn().mockResolvedValue({ success: false, error: "Account suspended" }),
    };
    mockTransportRegistry.getAll.mockReturnValue([mockTransport]);

    const msg = {
      id: "msg-all-fail",
      event: {
        payload: {
          taskId: "task-all-fail",
          deliveryAttemptCount: 2,
          projectId: "proj-1",
          enrichedEventId: "evt-1",
          recipientId: "usr-1",
          channel: "email",
          destination: "test@example.com",
          priority: "normal",
        },
        metadata: { traceId: "trace-all-fail" },
      },
    };

    const err = await worker.process(msg as any).catch((e) => e);
    expect(err).toBeDefined();
    expect(err.nonRetryable).toBe(true);
    expect(err.message).toContain("Account suspended");
  });
});
