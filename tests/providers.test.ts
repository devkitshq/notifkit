import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ResendTransport } from "../packages/provider-resend/src/index.js";
import { FcmTransport } from "../packages/provider-fcm/src/index.js";
import { ConsoleTransport } from "../packages/provider-console/src/index.js";

// Mock Resend SDK
const mockSendEmail = vi.fn();
vi.mock("resend", () => {
  return {
    Resend: vi.fn().mockImplementation(() => {
      return {
        emails: {
          send: mockSendEmail,
        },
      };
    }),
  };
});

// Mock Firebase Admin SDK
const mockSendPush = vi.fn();
vi.mock("firebase-admin/app", () => {
  return {
    initializeApp: vi.fn().mockReturnValue({}),
    getApp: vi.fn().mockImplementation(() => {
      throw new Error("App not initialized");
    }),
    cert: vi.fn(),
  };
});
vi.mock("firebase-admin/messaging", () => {
  return {
    getMessaging: vi.fn().mockImplementation(() => {
      return {
        send: mockSendPush,
      };
    }),
  };
});

describe("ResendTransport (Email Provider)", () => {
  beforeEach(() => {
    mockSendEmail.mockReset();
  });

  it("sends an email successfully via Resend SDK", async () => {
    mockSendEmail.mockResolvedValueOnce({
      data: { id: "email-resend-id-123" },
      error: null,
    });

    const transport = new ResendTransport({
      apiKey: "test-api-key",
      from: "onboarding@resend.dev",
    });

    const task: any = {
      taskId: "task-uuid-123",
      destination: "recipient@example.com",
      renderedContent: {
        content: {
          subject: "Welcome Alice",
          body: "Hello Alice",
          htmlBody: "<h1>Hello Alice</h1>",
        },
      },
    };

    const result = await transport.send(task);

    expect(mockSendEmail).toHaveBeenCalledWith({
      from: "onboarding@resend.dev",
      to: "recipient@example.com",
      subject: "Welcome Alice",
      html: "<h1>Hello Alice</h1>",
      text: "Hello Alice",
    });
    expect(result).toEqual({
      success: true,
      providerMessageId: "email-resend-id-123",
    });
  });

  it("handles email sending failures from Resend SDK", async () => {
    mockSendEmail.mockResolvedValueOnce({
      data: null,
      error: { message: "Invalid API key" },
    });

    const transport = new ResendTransport({
      apiKey: "test-api-key",
      from: "onboarding@resend.dev",
    });

    const task: any = {
      taskId: "task-uuid-123",
      destination: "recipient@example.com",
      renderedContent: {
        content: {
          subject: "Welcome Alice",
          body: "Hello Alice",
          htmlBody: "<h1>Hello Alice</h1>",
        },
      },
    };

    const result = await transport.send(task);

    expect(result).toEqual({
      success: false,
      error: "Invalid API key",
    });
  });

  describe("per-template sender", () => {
    const baseTask = (content: Record<string, unknown>): any => ({
      taskId: "task-uuid-123",
      destination: "recipient@example.com",
      renderedContent: { content: { subject: "S", body: "B", htmlBody: "<p>B</p>", ...content } },
    });

    const transport = () => new ResendTransport({ apiKey: "k", from: "default@corp.com" });

    beforeEach(() => {
      mockSendEmail.mockResolvedValue({ data: { id: "id" }, error: null });
    });

    it("uses the constructor from when the template names none", async () => {
      await transport().send(baseTask({}));
      expect(mockSendEmail.mock.calls[0]![0].from).toBe("default@corp.com");
    });

    it("prefers a from named by the template", async () => {
      await transport().send(baseTask({ from: "marketing@corp.com" }));
      expect(mockSendEmail.mock.calls[0]![0].from).toBe("marketing@corp.com");
    });

    it("keeps a display-name form intact", async () => {
      await transport().send(baseTask({ from: "Acme Offers <marketing@corp.com>" }));
      expect(mockSendEmail.mock.calls[0]![0].from).toBe("Acme Offers <marketing@corp.com>");
    });

    it("passes replyTo through only when the template sets it", async () => {
      await transport().send(baseTask({ replyTo: "hello@corp.com" }));
      expect(mockSendEmail.mock.calls[0]![0].replyTo).toBe("hello@corp.com");

      mockSendEmail.mockClear();
      await transport().send(baseTask({}));
      expect(mockSendEmail.mock.calls[0]![0]).not.toHaveProperty("replyTo");
    });

    // A non-string reaching the provider as "123" fails the send with an error
    // that names neither the template nor the field.
    it.each([
      ["a number", 123],
      ["an empty string", ""],
      ["null", null],
      ["an object", { address: "x@y.com" }],
    ])("falls back to the default when from is %s", async (_label, value) => {
      await transport().send(baseTask({ from: value }));
      expect(mockSendEmail.mock.calls[0]![0].from).toBe("default@corp.com");
    });

    it("still carries the unsubscribe headers alongside a template from", async () => {
      const task = baseTask({ from: "marketing@corp.com" });
      task.deliveryOptions = { headers: { "List-Unsubscribe": "<https://x/u?t=1>" } };

      await transport().send(task);

      const sent = mockSendEmail.mock.calls[0]![0];
      expect(sent.from).toBe("marketing@corp.com");
      expect(sent.headers).toEqual({ "List-Unsubscribe": "<https://x/u?t=1>" });
    });
  });
});

describe("FcmTransport (Push Provider)", () => {
  beforeEach(() => {
    mockSendPush.mockReset();
  });

  it("sends a push notification successfully via Firebase Admin SDK", async () => {
    mockSendPush.mockResolvedValueOnce("fcm-message-id-123");

    const transport = new FcmTransport({
      serviceAccountJson: JSON.stringify({ project_id: "test-project" }),
    });

    const task: any = {
      taskId: "task-uuid-456",
      enrichedEventId: "enriched-evt-789",
      destination: "fcm-device-token-abc",
      priority: "high",
      renderedContent: {
        content: {
          subject: "New Alert",
          body: "You have a new message",
        },
      },
    };

    const result = await transport.send(task);

    expect(mockSendPush).toHaveBeenCalledWith({
      token: "fcm-device-token-abc",
      notification: {
        title: "New Alert",
        body: "You have a new message",
      },
      data: {
        eventId: "enriched-evt-789",
        taskId: "task-uuid-456",
      },
      android: {
        priority: "high",
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
            badge: 1,
          },
        },
      },
    });
    expect(result).toEqual({
      success: true,
      providerMessageId: "fcm-message-id-123",
    });
  });

  it("handles push token registration failures and marks them as invalid", async () => {
    const fcmError = new Error("Requested entity was not found.");
    (fcmError as any).code = "messaging/registration-token-not-registered";
    mockSendPush.mockRejectedValueOnce(fcmError);

    const transport = new FcmTransport({
      serviceAccountJson: JSON.stringify({ project_id: "test-project" }),
    });

    const task: any = {
      taskId: "task-uuid-456",
      enrichedEventId: "enriched-evt-789",
      destination: "invalid-token",
      priority: "normal",
      renderedContent: {
        content: {
          subject: "New Alert",
          body: "You have a new message",
        },
      },
    };

    const result = await transport.send(task);

    expect(result).toEqual({
      success: false,
      invalidToken: true,
      error: "Requested entity was not found.",
    });
  });
});

import { Webhook } from "svix";

describe("ResendTransport (Webhooks)", () => {
  const webhookSecret = `whsec_${Buffer.from("notifkit-webhook-test-secret").toString("base64")}`;

  /** Produce a body + headers that svix will accept, the way Resend sends them. */
  function sign(payload: unknown) {
    const rawBody = JSON.stringify(payload);
    const msgId = "msg_2abc";
    const timestamp = new Date();

    return {
      rawBody,
      headers: {
        "svix-id": msgId,
        "svix-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
        "svix-signature": new Webhook(webhookSecret).sign(msgId, timestamp, rawBody),
      } as Record<string, string>,
    };
  }

  const bounced = {
    type: "email.bounced",
    created_at: "2026-01-16T18:36:21.000Z",
    data: { email_id: "email-resend-id-123" },
  };

  it("exposes verifyWebhook, without which the mounted route answers 501", () => {
    const transport = new ResendTransport({
      apiKey: "test-api-key",
      from: "onboarding@resend.dev",
      webhookSecret,
    });

    // The API only mounts a webhook route for a transport carrying all three.
    expect(transport.webhookPath).toBe("/webhooks/resend");
    expect(typeof transport.verifyWebhook).toBe("function");
    expect(typeof transport.parseWebhook).toBe("function");
  });

  it("accepts a correctly signed payload", () => {
    const transport = new ResendTransport({
      apiKey: "test-api-key",
      from: "onboarding@resend.dev",
      webhookSecret,
    });
    const { rawBody, headers } = sign(bounced);

    expect(transport.verifyWebhook(rawBody, headers)).toBe(true);
  });

  it("rejects a payload whose body was tampered with after signing", () => {
    const transport = new ResendTransport({
      apiKey: "test-api-key",
      from: "onboarding@resend.dev",
      webhookSecret,
    });
    const { headers } = sign(bounced);

    const forged = JSON.stringify({ ...bounced, data: { email_id: "someone-elses-message" } });
    expect(transport.verifyWebhook(forged, headers)).toBe(false);
  });

  it("rejects everything when no webhookSecret is configured", () => {
    const transport = new ResendTransport({
      apiKey: "test-api-key",
      from: "onboarding@resend.dev",
    });
    const { rawBody, headers } = sign(bounced);

    expect(transport.verifyWebhook(rawBody, headers)).toBe(false);
  });

  it("maps a verified provider event onto a notifkit status", async () => {
    const transport = new ResendTransport({
      apiKey: "test-api-key",
      from: "onboarding@resend.dev",
      webhookSecret,
    });
    const { rawBody, headers } = sign(bounced);

    const events = await transport.parseWebhook(JSON.parse(rawBody), rawBody, headers);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      providerMessageId: "email-resend-id-123",
      status: "bounced",
    });
  });

  it("ignores untracked event types", async () => {
    const transport = new ResendTransport({
      apiKey: "test-api-key",
      from: "onboarding@resend.dev",
      webhookSecret,
    });
    const { rawBody, headers } = sign({
      type: "email.delivered",
      data: { email_id: "email-resend-id-123" },
    });

    await expect(transport.parseWebhook(JSON.parse(rawBody), rawBody, headers)).resolves.toEqual(
      [],
    );
  });

  it("does not trust a body that fails verification, even if it is well formed", async () => {
    const transport = new ResendTransport({
      apiKey: "test-api-key",
      from: "onboarding@resend.dev",
      webhookSecret,
    });

    // Valid-looking payload, signature for a different body.
    const { headers } = sign({ type: "email.opened", data: { email_id: "other" } });

    await expect(
      transport.parseWebhook(bounced, JSON.stringify(bounced), headers),
    ).resolves.toEqual([]);
  });
});

import { transportRegistry } from "@/transport/index.js";

describe("TransportRegistry", () => {
  it("sorts multiple providers by priority and returns them in order", () => {
    const mockTransport1 = { channel: "email", send: vi.fn() } as any;
    const mockTransport2 = { channel: "email", send: vi.fn() } as any;
    const mockTransport3 = { channel: "email", send: vi.fn() } as any;

    transportRegistry.register(mockTransport1, 0);
    transportRegistry.register(mockTransport2, 10);
    transportRegistry.register(mockTransport3, 5);

    const emailTransports = transportRegistry.getAll("email");
    expect(emailTransports).toHaveLength(3);

    // Ordered by highest priority first: 10, 5, 0
    expect(emailTransports[0]).toBe(mockTransport2);
    expect(emailTransports[1]).toBe(mockTransport3);
    expect(emailTransports[2]).toBe(mockTransport1);

    // .get() should return the highest priority one
    expect(transportRegistry.get("email")).toBe(mockTransport2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ConsoleTransport (Development Provider)", () => {
  /** The transport's only side effects are stdout and the optional logger. */
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  const task = (over: Record<string, unknown> = {}): any => ({
    taskId: "task-uuid-1",
    enrichedEventId: "enriched-evt-1",
    recipientId: "usr-1",
    destination: "device-token-1",
    priority: "normal",
    renderedContent: { content: { body: "Hello World" } },
    ...over,
  });

  it("reports a success carrying a console-prefixed provider message id", async () => {
    const result = await new ConsoleTransport().send(task());

    expect(result.success).toBe(true);
    expect(result.providerMessageId).toMatch(/^console-\d+$/);
  });

  it("defaults to the push channel when none is named", () => {
    expect(new ConsoleTransport().channel).toBe("push");
  });

  it("takes the channel it is given, so it can stand in for email or sms", () => {
    expect(new ConsoleTransport({ channel: "email" }).channel).toBe("email");
  });

  it("carries limits through, and leaves them unset when none are given", () => {
    const limits = { limit: 10, windowSeconds: 60 };

    expect(new ConsoleTransport({ limits }).limits).toEqual(limits);
    expect(new ConsoleTransport().limits).toBeUndefined();
  });

  it("prints the parts of the task a developer is watching for", async () => {
    await new ConsoleTransport().send(task({ renderedContent: { content: { body: "Ship it" } } }));

    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = logSpy.mock.calls[0]![0] as string;

    expect(printed).toContain("device-token-1"); // destination
    expect(printed).toContain("usr-1"); // recipient
    expect(printed).toContain("normal"); // priority
    expect(printed).toContain("task-uuid-1"); // taskId
    expect(printed).toContain(JSON.stringify({ body: "Ship it" })); // content
  });

  it("logs the delivery with the ids a caller would correlate on", async () => {
    const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const result = await new ConsoleTransport({ channel: "sms", logger }).send(task());

    expect(logger.info).toHaveBeenCalledWith(
      {
        taskId: "task-uuid-1",
        channel: "sms",
        destination: "device-token-1",
        providerMessageId: result.providerMessageId,
      },
      "push delivered (console transport)",
    );
  });

  it("delivers without a logger, since one is optional", async () => {
    const transport = new ConsoleTransport();

    await expect(transport.send(task())).resolves.toEqual({
      success: true,
      providerMessageId: expect.stringMatching(/^console-\d+$/),
    });
  });
});
