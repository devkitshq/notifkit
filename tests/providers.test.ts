import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { ResendTransport } from "../packages/provider-resend/src/index.js";
import { FcmTransport } from "../packages/provider-fcm/src/index.js";
import { initializeApp } from "firebase-admin/app";
import { ConsoleTransport } from "../packages/provider-console/src/index.js";
import type * as ResendModule from "resend";

// Mock Resend SDK. Only `emails.send` is stubbed: `webhooks.verify` is local
// HMAC checking, so the webhook tests exercise the real implementation.
const mockSendEmail = vi.fn();
vi.mock("resend", async (importOriginal) => {
  const actual = await importOriginal<typeof ResendModule>();
  return {
    ...actual,
    Resend: vi.fn().mockImplementation((apiKey: string) => {
      return {
        emails: {
          send: mockSendEmail,
        },
        webhooks: new actual.Resend(apiKey).webhooks,
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

    expect(mockSendEmail).toHaveBeenCalledWith(
      {
        from: "onboarding@resend.dev",
        to: "recipient@example.com",
        subject: "Welcome Alice",
        html: "<h1>Hello Alice</h1>",
        text: "Hello Alice",
      },
      // A retry of the same task must not send a second email.
      { idempotencyKey: "task-uuid-123" },
    );
    expect(result).toEqual({
      success: true,
      providerMessageId: "email-resend-id-123",
    });
  });

  it("flags a 429 as throttled, so delivery waits instead of counting a failure", async () => {
    mockSendEmail.mockResolvedValueOnce({
      data: null,
      error: { message: "Too many requests", statusCode: 429, name: "rate_limit_exceeded" },
    });
    const transport = new ResendTransport({ apiKey: "k", from: "onboarding@resend.dev" });

    const result = await transport.send({
      taskId: "t",
      destination: "r@example.com",
      renderedContent: { content: { subject: "s", text: "b" } },
    } as any);

    expect(result).toEqual({ success: false, throttled: true, error: "Too many requests" });
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
      retryable: false,
      error: "Requested entity was not found.",
    });
  });

  const fcmTask: any = {
    taskId: "t",
    enrichedEventId: "e",
    destination: "token",
    priority: "normal",
    renderedContent: { content: { subject: "S", body: "B" } },
  };
  const fcmFailure = (code: string) => Object.assign(new Error(code), { code });

  it.each([
    "messaging/invalid-argument",
    "messaging/payload-size-limit-exceeded",
    "messaging/sender-id-mismatch",
  ])("gives up on a request FCM refused (%s)", async (code) => {
    mockSendPush.mockRejectedValueOnce(fcmFailure(code));
    const transport = new FcmTransport({
      serviceAccountJson: JSON.stringify({ project_id: "test-project" }),
    });
    expect(await transport.send(fcmTask)).toMatchObject({ success: false, retryable: false });
  });

  it.each([
    "messaging/quota-exceeded",
    "messaging/message-rate-exceeded",
    "messaging/internal-error",
    "messaging/server-unavailable",
    "app/network-error",
  ])("tries again after %s", async (code) => {
    mockSendPush.mockRejectedValueOnce(fcmFailure(code));
    const transport = new FcmTransport({
      serviceAccountJson: JSON.stringify({ project_id: "test-project" }),
    });
    const result = await transport.send(fcmTask);
    expect(result.success).toBe(false);
    expect(result.retryable).not.toBe(false);
  });

  it.each([
    ["messaging/quota-exceeded", true],
    ["messaging/message-rate-exceeded", true],
    ["messaging/device-message-rate-exceeded", true],
    ["messaging/topics-message-rate-exceeded", true],
    ["messaging/server-unavailable", undefined],
  ])("reports %s as throttled=%s", async (code, throttled) => {
    mockSendPush.mockRejectedValueOnce(fcmFailure(code));
    const transport = new FcmTransport({
      serviceAccountJson: JSON.stringify({ project_id: "test-project" }),
    });
    expect((await transport.send(fcmTask)).throttled).toBe(throttled);
  });

  it("tries again after an error that carries no FCM code", async () => {
    mockSendPush.mockRejectedValueOnce(new Error("socket hang up"));
    const transport = new FcmTransport({
      serviceAccountJson: JSON.stringify({ project_id: "test-project" }),
    });
    expect((await transport.send(fcmTask)).retryable).not.toBe(false);
  });

  it("gives transports with different service accounts their own Firebase app", async () => {
    mockSendPush.mockResolvedValue("id");
    const init = vi.mocked(initializeApp);
    init.mockClear();
    const accountA = JSON.stringify({ project_id: "project-a" });
    const accountB = JSON.stringify({ project_id: "project-b" });

    await new FcmTransport({ serviceAccountJson: accountA }).send(fcmTask);
    await new FcmTransport({ serviceAccountJson: accountB }).send(fcmTask);
    await new FcmTransport({ serviceAccountJson: accountA }).send(fcmTask);

    const names = init.mock.calls.map((call) => call[1]);
    expect(names[0]).not.toBe(names[1]);
    // The same credentials map to the same app name, so getApp can reuse it.
    expect(names[2]).toBe(names[0]);
  });
});

describe("ResendTransport (Webhooks)", () => {
  const webhookSecret = `whsec_${Buffer.from("notifkit-webhook-test-secret").toString("base64")}`;

  /**
   * Produce a body + headers the verifier will accept, the way Resend sends
   * them: a Standard Webhooks `v1,<base64 hmac>` signature over
   * `<id>.<unix timestamp>.<body>`, under the `svix-*` header prefix.
   */
  function sign(payload: unknown, prefix: "svix" | "webhook" = "svix") {
    const rawBody = JSON.stringify(payload);
    const msgId = "msg_2abc";
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const key = Buffer.from(webhookSecret.replace("whsec_", ""), "base64");
    const signature = createHmac("sha256", key)
      .update(`${msgId}.${timestamp}.${rawBody}`)
      .digest("base64");

    return {
      rawBody,
      headers: {
        [`${prefix}-id`]: msgId,
        [`${prefix}-timestamp`]: timestamp,
        [`${prefix}-signature`]: `v1,${signature}`,
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

  it("accepts the Standard Webhooks `webhook-*` header prefix too", () => {
    const transport = new ResendTransport({
      apiKey: "test-api-key",
      from: "onboarding@resend.dev",
      webhookSecret,
    });
    const { rawBody, headers } = sign(bounced, "webhook");

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
      "sms delivered (console transport)",
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

// ─── Twilio ──────────────────────────────────────────────────────────────────

import { TwilioTransport } from "../packages/provider-twilio/src/index.js";

const mockCreateMessage = vi.fn();

// Mock only the client factory. `validateRequest` stays real, so the webhook
// tests exercise Twilio's actual HMAC-SHA1 check rather than a stub of it.
vi.mock("twilio", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  const real = actual.default ?? actual;
  const client = vi.fn(() => ({ messages: { create: mockCreateMessage } }));
  return { default: Object.assign(client, real) };
});

const ACCOUNT_SID = "ACtest00000000000000000000000000";
const AUTH_TOKEN = "test-auth-token";
const CALLBACK_URL = "https://api.example.com/webhooks/twilio";

function twilioTransport(overrides: Record<string, unknown> = {}) {
  return new TwilioTransport({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    from: "+15550000001",
    statusCallbackUrl: CALLBACK_URL,
    ...overrides,
  } as any);
}

function smsTask(overrides: Record<string, unknown> = {}): any {
  return {
    taskId: "task-uuid-sms-1",
    destination: "+15550000002",
    renderedContent: { content: { body: "Your code is 123456" } },
    ...overrides,
  };
}

describe("TwilioTransport (SMS Provider)", () => {
  beforeEach(() => {
    mockCreateMessage.mockReset();
  });

  it("registers against the sms channel", () => {
    expect(twilioTransport().channel).toBe("sms");
  });

  it("sends an SMS via the Twilio SDK and returns the message sid", async () => {
    mockCreateMessage.mockResolvedValueOnce({ sid: "SM123", status: "queued" });

    const result = await twilioTransport().send(smsTask());

    expect(mockCreateMessage).toHaveBeenCalledWith({
      to: "+15550000002",
      from: "+15550000001",
      body: "Your code is 123456",
      statusCallback: CALLBACK_URL,
    });
    expect(result).toEqual({ success: true, providerMessageId: "SM123" });
  });

  it("omits statusCallback when no callback URL is configured", async () => {
    mockCreateMessage.mockResolvedValueOnce({ sid: "SM124", status: "queued" });

    await twilioTransport({ statusCallbackUrl: undefined }).send(smsTask());

    expect(mockCreateMessage).toHaveBeenCalledWith({
      to: "+15550000002",
      from: "+15550000001",
      body: "Your code is 123456",
    });
  });

  it("lets a template pin its own sender, ignoring a non-string one", async () => {
    mockCreateMessage.mockResolvedValue({ sid: "SM125", status: "queued" });

    await twilioTransport().send(
      smsTask({ renderedContent: { content: { body: "hi", from: "+15559999999" } } }),
    );
    expect(mockCreateMessage.mock.calls[0]?.[0].from).toBe("+15559999999");

    await twilioTransport().send(
      smsTask({ renderedContent: { content: { body: "hi", from: 123 } } }),
    );
    expect(mockCreateMessage.mock.calls[1]?.[0].from).toBe("+15550000001");
  });

  it("fails without reaching Twilio when the task carries no destination", async () => {
    const result = await twilioTransport().send(smsTask({ destination: undefined }));

    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      retryable: false,
      error: "No destination (recipient phone number) on task",
    });
  });

  it("fails without reaching Twilio when the task carries no body", async () => {
    const result = await twilioTransport().send(
      smsTask({ renderedContent: { content: { subject: "no body here" } } }),
    );

    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, retryable: false, error: "No message body on task" });
  });

  it.each([
    [21211, "Invalid 'To' Phone Number"],
    [21610, "Attempt to send to unsubscribed recipient"],
    [21614, "'To' number is not a valid mobile number"],
  ])("flags a dead destination (%i) as an invalid token", async (code, message) => {
    mockCreateMessage.mockRejectedValueOnce(
      Object.assign(new Error(message), { code, status: 400 }),
    );

    await expect(twilioTransport().send(smsTask())).resolves.toEqual({
      success: false,
      invalidToken: true,
      retryable: false,
      error: message,
    });
  });

  it.each([
    // 21602: message body is required. Sending it again changes nothing.
    [21602, "Message body is required"],
    // 21612: this sender can't reach this destination. Often the sender's fault,
    // so the number stays active.
    [21612, "Message cannot be sent with the current combination of To and/or From"],
  ])("gives up on any other request Twilio refused (%i)", async (code, message) => {
    mockCreateMessage.mockRejectedValueOnce(
      Object.assign(new Error(message), { code, status: 400 }),
    );

    await expect(twilioTransport().send(smsTask())).resolves.toEqual({
      success: false,
      invalidToken: false,
      retryable: false,
      error: message,
    });
  });

  it("tries again after a server error on Twilio's side", async () => {
    mockCreateMessage.mockRejectedValueOnce(
      Object.assign(new Error("Internal Server Error"), { code: 20500, status: 500 }),
    );

    const result = await twilioTransport().send(smsTask());
    expect(result).toMatchObject({ success: false, invalidToken: false });
    expect(result.retryable).not.toBe(false);
  });

  it("leaves a retryable failure retryable rather than suppressing the number", async () => {
    // 20429 is Twilio's rate limit: the number is fine, this attempt was not.
    mockCreateMessage.mockRejectedValueOnce(
      Object.assign(new Error("Too Many Requests"), { code: 20429, status: 429 }),
    );

    await expect(twilioTransport().send(smsTask())).resolves.toEqual({
      success: false,
      invalidToken: false,
      throttled: true,
      error: "Too Many Requests",
    });
  });

  it("survives an error carrying no Twilio code at all", async () => {
    mockCreateMessage.mockRejectedValueOnce(new Error("socket hang up"));

    await expect(twilioTransport().send(smsTask())).resolves.toEqual({
      success: false,
      invalidToken: false,
      error: "socket hang up",
    });
  });
});

describe("TwilioTransport (Status callbacks)", () => {
  /** Produce a body + headers Twilio's own validator accepts. */
  async function sign(params: Record<string, string>, url = CALLBACK_URL) {
    const twilio = ((await import("twilio")) as any).default;
    const rawBody = new URLSearchParams(params).toString();
    return {
      rawBody,
      headers: {
        "x-twilio-signature": twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params),
      } as Record<string, string>,
    };
  }

  const undelivered = {
    MessageSid: "SM123",
    MessageStatus: "undelivered",
    To: "+15550000002",
    From: "+15550000001",
    ErrorCode: "30005",
  };

  it("mounts its route at the path of the configured callback URL", () => {
    const transport = twilioTransport();

    // The API only mounts a webhook route for a transport carrying all three.
    expect(transport.webhookPath).toBe("/webhooks/twilio");
    expect(typeof transport.verifyWebhook).toBe("function");
    expect(typeof transport.parseWebhook).toBe("function");
  });

  it("advertises no route when no callback URL is configured", () => {
    expect(twilioTransport({ statusCallbackUrl: undefined }).webhookPath).toBeUndefined();
  });

  it("refuses to construct with a callback URL that is not a URL", () => {
    expect(() => twilioTransport({ statusCallbackUrl: "not-a-url" })).toThrow(/not a valid URL/);
  });

  it("accepts a correctly signed callback", async () => {
    const { rawBody, headers } = await sign(undelivered);

    await expect(twilioTransport().verifyWebhook(rawBody, headers)).resolves.toBe(true);
  });

  it("rejects a callback whose body was tampered with after signing", async () => {
    const { headers } = await sign(undelivered);
    const forged = new URLSearchParams({
      ...undelivered,
      MessageSid: "someone-elses-message",
    }).toString();

    await expect(twilioTransport().verifyWebhook(forged, headers)).resolves.toBe(false);
  });

  it("rejects a callback signed for a different URL", async () => {
    const { rawBody, headers } = await sign(
      undelivered,
      "https://evil.example.com/webhooks/twilio",
    );

    await expect(twilioTransport().verifyWebhook(rawBody, headers)).resolves.toBe(false);
  });

  it("rejects a callback with no signature header", async () => {
    const { rawBody } = await sign(undelivered);

    await expect(twilioTransport().verifyWebhook(rawBody, {})).resolves.toBe(false);
  });

  it("rejects everything when no callback URL is configured", async () => {
    const { rawBody, headers } = await sign(undelivered);

    await expect(
      twilioTransport({ statusCallbackUrl: undefined }).verifyWebhook(rawBody, headers),
    ).resolves.toBe(false);
  });

  it("reads the form-encoded body the mounted route could not JSON-parse", async () => {
    const { rawBody, headers } = await sign(undelivered);

    // The route hands over `{}` for a form post; the raw body is the payload.
    const events = await twilioTransport().parseWebhook({}, rawBody, headers);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      providerMessageId: "SM123",
      status: "bounced",
      bounceType: "hard",
      recipient: "+15550000002",
    });
  });

  it("treats an unrecognised failure code as a soft bounce", async () => {
    const { rawBody, headers } = await sign({
      ...undelivered,
      MessageStatus: "failed",
      ErrorCode: "30008",
    });

    const events = await twilioTransport().parseWebhook({}, rawBody, headers);

    expect(events[0]).toMatchObject({ status: "bounced", bounceType: "soft" });
  });

  it("treats a failure with no code at all as a soft bounce", async () => {
    const { MessageSid, MessageStatus, To, From } = undelivered;
    const { rawBody, headers } = await sign({ MessageSid, MessageStatus, To, From });

    const events = await twilioTransport().parseWebhook({}, rawBody, headers);

    expect(events[0]).toMatchObject({ status: "bounced", bounceType: "soft" });
  });

  it("maps a STOP reply to an unsubscribe, not a bounce", async () => {
    const { rawBody, headers } = await sign({ ...undelivered, ErrorCode: "21610" });

    const events = await twilioTransport().parseWebhook({}, rawBody, headers);

    expect(events[0]).toMatchObject({
      providerMessageId: "SM123",
      status: "unsubscribed",
      recipient: "+15550000002",
    });
    expect(events[0]?.bounceType).toBeUndefined();
  });

  it("maps an RCS/WhatsApp read receipt to opened", async () => {
    const { rawBody, headers } = await sign({
      MessageSid: "SM123",
      MessageStatus: "read",
      To: "+15550000002",
    });

    const events = await twilioTransport().parseWebhook({}, rawBody, headers);

    expect(events[0]).toMatchObject({ status: "opened" });
  });

  it.each(["queued", "sending", "sent", "delivered", "accepted", "canceled"])(
    "ignores the untracked %s status",
    async (MessageStatus) => {
      const { rawBody, headers } = await sign({ MessageSid: "SM123", MessageStatus });

      await expect(twilioTransport().parseWebhook({}, rawBody, headers)).resolves.toEqual([]);
    },
  );

  it("falls back to the SmsSid/SmsStatus aliases Twilio sends for SMS", async () => {
    const { rawBody, headers } = await sign({
      SmsSid: "SM999",
      SmsStatus: "undelivered",
      To: "+15550000002",
      ErrorCode: "30006",
    });

    const events = await twilioTransport().parseWebhook({}, rawBody, headers);

    expect(events[0]).toMatchObject({ providerMessageId: "SM999", bounceType: "hard" });
  });

  it("ignores a verified callback that carries no message sid", async () => {
    const { rawBody, headers } = await sign({ MessageStatus: "undelivered" });

    await expect(twilioTransport().parseWebhook({}, rawBody, headers)).resolves.toEqual([]);
  });

  it("does not trust a body that fails verification, even if it is well formed", async () => {
    // Valid-looking payload, signature for a different body.
    const { headers } = await sign({ MessageSid: "other", MessageStatus: "delivered" });
    const rawBody = new URLSearchParams(undelivered).toString();

    await expect(twilioTransport().parseWebhook({}, rawBody, headers)).resolves.toEqual([]);
  });

  it("ignores a callback that arrives without a raw body to verify", async () => {
    const { headers } = await sign(undelivered);

    await expect(twilioTransport().parseWebhook({}, undefined, headers)).resolves.toEqual([]);
  });

  it("keeps the provider detail worth correlating on in metadata", async () => {
    const { rawBody, headers } = await sign({
      ...undelivered,
      ChannelStatusMessage: "Unknown destination handset",
    });

    const events = await twilioTransport().parseWebhook({}, rawBody, headers);

    expect(events[0]?.metadata).toEqual({
      messageStatus: "undelivered",
      errorCode: 30005,
      channelStatusMessage: "Unknown destination handset",
    });
  });
});

describe("TwilioTransport (Client and logging)", () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as any;

  beforeEach(() => {
    mockCreateMessage.mockReset();
  });

  it("builds the SDK client once and reuses it across sends", async () => {
    const twilio = ((await import("twilio")) as any).default;
    twilio.mockClear();
    mockCreateMessage.mockResolvedValue({ sid: "SM126", status: "queued" });

    const transport = twilioTransport();
    await transport.send(smsTask());
    await transport.send(smsTask());

    expect(mockCreateMessage).toHaveBeenCalledTimes(2);
    expect(twilio).toHaveBeenCalledTimes(1);
    expect(twilio).toHaveBeenCalledWith(ACCOUNT_SID, AUTH_TOKEN);
  });

  it("logs an accepted send and a failed one", async () => {
    const log = logger();
    mockCreateMessage.mockResolvedValueOnce({ sid: "SM127", status: "queued" });
    await twilioTransport({ logger: log }).send(smsTask());
    expect(log.debug).toHaveBeenCalledWith(
      { taskId: "task-uuid-sms-1", messageId: "SM127", status: "queued" },
      "Twilio message accepted",
    );

    mockCreateMessage.mockRejectedValueOnce(Object.assign(new Error("nope"), { code: 21211 }));
    await twilioTransport({ logger: log }).send(smsTask());
    expect(log.warn).toHaveBeenCalledWith(
      { taskId: "task-uuid-sms-1", code: 21211, error: "nope", invalidToken: true },
      "Twilio send failed",
    );
  });

  it("reads a signature header that arrived as an array", async () => {
    const rawBody = new URLSearchParams({ MessageSid: "SM128", MessageStatus: "read" }).toString();
    const twilio = ((await import("twilio")) as any).default;
    const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, CALLBACK_URL, {
      MessageSid: "SM128",
      MessageStatus: "read",
    });

    await expect(
      twilioTransport().verifyWebhook(rawBody, { "x-twilio-signature": [signature] }),
    ).resolves.toBe(true);
  });

  it("logs each reason a callback is dropped", async () => {
    const log = logger();
    const rawBody = new URLSearchParams({ MessageSid: "SM129", MessageStatus: "sent" }).toString();

    await twilioTransport({ logger: log, statusCallbackUrl: undefined }).verifyWebhook(rawBody, {});
    expect(log.error).toHaveBeenCalledWith(
      "Twilio webhook rejected: statusCallbackUrl is not configured, cannot verify signature",
    );

    await twilioTransport({ logger: log }).verifyWebhook(rawBody, {});
    expect(log.warn).toHaveBeenCalledWith(
      "Twilio webhook rejected: missing x-twilio-signature header",
    );

    await twilioTransport({ logger: log }).verifyWebhook(rawBody, {
      "x-twilio-signature": "not-the-signature",
    });
    expect(log.warn).toHaveBeenCalledWith("Twilio webhook signature verification failed");
  });

  it("logs a mapped callback, an ignored one, and a malformed one", async () => {
    const log = logger();
    const transport = twilioTransport({ logger: log });

    async function deliver(params: Record<string, string>) {
      const twilio = ((await import("twilio")) as any).default;
      const rawBody = new URLSearchParams(params).toString();
      return transport.parseWebhook({}, rawBody, {
        "x-twilio-signature": twilio.getExpectedTwilioSignature(AUTH_TOKEN, CALLBACK_URL, params),
      });
    }

    await deliver({ MessageSid: "SM130", MessageStatus: "undelivered", ErrorCode: "30005" });
    expect(log.info).toHaveBeenCalledWith(
      {
        providerMessageId: "SM130",
        status: "bounced",
        messageStatus: "undelivered",
        errorCode: 30005,
      },
      "Twilio status callback mapped to notifkit status",
    );

    await deliver({ MessageSid: "SM131", MessageStatus: "delivered" });
    expect(log.debug).toHaveBeenCalledWith(
      { messageStatus: "delivered" },
      "Twilio status callback ignored (untracked message status)",
    );

    await deliver({ MessageStatus: "undelivered" });
    expect(log.warn).toHaveBeenCalledWith("Twilio status callback malformed or missing MessageSid");
  });

  it("omits recipient when the callback carries no To", async () => {
    const params = { MessageSid: "SM132", MessageStatus: "undelivered", ErrorCode: "30005" };
    const twilio = ((await import("twilio")) as any).default;
    const events = await twilioTransport().parseWebhook(
      {},
      new URLSearchParams(params).toString(),
      {
        "x-twilio-signature": twilio.getExpectedTwilioSignature(AUTH_TOKEN, CALLBACK_URL, params),
      },
    );

    expect(events[0]).toMatchObject({ providerMessageId: "SM132", status: "bounced" });
    expect(events[0]).not.toHaveProperty("recipient");
  });
});

// ─── Vonage ──────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { VonageTransport } from "../packages/provider-vonage/src/index.js";

const VONAGE_SIGNATURE_SECRET = "vonage-signature-secret-for-tests";
const MESSAGE_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-0123456789ab";

function vonageTransport(overrides: Record<string, unknown> = {}) {
  return new VonageTransport({
    apiKey: "vonage-key",
    apiSecret: "vonage-secret",
    from: "+447700900001",
    ...overrides,
  } as any);
}

function vonageTask(overrides: Record<string, unknown> = {}): any {
  return {
    taskId: "task-uuid-vg-1",
    destination: "+447700900000",
    renderedContent: { content: { text: "Your code is 123456" } },
    ...overrides,
  };
}

/** Stubs `fetch` with one Messages API response. */
function stubVonage(status: number, body?: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError("Unexpected end of JSON input");
      return body;
    },
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** An RFC 7807 problem the way the Messages API returns one. */
function vonageProblem(code: number, detail: string) {
  return {
    type: `https://developer.vonage.com/api-errors/messages#${code}`,
    title: "Bad request",
    detail,
    instance: "bf0ca0bf927b3b52e3cb03217e1a1ddf",
  };
}

/** The Authorization header Vonage sends with a webhook: an HS256 JWT bound to the body. */
function vonageAuth(
  rawBody: string,
  { secret = VONAGE_SIGNATURE_SECRET, alg = "HS256", claims = {} as Record<string, unknown> } = {},
) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg, typ: "JWT" });
  const payload = encode({
    iat: 1_700_000_000,
    jti: "c5ba8f24-1a14-4c10-bfdf-3fbe8ce511b5",
    iss: "Vonage",
    api_key: "vonage-key",
    payload_hash: createHash("sha256").update(rawBody).digest("hex"),
    ...claims,
  });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `Bearer ${header}.${payload}.${signature}`;
}

describe("VonageTransport (SMS Provider)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers the sms channel and mounts its webhook only with a signature secret", () => {
    expect(vonageTransport().channel).toBe("sms");
    expect(vonageTransport().webhookPath).toBeUndefined();
    expect(vonageTransport({ signatureSecret: VONAGE_SIGNATURE_SECRET }).webhookPath).toBe(
      "/webhooks/vonage",
    );
  });

  it("sends through the Messages API and returns the message_uuid", async () => {
    const fetchMock = stubVonage(202, { message_uuid: MESSAGE_UUID });

    const result = await vonageTransport().send(vonageTask());

    expect(result).toEqual({ success: true, providerMessageId: MESSAGE_UUID });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.nexmo.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from("vonage-key:vonage-secret").toString("base64")}`,
    });
    // Vonage wants both numbers without the leading "+".
    expect(JSON.parse(init.body as string)).toEqual({
      message_type: "text",
      channel: "sms",
      to: "447700900000",
      from: "447700900001",
      text: "Your code is 123456",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses a template's own sender, keeping an alphanumeric sender ID as written", async () => {
    const fetchMock = stubVonage(202, { message_uuid: MESSAGE_UUID });

    await vonageTransport().send(
      vonageTask({ renderedContent: { content: { body: "Sale today", from: "MyShop" } } }),
    );
    await vonageTransport().send(
      vonageTask({ renderedContent: { content: { text: "Hi", from: 123 } } }),
    );

    const bodyOf = (n: number) =>
      JSON.parse((fetchMock.mock.calls[n]![1] as RequestInit).body as string);
    expect(bodyOf(0)).toMatchObject({ from: "MyShop", text: "Sale today" });
    expect(bodyOf(1)).toMatchObject({ from: "447700900001" });
  });

  it("keeps only the digits of a formatted destination", async () => {
    const fetchMock = stubVonage(202, { message_uuid: MESSAGE_UUID });

    await vonageTransport().send(vonageTask({ destination: "+44 7700 900-000" }));

    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).to).toBe(
      "447700900000",
    );
  });

  it("cuts a text longer than Vonage accepts", async () => {
    const fetchMock = stubVonage(202, { message_uuid: MESSAGE_UUID });

    await vonageTransport().send(
      vonageTask({ renderedContent: { content: { text: "a".repeat(3300) } } }),
    );

    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).text;
    expect(sent).toHaveLength(3200);
    expect(sent.endsWith("…")).toBe(true);
  });

  it.each([undefined, "", "+"])(
    "fails without calling Vonage when the destination is %j",
    async (destination) => {
      const fetchMock = stubVonage(202, { message_uuid: MESSAGE_UUID });

      const result = await vonageTransport().send(vonageTask({ destination }));

      expect(result).toEqual({
        success: false,
        retryable: false,
        error: "No destination (recipient phone number) on task",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("fails without calling Vonage when the template has no text", async () => {
    const fetchMock = stubVonage(202, { message_uuid: MESSAGE_UUID });

    const result = await vonageTransport().send(vonageTask({ renderedContent: { content: {} } }));

    expect(result).toEqual({ success: false, retryable: false, error: "No message body on task" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flags the contact when Vonage refuses the destination", async () => {
    stubVonage(422, vonageProblem(1170, "Invalid recipient"));

    const result = await vonageTransport().send(vonageTask());

    expect(result).toEqual({
      success: false,
      invalidToken: true,
      retryable: false,
      error: "Invalid recipient",
    });
  });

  it("does not retry a refused sender, and does not blame the recipient", async () => {
    stubVonage(422, vonageProblem(1420, "Invalid sender"));

    const result = await vonageTransport().send(vonageTask());

    expect(result).toEqual({
      success: false,
      invalidToken: false,
      retryable: false,
      error: "Invalid sender",
    });
  });

  it("does not blame the recipient when our own credentials are rejected", async () => {
    stubVonage(401, {
      type: "https://developer.vonage.com/api-errors#unauthorized",
      title: "Unauthorized",
      detail: "You did not provide correct credentials.",
      instance: "bf0ca0bf927b3b52e3cb03217e1a1ddf",
    });

    const result = await vonageTransport().send(vonageTask());

    expect(result).toEqual({
      success: false,
      invalidToken: false,
      retryable: false,
      error: "You did not provide correct credentials.",
    });
  });

  it.each([
    { status: 500, body: undefined, throttled: undefined, error: "HTTP 500" },
    {
      status: 503,
      body: { title: "Service Unavailable" },
      throttled: undefined,
      error: "Service Unavailable",
    },
    { status: 429, body: undefined, throttled: true, error: "HTTP 429" },
    { status: 400, body: vonageProblem(1000, "Throttled"), throttled: true, error: "Throttled" },
    {
      status: 400,
      body: vonageProblem(1230, "Temporary network failure"),
      throttled: undefined,
      error: "Temporary network failure",
    },
  ])("retries a $status ($error)", async ({ status, body, throttled, error }) => {
    stubVonage(status, body);

    const result = await vonageTransport().send(vonageTask());

    expect(result.success).toBe(false);
    expect(result.retryable).toBeUndefined();
    expect(result.invalidToken).toBe(false);
    expect(result.throttled).toBe(throttled);
    expect(result.error).toBe(error);
  });

  it("retries a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hang up")));

    const result = await vonageTransport().send(vonageTask());

    expect(result).toEqual({ success: false, error: "socket hang up" });
  });

  it("gives up on a request that outlives the task's timeout, and retries it", async () => {
    stubSlowFetch({ ok: true, status: 202, json: async () => ({ message_uuid: MESSAGE_UUID }) });

    const result = await vonageTransport().send(vonageTask({ deliveryOptions: { timeoutMs: 20 } }));

    expect(result.success).toBe(false);
    expect(result.retryable).toBeUndefined();
  });

  it("counts an accepted message without a message_uuid as sent, and says so", async () => {
    stubVonage(202, {});
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

    const result = await vonageTransport({ logger }).send(vonageTask());

    expect(result).toEqual({ success: true });
    expect(logger.warn).toHaveBeenCalledWith(
      { taskId: "task-uuid-vg-1", status: 202 },
      "Vonage accepted the message without a message_uuid",
    );
  });
});

describe("VonageTransport (Status webhooks)", () => {
  const transport = () => vonageTransport({ signatureSecret: VONAGE_SIGNATURE_SECRET });

  function statusBody(fields: Record<string, unknown>) {
    return JSON.stringify({
      message_uuid: MESSAGE_UUID,
      to: "447700900000",
      from: "447700900001",
      timestamp: "2026-11-24T14:00:00.000Z",
      channel: "sms",
      ...fields,
    });
  }

  /** Parses a webhook the way the mounted route does: a signed raw body, then its JSON. */
  async function receive(rawBody: string, headers = { authorization: vonageAuth(rawBody) }) {
    return transport().parseWebhook(JSON.parse(rawBody), rawBody, headers);
  }

  it("accepts a webhook signed with the signature secret", () => {
    const rawBody = statusBody({ status: "delivered" });

    expect(transport().verifyWebhook(rawBody, { authorization: vonageAuth(rawBody) })).toBe(true);
  });

  it.each([
    ["another secret", (raw: string) => vonageAuth(raw, { secret: "not-the-secret" })],
    ["a body that does not match payload_hash", (raw: string) => vonageAuth(`${raw} `)],
    ["no payload_hash", (raw: string) => vonageAuth(raw, { claims: { payload_hash: undefined } })],
    ["the none algorithm", (raw: string) => vonageAuth(raw, { alg: "none" })],
    ["a token that is not a JWT", () => "Bearer not-a-jwt"],
    ["no Bearer scheme", (raw: string) => vonageAuth(raw).slice("Bearer ".length)],
    ["no Authorization header", () => undefined],
  ])("rejects a webhook signed with %s", (_label, authorization) => {
    const rawBody = statusBody({ status: "delivered" });

    expect(transport().verifyWebhook(rawBody, { authorization: authorization(rawBody) })).toBe(
      false,
    );
  });

  it("rejects every webhook when no signature secret is configured", () => {
    const rawBody = statusBody({ status: "delivered" });

    expect(vonageTransport().verifyWebhook(rawBody, { authorization: vonageAuth(rawBody) })).toBe(
      false,
    );
  });

  it("maps a rejection for a dead number to a hard bounce, with the E.164 recipient", async () => {
    const events = await receive(
      statusBody({
        status: "rejected",
        error: vonageProblem(1170, "Invalid recipient"),
      }),
    );

    expect(events).toEqual([
      {
        providerMessageId: MESSAGE_UUID,
        status: "bounced",
        bounceType: "hard",
        recipient: "+447700900000",
        timestamp: new Date("2026-11-24T14:00:00.000Z"),
        metadata: { messageStatus: "rejected", errorCode: 1170, errorDetail: "Invalid recipient" },
      },
    ]);
  });

  it.each([
    // The code may come only in `title`, as a number, as in Vonage's own example.
    [{ type: "https://developer.vonage.com/api-errors/messages", title: 1050 }, "bounced", "hard"],
    [vonageProblem(1260, "Destination unreachable"), "bounced", "soft"],
    [undefined, "bounced", "soft"],
    [vonageProblem(1240, "Illegal Number"), "unsubscribed", undefined],
  ])("maps a rejection with %j to %s", async (error, status, bounceType) => {
    const [event] = await receive(statusBody({ status: "rejected", error }));

    expect(event?.status).toBe(status);
    expect(event?.bounceType).toBe(bounceType);
  });

  it("reads a rejection in the shape Vonage really sends", async () => {
    // A live Messages API status webhook, number replaced: the code comes in a
    // developer.nexmo.com `type` URL and as a string `title`. An account-side
    // block says nothing about the number, so it stays a soft bounce.
    const rawBody = JSON.stringify({
      to: "447700900000",
      from: "Vonage APIs",
      channel: "sms",
      message_uuid: MESSAGE_UUID,
      timestamp: "2026-11-24T21:44:59Z",
      usage: { price: "0.0000", currency: "EUR" },
      sms: { count_total: "1" },
      status: "rejected",
      error: {
        type: "https://developer.nexmo.com/api-errors/messages-olympus#1474",
        title: "1474",
        detail: "Rejected due Fraud Defender country block",
        instance: "42ae660f-08f9-404b-b1c8-6783f2921696",
      },
      destination: { network_code: "23415" },
    });

    expect(await receive(rawBody)).toEqual([
      {
        providerMessageId: MESSAGE_UUID,
        status: "bounced",
        bounceType: "soft",
        recipient: "+447700900000",
        timestamp: new Date("2026-11-24T21:44:59Z"),
        metadata: {
          messageStatus: "rejected",
          errorCode: 1474,
          errorDetail: "Rejected due Fraud Defender country block",
        },
      },
    ]);
  });

  it("maps undeliverable to a soft bounce", async () => {
    const [event] = await receive(statusBody({ status: "undeliverable" }));

    expect(event).toMatchObject({ status: "bounced", bounceType: "soft" });
  });

  it.each(["submitted", "delivered"])("ignores %s", async (status) => {
    expect(await receive(statusBody({ status }))).toEqual([]);
  });

  it("ignores a webhook that fails verification, even when called directly", async () => {
    const rawBody = statusBody({ status: "rejected" });

    expect(await receive(rawBody, { authorization: vonageAuth(rawBody, { secret: "x" }) })).toEqual(
      [],
    );
    expect(await transport().parseWebhook(JSON.parse(rawBody))).toEqual([]);
  });

  it("ignores a signed webhook without a message_uuid", async () => {
    const rawBody = JSON.stringify({ status: "rejected", to: "447700900000" });

    expect(await receive(rawBody)).toEqual([]);
  });

  it("leaves out a recipient it cannot read and dates an undated event now", async () => {
    const [event] = await receive(
      statusBody({ status: "undeliverable", to: undefined, timestamp: "not a date" }),
    );

    expect(event).not.toHaveProperty("recipient");
    expect(event?.timestamp).toBeInstanceOf(Date);
    expect(Number.isNaN(event!.timestamp!.getTime())).toBe(false);
  });
});

// ─── Telegram ────────────────────────────────────────────────────────────────

/**
 * Stubs `fetch` with a request that lands `response` after 100ms unless its
 * abort signal fires first, the way a real fetch does.
 */
function stubSlowFetch(response: unknown) {
  const fn = vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(response), 100);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal!.reason);
        });
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** A signal that aborts after 20ms, like delivery's send timeout. */
function timeoutSignal() {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("Transport timeout after 20ms")), 20);
  return controller.signal;
}

import { TelegramTransport } from "../packages/provider-telegram/src/index.js";

const BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";

/**
 * Stubs `fetch` with the Bot API's envelope. Telegram signals failure in the
 * JSON body (`ok: false`) rather than the HTTP status, so these tests drive
 * the body and leave the status at 200 the way the real API does.
 */
function stubTelegram(body: unknown) {
  const fn = vi.fn().mockResolvedValue({ json: async () => body });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The JSON payload sent to the Bot API on the Nth call. */
function telegramBody(fn: ReturnType<typeof stubTelegram>, n = 0) {
  return JSON.parse((fn.mock.calls[n]![1] as RequestInit).body as string);
}

function telegramTransport(overrides: Record<string, unknown> = {}) {
  return new TelegramTransport({ botToken: BOT_TOKEN, ...overrides } as any);
}

function telegramTask(overrides: Record<string, unknown> = {}): any {
  return {
    taskId: "task-uuid-tg-1",
    destination: "987654321",
    renderedContent: { content: { body: "Your build is green" } },
    ...overrides,
  };
}

const okResult = (messageId: number) => ({ ok: true, result: { message_id: messageId } });

describe("TelegramTransport (Telegram Provider)", () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as any;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers against the telegram channel", () => {
    expect(telegramTransport().channel).toBe("telegram");
  });

  it("defaults to the bot-wide rate ceiling and accepts an override", () => {
    expect(telegramTransport().limits).toEqual({ limit: 30, windowSeconds: 1 });
    expect(telegramTransport({ limits: { limit: 1, windowSeconds: 1 } }).limits).toEqual({
      limit: 1,
      windowSeconds: 1,
    });
  });

  it("posts to the bot's sendMessage endpoint and returns the message id", async () => {
    const fetchMock = stubTelegram(okResult(4242));

    const result = await telegramTransport().send(telegramTask());

    expect(fetchMock.mock.calls[0]![0]).toBe(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    );
    expect(telegramBody(fetchMock)).toEqual({
      chat_id: "987654321",
      text: "Your build is green",
    });
    expect(result).toEqual({ success: true, providerMessageId: "4242" });
  });

  it("prefers content.text over content.body", async () => {
    const fetchMock = stubTelegram(okResult(1));

    await telegramTransport().send(
      telegramTask({ renderedContent: { content: { text: "from text", body: "from body" } } }),
    );

    expect(telegramBody(fetchMock).text).toBe("from text");
  });

  it("folds a rendered subject onto the first line", async () => {
    const fetchMock = stubTelegram(okResult(2));

    await telegramTransport().send(
      telegramTask({ renderedContent: { content: { subject: "Deploy", body: "shipped" } } }),
    );

    expect(telegramBody(fetchMock).text).toBe("Deploy\n\nshipped");
  });

  it("sends plain text unless a parse mode is configured", async () => {
    const fetchMock = stubTelegram(okResult(3));

    await telegramTransport().send(telegramTask());
    expect(telegramBody(fetchMock, 0)).not.toHaveProperty("parse_mode");

    await telegramTransport({ parseMode: "HTML" }).send(telegramTask());
    expect(telegramBody(fetchMock, 1).parse_mode).toBe("HTML");
  });

  it("lets a template pin its own parse mode, ignoring a non-string one", async () => {
    const fetchMock = stubTelegram(okResult(4));

    await telegramTransport({ parseMode: "HTML" }).send(
      telegramTask({ renderedContent: { content: { body: "hi", parseMode: "MarkdownV2" } } }),
    );
    expect(telegramBody(fetchMock, 0).parse_mode).toBe("MarkdownV2");

    await telegramTransport({ parseMode: "HTML" }).send(
      telegramTask({ renderedContent: { content: { body: "hi", parseMode: 7 } } }),
    );
    expect(telegramBody(fetchMock, 1).parse_mode).toBe("HTML");
  });

  it("passes through the preview and notification opt-outs", async () => {
    const fetchMock = stubTelegram(okResult(5));

    await telegramTransport().send(
      telegramTask({
        renderedContent: {
          content: { body: "quiet", disableWebPagePreview: true, disableNotification: true },
        },
      }),
    );

    expect(telegramBody(fetchMock)).toMatchObject({
      link_preview_options: { is_disabled: true },
      disable_notification: true,
    });
  });

  it("fails without reaching Telegram when the task carries no destination", async () => {
    const fetchMock = stubTelegram(okResult(6));

    const result = await telegramTransport().send(telegramTask({ destination: undefined }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      retryable: false,
      error: "No destination (Telegram chat id) on task",
    });
  });

  it("returns an empty provider id when the API omits the message id", async () => {
    stubTelegram({ ok: true });

    const result = await telegramTransport().send(telegramTask());

    expect(result).toEqual({ success: true, providerMessageId: "" });
  });

  it("treats a 403 as a dead target", async () => {
    const log = logger();
    stubTelegram({ ok: false, error_code: 403, description: "Forbidden: bot was blocked" });

    const result = await telegramTransport({ logger: log }).send(telegramTask());

    expect(result).toEqual({
      success: false,
      invalidToken: true,
      retryable: false,
      error: "Forbidden: bot was blocked",
    });
    expect(log.warn).toHaveBeenCalledWith(
      { taskId: "task-uuid-tg-1", errorCode: 403, description: "Forbidden: bot was blocked" },
      "Telegram send failed",
    );
  });

  it.each([
    ["chat not found", true],
    ["user is deactivated", true],
    ["message text is empty", false],
  ])("classifies a 400 describing %j as dead=%s", async (description, invalidToken) => {
    stubTelegram({ ok: false, error_code: 400, description });

    const result = await telegramTransport().send(telegramTask());

    // A 400 is the request being refused, whether or not the chat is gone.
    expect(result).toEqual({ success: false, invalidToken, retryable: false, error: description });
  });

  it("falls back to a synthetic message when the API omits a description", async () => {
    stubTelegram({ ok: false, error_code: 429 });
    expect(await telegramTransport().send(telegramTask())).toEqual({
      success: false,
      invalidToken: false,
      throttled: true,
      error: "Telegram API error 429",
    });

    stubTelegram({ ok: false });
    expect(await telegramTransport().send(telegramTask())).toEqual({
      success: false,
      invalidToken: false,
      error: "Telegram API error unknown",
    });
  });

  it("does not treat a bare 400 as a dead target", async () => {
    // A 400 with no description at all still has to be matched against the
    // dead-target patterns without throwing on the missing string.
    stubTelegram({ ok: false, error_code: 400 });

    // Not a dead chat, but still a refused request: no point sending it again.
    expect(await telegramTransport().send(telegramTask())).toEqual({
      success: false,
      invalidToken: false,
      retryable: false,
      error: "Telegram API error 400",
    });
  });

  it("reports a transport-level failure without marking the target dead", async () => {
    const log = logger();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hang up")));

    const result = await telegramTransport({ logger: log }).send(telegramTask());

    expect(result).toEqual({ success: false, error: "socket hang up" });
    expect(log.error).toHaveBeenCalledWith(
      { taskId: "task-uuid-tg-1", error: "socket hang up" },
      "Telegram unexpected error",
    );
  });

  it("cancels the request when delivery aborts the send", async () => {
    stubSlowFetch({ json: async () => okResult(1) });

    const result = await telegramTransport().send(telegramTask({ signal: timeoutSignal() }));

    expect(result).toEqual({ success: false, error: "Transport timeout after 20ms" });
  });

  it("logs an accepted send", async () => {
    const log = logger();
    stubTelegram(okResult(99));

    await telegramTransport({ logger: log }).send(telegramTask());

    expect(log.debug).toHaveBeenCalledWith(
      { taskId: "task-uuid-tg-1", providerMessageId: "99" },
      "Telegram message sent",
    );
  });
});

// ─── Discord ─────────────────────────────────────────────────────────────────

import { DiscordTransport } from "../packages/provider-discord/src/index.js";

const WEBHOOK_URL = "https://discord.com/api/webhooks/123/abcdef";

/**
 * Stubs `fetch` with a webhook Response double. Discord signals failure with
 * the HTTP status, and the transport reads the body as text on that path and
 * as JSON on the success path — so both readers are stubbed here.
 */
function stubDiscord(body: unknown, status = 200) {
  const fn = vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The JSON payload posted to the webhook on the Nth call. */
function discordBody(fn: ReturnType<typeof stubDiscord>, n = 0) {
  return JSON.parse((fn.mock.calls[n]![1] as RequestInit).body as string);
}

function discordTask(overrides: Record<string, unknown> = {}): any {
  return {
    taskId: "task-uuid-dc-1",
    destination: WEBHOOK_URL,
    renderedContent: { content: { body: "Build finished" } },
    ...overrides,
  };
}

describe("DiscordTransport (Discord Provider)", () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as any;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers against the discord channel", () => {
    expect(new DiscordTransport().channel).toBe("discord");
  });

  it("constructs without options and defaults to the per-webhook rate ceiling", () => {
    expect(new DiscordTransport().limits).toEqual({ limit: 5, windowSeconds: 2 });
    expect(new DiscordTransport({ limits: { limit: 1, windowSeconds: 1 } }).limits).toEqual({
      limit: 1,
      windowSeconds: 1,
    });
  });

  it("posts to the webhook with wait=true and returns the message id", async () => {
    const fetchMock = stubDiscord({ id: "msg-9001" });

    const result = await new DiscordTransport().send(discordTask());

    // `wait=true` is what makes Discord answer with the created message rather
    // than an empty 204, so the id can be recorded.
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${WEBHOOK_URL}?wait=true`);
    expect(discordBody(fetchMock)).toEqual({ content: "Build finished" });
    expect(result).toEqual({ success: true, providerMessageId: "msg-9001" });
  });

  it("prefers content.text over content.body", async () => {
    const fetchMock = stubDiscord({ id: "m1" });

    await new DiscordTransport().send(
      discordTask({ renderedContent: { content: { text: "from text", body: "from body" } } }),
    );

    expect(discordBody(fetchMock).content).toBe("from text");
  });

  it("bolds a rendered subject onto the first line", async () => {
    const fetchMock = stubDiscord({ id: "m2" });

    await new DiscordTransport().send(
      discordTask({ renderedContent: { content: { subject: "Deploy", body: "shipped" } } }),
    );

    expect(discordBody(fetchMock).content).toBe("**Deploy**\nshipped");
  });

  it("omits sender identity unless configured", async () => {
    const fetchMock = stubDiscord({ id: "m3" });

    await new DiscordTransport().send(discordTask());
    expect(discordBody(fetchMock, 0)).not.toHaveProperty("username");
    expect(discordBody(fetchMock, 0)).not.toHaveProperty("avatar_url");

    await new DiscordTransport({ username: "notifkit", avatarUrl: "https://img/a.png" }).send(
      discordTask(),
    );
    expect(discordBody(fetchMock, 1)).toMatchObject({
      username: "notifkit",
      avatar_url: "https://img/a.png",
    });
  });

  it("lets a template pin its own sender, ignoring blank and non-string values", async () => {
    const fetchMock = stubDiscord({ id: "m4" });
    const transport = new DiscordTransport({ username: "base", avatarUrl: "https://img/base.png" });

    await transport.send(
      discordTask({
        renderedContent: {
          content: { body: "hi", username: "alerts", avatarUrl: "https://img/alerts.png" },
        },
      }),
    );
    expect(discordBody(fetchMock, 0)).toMatchObject({
      username: "alerts",
      avatar_url: "https://img/alerts.png",
    });

    // Empty strings and wrong types fall back to the transport's own defaults.
    await transport.send(
      discordTask({ renderedContent: { content: { body: "hi", username: "", avatarUrl: 5 } } }),
    );
    expect(discordBody(fetchMock, 1)).toMatchObject({
      username: "base",
      avatar_url: "https://img/base.png",
    });
  });

  it("forwards embeds only when they are an array", async () => {
    const fetchMock = stubDiscord({ id: "m5" });
    const embeds = [{ title: "Coverage", description: "80%" }];

    await new DiscordTransport().send(
      discordTask({ renderedContent: { content: { body: "hi", embeds } } }),
    );
    expect(discordBody(fetchMock, 0).embeds).toEqual(embeds);

    await new DiscordTransport().send(
      discordTask({ renderedContent: { content: { body: "hi", embeds: "nope" } } }),
    );
    expect(discordBody(fetchMock, 1)).not.toHaveProperty("embeds");
  });

  it("fails without reaching Discord when the task carries no destination", async () => {
    const fetchMock = stubDiscord({ id: "m6" });

    const result = await new DiscordTransport().send(discordTask({ destination: undefined }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      retryable: false,
      error: "No destination (Discord webhook URL) on task",
    });
  });

  it.each([
    ["http://169.254.169.254/latest/meta-data"],
    ["http://localhost:6379/"],
    ["https://attacker.example.com/api/webhooks/123/token"],
    ["https://discord.com/api/users/@me"],
  ])(
    "rejects invalid webhook URL %s without dispatching fetch (SSRF protection)",
    async (badUrl) => {
      const fetchMock = stubDiscord({ id: "m-evil" });

      const result = await new DiscordTransport().send(discordTask({ destination: badUrl }));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.invalidToken).toBe(true);
      expect(result.error).toContain("Invalid Discord webhook URL");
    },
  );

  it("returns an empty provider id when the response carries no JSON", async () => {
    const fn = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => {
        throw new Error("Unexpected end of JSON input");
      },
      text: async () => "",
    });
    vi.stubGlobal("fetch", fn);

    const result = await new DiscordTransport().send(discordTask());

    expect(result).toEqual({ success: true, providerMessageId: "" });
  });

  it.each([
    [404, true, false],
    [401, true, false],
    [500, false, undefined],
    [429, false, undefined],
  ])(
    "classifies a %i response as dead=%s, retryable=%s",
    async (status, invalidToken, retryable) => {
      stubDiscord("rate limited or gone", status);

      const result = await new DiscordTransport().send(discordTask());

      expect(result).toEqual({
        success: false,
        invalidToken,
        ...(retryable === false ? { retryable } : {}),
        ...(status === 429 ? { throttled: true } : {}),
        error: `Discord webhook error ${status}: rate limited or gone`,
      });
    },
  );

  it("logs a rejected send", async () => {
    const log = logger();
    stubDiscord("missing permissions", 403);

    await new DiscordTransport({ logger: log }).send(discordTask());

    expect(log.warn).toHaveBeenCalledWith(
      { taskId: "task-uuid-dc-1", status: 403, errorBody: "missing permissions" },
      "Discord send failed",
    );
  });

  it("reports a malformed webhook URL without marking the target dead", async () => {
    const log = logger();
    const fetchMock = stubDiscord({ id: "m7" });

    const result = await new DiscordTransport({ logger: log }).send(
      discordTask({ destination: "not-a-url" }),
    );

    // `new URL()` throws before any request is attempted.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-uuid-dc-1" }),
      "Discord unexpected error",
    );
  });

  it("reports a transport-level failure", async () => {
    const log = logger();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hang up")));

    const result = await new DiscordTransport({ logger: log }).send(discordTask());

    expect(result).toEqual({ success: false, error: "socket hang up" });
    expect(log.error).toHaveBeenCalledWith(
      { taskId: "task-uuid-dc-1", error: "socket hang up" },
      "Discord unexpected error",
    );
  });

  it("cancels the request when delivery aborts the send", async () => {
    stubSlowFetch({ ok: true, status: 200, json: async () => ({ id: "msg-1" }) });

    const result = await new DiscordTransport().send(discordTask({ signal: timeoutSignal() }));

    expect(result).toEqual({ success: false, error: "Transport timeout after 20ms" });
  });

  it("logs an accepted send", async () => {
    const log = logger();
    stubDiscord({ id: "msg-42" });

    await new DiscordTransport({ logger: log }).send(discordTask());

    expect(log.debug).toHaveBeenCalledWith(
      { taskId: "task-uuid-dc-1", providerMessageId: "msg-42" },
      "Discord message sent",
    );
  });
});

// ─── Slack ───────────────────────────────────────────────────────────────────

import { SlackTransport } from "../packages/provider-slack/src/index.js";

const SLACK_BOT_TOKEN = "xoxb-0000-1111-test";
const HOOK_URL = "https://hooks.slack.com/services/T000/B000/xyz";
const POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

/** Stubs `fetch` for the Web API, which reports failure in a JSON envelope. */
function stubSlackApi(body: unknown, status = 200) {
  const fn = vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Stubs `fetch` for Incoming Webhooks, which answer with a plain-text body. */
function stubSlackHook(body: string, status = 200) {
  const fn = vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
    json: async () => ({}),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The JSON payload sent to Slack on the Nth call. */
function slackBody(fn: ReturnType<typeof stubSlackApi>, n = 0) {
  return JSON.parse((fn.mock.calls[n]![1] as RequestInit).body as string);
}

function slackTask(overrides: Record<string, unknown> = {}): any {
  return {
    taskId: "task-uuid-slack-1",
    destination: "C0123456789",
    renderedContent: { content: { body: "Deploy finished" } },
    ...overrides,
  };
}

describe("SlackTransport (Slack Provider)", () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as any;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exposes the dedicated slack channel", () => {
    expect(new SlackTransport().channel).toBe("slack");
  });

  it("constructs without options and defaults to a conservative rate ceiling", () => {
    expect(new SlackTransport().limits).toEqual({ limit: 50, windowSeconds: 60 });
    expect(new SlackTransport({ limits: { limit: 1, windowSeconds: 1 } }).limits).toEqual({
      limit: 1,
      windowSeconds: 1,
    });
  });

  it("accepts `token` as an alias for `botToken`", async () => {
    const fetchMock = stubSlackApi({ ok: true, ts: "1700000000.000100" });

    await new SlackTransport({ token: SLACK_BOT_TOKEN }).send(slackTask());

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${SLACK_BOT_TOKEN}`,
    );
  });

  it.each([
    ["clientId", { clientId: "123.456" }],
    ["clientSecret", { clientSecret: "shhh" }],
  ])("warns when %s arrives without a usable token", (_label, opts) => {
    const log = logger();

    new SlackTransport({ ...opts, appId: "A123", logger: log });

    expect(log.warn).toHaveBeenCalledWith(
      { appId: "A123" },
      expect.stringContaining("clientId/clientSecret authenticate Slack's OAuth install flow"),
    );
  });

  it("stays quiet when OAuth credentials accompany a real token", () => {
    const log = logger();

    new SlackTransport({
      clientId: "123.456",
      clientSecret: "shhh",
      botToken: SLACK_BOT_TOKEN,
      logger: log,
    });

    expect(log.warn).not.toHaveBeenCalled();
  });

  describe("destination resolution", () => {
    it("prefers a template's pinned channel over the task destination", async () => {
      const fetchMock = stubSlackApi({ ok: true, ts: "1.1" });

      await new SlackTransport({ botToken: SLACK_BOT_TOKEN }).send(
        slackTask({ renderedContent: { content: { body: "hi", channel: "#system-alerts" } } }),
      );

      expect(slackBody(fetchMock).channel).toBe("#system-alerts");
    });

    it("ignores a non-string pinned channel and falls back to the task destination", async () => {
      const fetchMock = stubSlackApi({ ok: true, ts: "1.2" });

      await new SlackTransport({ botToken: SLACK_BOT_TOKEN }).send(
        slackTask({ renderedContent: { content: { body: "hi", channel: 42 } } }),
      );

      expect(slackBody(fetchMock).channel).toBe("C0123456789");
    });

    it("falls back to the configured webhook for a task with no destination", async () => {
      const fetchMock = stubSlackHook("ok");

      const result = await new SlackTransport({ webhookUrl: HOOK_URL }).send(
        slackTask({ destination: undefined }),
      );

      expect(String(fetchMock.mock.calls[0]![0])).toBe(HOOK_URL);
      expect(result.success).toBe(true);
    });

    it("fails without reaching Slack when nothing names a destination", async () => {
      const fetchMock = stubSlackApi({ ok: true });

      const result = await new SlackTransport({ botToken: SLACK_BOT_TOKEN }).send(
        slackTask({ destination: undefined }),
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        retryable: false,
        error: "No destination (Slack channel/user ID, or webhook URL) on task",
      });
    });

    it("refuses a channel id when no token is configured", async () => {
      const fetchMock = stubSlackApi({ ok: true });

      const result = await new SlackTransport().send(slackTask());

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        retryable: false,
        error: "Destination is a Slack channel/user ID but no botToken (or token) is configured",
      });
    });
  });

  describe("message body", () => {
    it("prefers content.text over content.body", async () => {
      const fetchMock = stubSlackApi({ ok: true, ts: "1.3" });

      await new SlackTransport({ botToken: SLACK_BOT_TOKEN }).send(
        slackTask({ renderedContent: { content: { text: "from text", body: "from body" } } }),
      );

      expect(slackBody(fetchMock).text).toBe("from text");
    });

    it("forwards blocks only when they are an array", async () => {
      const fetchMock = stubSlackApi({ ok: true, ts: "1.4" });
      const blocks = [{ type: "section", text: { type: "mrkdwn", text: "hi" } }];

      await new SlackTransport({ botToken: SLACK_BOT_TOKEN }).send(
        slackTask({ renderedContent: { content: { body: "hi", blocks } } }),
      );
      expect(slackBody(fetchMock, 0).blocks).toEqual(blocks);

      await new SlackTransport({ botToken: SLACK_BOT_TOKEN }).send(
        slackTask({ renderedContent: { content: { body: "hi", blocks: "nope" } } }),
      );
      expect(slackBody(fetchMock, 1)).not.toHaveProperty("blocks");
    });

    it("always sends fallback text, even when the message is carried by blocks", async () => {
      const fetchMock = stubSlackApi({ ok: true, ts: "1.5" });
      const blocks = [{ type: "divider" }];

      // Subject stands in when there is no body at all …
      await new SlackTransport({ botToken: SLACK_BOT_TOKEN }).send(
        slackTask({ renderedContent: { content: { subject: "Nightly build", blocks } } }),
      );
      expect(slackBody(fetchMock, 0).text).toBe("Nightly build");

      // … and a constant stands in when there is neither.
      await new SlackTransport({ botToken: SLACK_BOT_TOKEN }).send(
        slackTask({ renderedContent: { content: { blocks } } }),
      );
      expect(slackBody(fetchMock, 1).text).toBe("New notification");
    });
  });

  describe("chat.postMessage", () => {
    it("posts to the Web API and returns a channel-qualified message id", async () => {
      const fetchMock = stubSlackApi({ ok: true, ts: "1700000000.000100", channel: "C999" });

      const result = await new SlackTransport({ botToken: SLACK_BOT_TOKEN }).send(slackTask());

      expect(fetchMock.mock.calls[0]![0]).toBe(POST_MESSAGE_URL);
      expect(result).toEqual({ success: true, providerMessageId: "C999:1700000000.000100" });
    });

    it("falls back to the requested channel when the response omits one", async () => {
      stubSlackApi({ ok: true, ts: "1700000000.000200" });

      const result = await new SlackTransport({ botToken: SLACK_BOT_TOKEN }).send(slackTask());

      expect(result).toEqual({
        success: true,
        providerMessageId: "C0123456789:1700000000.000200",
      });
    });

    it("reports no message id when the response omits the timestamp", async () => {
      stubSlackApi({ ok: true });

      const result = await new SlackTransport({ botToken: SLACK_BOT_TOKEN }).send(slackTask());

      expect(result).toEqual({ success: true, providerMessageId: undefined });
    });

    it.each([
      ["channel_not_found", true, false],
      ["is_archived", true, false],
      ["channel_is_archived", true, false],
      ["user_not_found", true, false],
      ["not_in_channel", true, false],
      ["ratelimited", false, undefined],
      // Not the destination's fault, but no later attempt gets past a bad token.
      ["invalid_auth", false, false],
      // Our bot token's user or workspace was deleted: every channel would be blamed.
      ["account_inactive", false, false],
    ])(
      "classifies %s as dead-destination=%s, retryable=%s",
      async (error, invalidToken, retryable) => {
        stubSlackApi({ ok: false, error });

        const result = await new SlackTransport({ botToken: SLACK_BOT_TOKEN }).send(slackTask());

        expect(result).toEqual({
          success: false,
          invalidToken,
          ...(retryable === false ? { retryable } : {}),
          ...(error === "ratelimited" ? { throttled: true } : {}),
          error,
        });
      },
    );

    it("flags a 429 from the API as throttled", async () => {
      stubSlackApi({ ok: false, error: "rate_limited" }, 429);

      const result = await new SlackTransport({ botToken: SLACK_BOT_TOKEN }).send(slackTask());

      expect(result).toMatchObject({ success: false, throttled: true });
      expect(result.retryable).not.toBe(false);
    });

    it("falls back to a generic message when the API names no error", async () => {
      stubSlackApi({ ok: false });

      const result = await new SlackTransport({ botToken: SLACK_BOT_TOKEN }).send(slackTask());

      expect(result).toEqual({ success: false, invalidToken: false, error: "Slack API error" });
    });

    it("logs both outcomes with the app id that produced them", async () => {
      const log = logger();
      stubSlackApi({ ok: true, ts: "1.6", channel: "C1" });
      await new SlackTransport({ botToken: SLACK_BOT_TOKEN, appId: "A123", logger: log }).send(
        slackTask(),
      );
      expect(log.debug).toHaveBeenCalledWith(
        { taskId: "task-uuid-slack-1", appId: "A123", providerMessageId: "C1:1.6" },
        "Slack message sent",
      );

      stubSlackApi({ ok: false, error: "channel_not_found" });
      await new SlackTransport({ botToken: SLACK_BOT_TOKEN, appId: "A123", logger: log }).send(
        slackTask(),
      );
      expect(log.warn).toHaveBeenCalledWith(
        {
          taskId: "task-uuid-slack-1",
          appId: "A123",
          error: "channel_not_found",
          invalidToken: true,
        },
        "Slack chat.postMessage failed",
      );
    });

    it("reports a transport-level failure", async () => {
      const log = logger();
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hang up")));

      const result = await new SlackTransport({ botToken: SLACK_BOT_TOKEN, logger: log }).send(
        slackTask(),
      );

      expect(result).toEqual({ success: false, error: "socket hang up" });
      expect(log.error).toHaveBeenCalledWith(
        { taskId: "task-uuid-slack-1", error: "socket hang up" },
        "Slack unexpected error",
      );
    });

    it("cancels the request when delivery aborts the send", async () => {
      stubSlowFetch({ status: 200, json: async () => ({ ok: true, ts: "1.2" }) });

      const result = await new SlackTransport({ botToken: SLACK_BOT_TOKEN }).send(
        slackTask({ signal: timeoutSignal() }),
      );

      expect(result).toEqual({ success: false, error: "Transport timeout after 20ms" });
    });
  });

  describe("incoming webhooks", () => {
    const hookTask = () => slackTask({ destination: HOOK_URL });

    it("posts the message unauthenticated and synthesises a message id", async () => {
      const fetchMock = stubSlackHook("ok");

      const result = await new SlackTransport().send(hookTask());

      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      // A webhook URL carries its own authorisation, so no bearer token is sent.
      expect(init.headers).not.toHaveProperty("Authorization");
      expect(result).toEqual({
        success: true,
        providerMessageId: "slack-webhook-task-uuid-slack-1",
      });
    });

    it("forwards blocks over the webhook route too", async () => {
      const fetchMock = stubSlackHook("ok");
      const blocks = [{ type: "divider" }];

      await new SlackTransport().send(
        slackTask({
          destination: HOOK_URL,
          renderedContent: { content: { body: "hi", blocks } },
        }),
      );

      expect(slackBody(fetchMock)).toEqual({ text: "hi", blocks });
    });

    it("tolerates the trailing whitespace Slack sometimes returns", async () => {
      stubSlackHook("ok\n");

      const result = await new SlackTransport().send(hookTask());

      expect(result.success).toBe(true);
    });

    it.each([
      ["channel_not_found", true],
      ["channel_is_archived", true],
      ["no_service", true],
      ["invalid_payload", false],
    ])("classifies the %j response body as dead-destination=%s", async (body, invalidToken) => {
      stubSlackHook(body, 400);

      const result = await new SlackTransport().send(hookTask());

      // Sent with a 400: whatever the body says, Slack refused the request.
      expect(result).toEqual({ success: false, invalidToken, retryable: false, error: body });
    });

    it("flags a 429 from an incoming webhook as throttled", async () => {
      stubSlackHook("rate_limited", 429);

      const result = await new SlackTransport().send(hookTask());

      expect(result).toEqual({
        success: false,
        invalidToken: false,
        throttled: true,
        error: "rate_limited",
      });
    });

    it("falls back to the status code when the body is empty", async () => {
      stubSlackHook("", 500);

      const result = await new SlackTransport().send(hookTask());

      expect(result).toEqual({ success: false, invalidToken: false, error: "HTTP 500" });
    });

    it("fails a 200 that does not actually say ok", async () => {
      stubSlackHook("invalid_payload", 200);

      const result = await new SlackTransport().send(hookTask());

      expect(result).toEqual({ success: false, invalidToken: false, error: "invalid_payload" });
    });

    it("logs both outcomes", async () => {
      const log = logger();
      stubSlackHook("ok");
      await new SlackTransport({ appId: "A9", logger: log }).send(hookTask());
      expect(log.debug).toHaveBeenCalledWith(
        {
          taskId: "task-uuid-slack-1",
          appId: "A9",
          providerMessageId: "slack-webhook-task-uuid-slack-1",
        },
        "Slack webhook message sent",
      );

      stubSlackHook("no_service", 404);
      await new SlackTransport({ appId: "A9", logger: log }).send(hookTask());
      expect(log.warn).toHaveBeenCalledWith(
        {
          taskId: "task-uuid-slack-1",
          appId: "A9",
          status: 404,
          body: "no_service",
          invalidToken: true,
        },
        "Slack incoming webhook failed",
      );
    });

    it("reports a transport-level failure", async () => {
      const log = logger();
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("dns failure")));

      const result = await new SlackTransport({ logger: log }).send(hookTask());

      expect(result).toEqual({ success: false, error: "dns failure" });
      expect(log.error).toHaveBeenCalledWith(
        { taskId: "task-uuid-slack-1", error: "dns failure" },
        "Slack unexpected error",
      );
    });

    it("cancels the request when delivery aborts the send", async () => {
      stubSlowFetch({ ok: true, status: 200, text: async () => "ok" });

      const result = await new SlackTransport().send(
        slackTask({ destination: HOOK_URL, signal: timeoutSignal() }),
      );

      expect(result).toEqual({ success: false, error: "Transport timeout after 20ms" });
    });
  });
});

import { WhatsAppTransport } from "../packages/provider-whatsapp/src/index.js";

describe("WhatsAppTransport (WhatsApp Provider)", () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as any;

  function whatsappTransport(overrides: Record<string, unknown> = {}) {
    return new WhatsAppTransport({
      phoneNumberId: "phone-12345",
      accessToken: "meta-access-token",
      ...overrides,
    } as any);
  }

  function whatsappTask(overrides: Record<string, unknown> = {}): any {
    return {
      taskId: "task-uuid-wa-1",
      destination: "+1 (555) 123-4567",
      renderedContent: { content: { text: "Your verification code is 123456" } },
      ...overrides,
    };
  }

  it("exposes the whatsapp channel", () => {
    expect(whatsappTransport().channel).toBe("whatsapp");
    expect(whatsappTransport().webhookPath).toBe("/webhooks/whatsapp");
  });

  it("fails if recipient has no phone number", async () => {
    const result = await whatsappTransport().send(whatsappTask({ destination: undefined }));
    expect(result).toEqual({
      success: false,
      retryable: false,
      error: "No phone number on recipient; cannot send WhatsApp message.",
    });
  });

  it("fails if template has no text content", async () => {
    const result = await whatsappTransport().send(
      whatsappTask({ renderedContent: { content: {} } }),
    );
    expect(result).toEqual({
      success: false,
      retryable: false,
      error: "Template has no 'text' content for the whatsapp channel.",
    });
  });

  it("sends text message via Meta Graph API successfully", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        messaging_product: "whatsapp",
        contacts: [{ input: "15551234567", wa_id: "15551234567" }],
        messages: [{ id: "wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQT..." }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await whatsappTransport().send(whatsappTask());

    expect(result).toEqual({
      success: true,
      providerMessageId: "wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQT...",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v21.0/phone-12345/messages",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer meta-access-token",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: "15551234567",
          type: "text",
          text: { body: "Your verification code is 123456" },
        }),
      }),
    );
  });

  it("does not blame the recipient when our own access token is rejected", async () => {
    // 401 / code 190 is the sender's access token expiring. Flagging it as
    // invalidToken would deactivate every recipient's WhatsApp contact.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: { message: "Invalid OAuth access token", code: 190 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await whatsappTransport().send(whatsappTask());

    expect(result).toEqual({
      success: false,
      error: "Invalid OAuth access token",
      invalidToken: false,
      retryable: false,
    });
  });

  it.each([
    [400, 130429, true],
    [400, 131056, true],
    [400, 80007, true],
    [429, undefined, true],
    [500, 131000, undefined],
  ])("reports a %i with code %s as throttled=%s", async (status, code, throttled) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status,
        json: async () => ({ error: { message: "slow down", code } }),
      }),
    );

    const result = await whatsappTransport().send(whatsappTask());

    expect(result.throttled).toBe(throttled);
    expect(result.retryable).not.toBe(false);
  });

  it("handles fetch exception gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const result = await whatsappTransport().send(whatsappTask());

    expect(result).toEqual({
      success: false,
      error: "network error",
    });
  });

  it("logs error when send fails", async () => {
    const log = logger();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: "Server error" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await whatsappTransport({ logger: log }).send(whatsappTask());

    expect(log.error).toHaveBeenCalledWith(
      { status: 500, error: { message: "Server error" } },
      "WhatsApp send failed",
    );
  });

  describe("Webhook verification & parsing", () => {
    it("handles hub.challenge verification when valid", () => {
      const transport = whatsappTransport({ verifyToken: "secret-token-123" });
      const query = new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.verify_token": "secret-token-123",
        "hub.challenge": "challenge_12345",
      });

      expect(transport.verifyWebhookChallenge(query)).toBe("challenge_12345");
    });

    it("rejects challenge on token mismatch or missing configuration", () => {
      const transportWithoutToken = whatsappTransport();
      const query = new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.verify_token": "secret-token-123",
        "hub.challenge": "challenge_12345",
      });

      expect(transportWithoutToken.verifyWebhookChallenge(query)).toBeUndefined();

      const transportWithToken = whatsappTransport({ verifyToken: "secret-token-123" });
      const badQuery = new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong-token",
        "hub.challenge": "challenge_12345",
      });
      expect(transportWithToken.verifyWebhookChallenge(badQuery)).toBeUndefined();
    });

    it("verifies webhook signature with appSecret", () => {
      const appSecret = "meta-app-secret-xyz";
      const transport = whatsappTransport({ appSecret });
      const body = JSON.stringify({ entry: [] });
      const sig = createHmac("sha256", appSecret).update(body).digest("hex");

      expect(
        transport.verifyWebhook(body, {
          "x-hub-signature-256": `sha256=${sig}`,
        }),
      ).toBe(true);

      expect(
        transport.verifyWebhook(body, {
          "x-hub-signature-256": "sha256=invalid-signature",
        }),
      ).toBe(false);

      expect(transport.verifyWebhook(body, {})).toBe(false);
      expect(
        whatsappTransport().verifyWebhook(body, { "x-hub-signature-256": `sha256=${sig}` }),
      ).toBe(false);
    });

    it("parses webhook status events (read and failed)", async () => {
      const transport = whatsappTransport();
      const webhookPayload = {
        entry: [
          {
            changes: [
              {
                value: {
                  statuses: [
                    {
                      id: "msg-1",
                      status: "read",
                      recipient_id: "15551234567",
                      timestamp: "1700000000",
                    },
                    {
                      id: "msg-2",
                      status: "failed",
                      recipient_id: "15559876543",
                      timestamp: "1700000010",
                      errors: [{ code: 131051, title: "Message failed to send" }],
                    },
                    {
                      id: "msg-3",
                      status: "delivered",
                      recipient_id: "15550000000",
                      timestamp: "1700000020",
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const events = await transport.parseWebhook(webhookPayload);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        providerMessageId: "msg-1",
        status: "opened",
        timestamp: new Date(1700000000 * 1000),
        recipient: "15551234567",
      });
      expect(events[1]).toEqual({
        providerMessageId: "msg-2",
        status: "bounced",
        timestamp: new Date(1700000010 * 1000),
        recipient: "15559876543",
        metadata: { errors: [{ code: 131051, title: "Message failed to send" }] },
      });
    });
  });
});

// ─── Fixes: one regression test per provider ───────────────────────────────────

describe("provider regressions", () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as any;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("console: labels output with the configured channel, not always push", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = logger();
    try {
      await new ConsoleTransport({ channel: "email", logger: log }).send({
        taskId: "t1",
        recipientId: "u1",
        destination: "a@b.c",
        priority: "normal",
        renderedContent: { content: { body: "hi" } },
      } as any);
      const printed = String(logSpy.mock.calls[0]![0]);
      expect(printed).toContain("EMAIL NOTIFICATION");
      expect(printed).not.toContain("PUSH");
      expect(log.info.mock.calls[0]![1]).toBe("email delivered (console transport)");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("fcm: a malformed service account fails the send instead of throwing", async () => {
    const transport = new FcmTransport({ serviceAccountJson: "not json" });

    const result = await transport.send({
      taskId: "t1",
      enrichedEventId: "e1",
      destination: "tok",
      renderedContent: { content: { body: "hi" } },
    } as any);

    expect(result.success).toBe(false);
    expect(result.invalidToken).toBeFalsy();
  });

  it("slack: keeps the subject when a body is also rendered", async () => {
    const fetchMock = stubSlackApi({ ok: true, ts: "1.2", channel: "C1" });

    await new SlackTransport({ botToken: SLACK_BOT_TOKEN }).send(
      slackTask({ renderedContent: { content: { subject: "Deploy", body: "shipped" } } }),
    );

    expect(slackBody(fetchMock).text).toBe("*Deploy*\nshipped");
  });

  it("whatsapp: falls back to content.body like every other provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: "wamid.1" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new WhatsAppTransport({
      phoneNumberId: "p1",
      accessToken: "tok",
    }).send({
      taskId: "t1",
      destination: "+15551234567",
      renderedContent: { content: { body: "from body" } },
    } as any);

    expect(result.success).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).text.body).toBe("from body");
  });

  it("discord: truncates content to Discord's 2000-character limit", async () => {
    const fetchMock = stubDiscord({ id: "m1" });

    await new DiscordTransport().send(
      discordTask({ renderedContent: { content: { body: "x".repeat(2500) } } }),
    );

    const content: string = discordBody(fetchMock).content;
    expect(content.length).toBe(2000);
    expect(content.endsWith("…")).toBe(true);
  });

  it("telegram: truncates plain text to Telegram's 4096-character limit", async () => {
    const fetchMock = stubTelegram({ ok: true, result: { message_id: 1 } });

    await telegramTransport().send(
      telegramTask({ renderedContent: { content: { text: "x".repeat(5000) } } }),
    );

    const text: string = telegramBody(fetchMock).text;
    expect(text.length).toBe(4096);
    expect(text.endsWith("…")).toBe(true);
  });

  it("telegram: leaves formatted text alone, since cutting markup would break it", async () => {
    const fetchMock = stubTelegram({ ok: true, result: { message_id: 1 } });

    await telegramTransport({ parseMode: "HTML" }).send(
      telegramTask({ renderedContent: { content: { text: "x".repeat(5000) } } }),
    );

    expect(telegramBody(fetchMock).text.length).toBe(5000);
  });

  it("twilio: truncates the body to Twilio's 1600-character limit", async () => {
    mockCreateMessage.mockReset();
    mockCreateMessage.mockResolvedValueOnce({ sid: "SM1", status: "queued" });

    await twilioTransport().send(
      smsTask({ renderedContent: { content: { body: "x".repeat(2000) } } }),
    );

    const body: string = mockCreateMessage.mock.calls[0]![0].body;
    expect(body.length).toBe(1600);
    expect(body.endsWith("…")).toBe(true);
  });
});

import { createServer } from "node:net";
import type { NodemailerError } from "nodemailer";
import { SmtpTransport } from "../packages/provider-smtp/src/index.js";

describe("SmtpTransport (SMTP Provider)", () => {
  const smtpTask = (content: Record<string, unknown> = {}, overrides = {}): any => ({
    taskId: "task-uuid-123",
    destination: "recipient@example.com",
    renderedContent: {
      content: {
        subject: "Welcome Alice",
        body: "Hello Alice",
        htmlBody: "<h1>Hello Alice</h1>",
        ...content,
      },
    },
    ...overrides,
  });

  // nodemailer's stream transport builds the message the way the SMTP
  // transport does, then hands it back instead of sending it, so these tests
  // read the exact message without an SMTP server.
  const streamSmtp = () => {
    const transport = new SmtpTransport({
      smtp: { streamTransport: true, buffer: true, newline: "unix" } as any,
      from: "notifications@example.com",
    });
    const sendMail = vi.spyOn((transport as any).transporter, "sendMail");
    const sent = async (): Promise<string> =>
      ((await sendMail.mock.results[0]!.value) as { message: Buffer }).message.toString();
    return { transport, sendMail, sent };
  };

  // A transport plugin that fails every send with `error`, shaped like the
  // errors nodemailer's SMTP transport passes back for a refused message.
  const failingSmtp = (error: Partial<NodemailerError>) =>
    new SmtpTransport({
      smtp: {
        name: "failing",
        version: "1.0.0",
        send: (_mail: unknown, callback: (err: Error) => void) =>
          callback(Object.assign(new Error(error.message), error)),
      } as any,
      from: "notifications@example.com",
    });

  it("sends the email and returns its Message-ID as providerMessageId", async () => {
    const { transport, sent } = streamSmtp();

    const result = await transport.send(smtpTask());

    expect(result.success).toBe(true);
    expect(result.providerMessageId).toMatch(/^<.+@example\.com>$/);

    const message = await sent();
    expect(message).toContain("From: notifications@example.com\n");
    expect(message).toContain("To: recipient@example.com\n");
    expect(message).toContain("Subject: Welcome Alice\n");
    expect(message).toContain(`Message-ID: ${result.providerMessageId}\n`);
    expect(message).toContain("Content-Type: text/plain");
    expect(message).toContain("Hello Alice");
    expect(message).toContain("Content-Type: text/html");
    expect(message).toContain("<h1>Hello Alice</h1>");
  });

  it("builds an escaped HTML part for a text-only template", async () => {
    const { transport, sent } = streamSmtp();

    await transport.send(smtpTask({ htmlBody: undefined, body: "Hi <b>Alice</b>\nBye" }));

    expect(await sent()).toContain("<p>Hi &lt;b&gt;Alice&lt;/b&gt;<br>Bye</p>");
  });

  it("uses the template's from and replyTo, and passes the unsubscribe headers", async () => {
    const { transport, sent } = streamSmtp();

    await transport.send(
      smtpTask(
        { from: "Acme Offers <marketing@example.com>", replyTo: "hello@example.com" },
        { deliveryOptions: { headers: { "List-Unsubscribe": "<https://x/u?t=1>" } } },
      ),
    );

    const message = await sent();
    expect(message).toContain("From: Acme Offers <marketing@example.com>\n");
    expect(message).toContain("Reply-To: hello@example.com\n");
    expect(message).toContain("List-Unsubscribe: <https://x/u?t=1>\n");
  });

  it("falls back to the constructor's from when the template's is not a string", async () => {
    const { transport, sent } = streamSmtp();

    await transport.send(smtpTask({ from: 123 }));

    expect(await sent()).toContain("From: notifications@example.com\n");
  });

  it("fails without sending when the task has no destination", async () => {
    const { transport, sendMail } = streamSmtp();

    const result = await transport.send(smtpTask({}, { destination: undefined }));

    expect(result).toEqual({
      success: false,
      retryable: false,
      error: "No destination (recipient address) on task",
    });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it.each([
    ["a tag after the address", "alice@example.com<br>"],
    ["only a tag", "<br>"],
    ["angle brackets in the local part", "bad<x>@example.com"],
    ["a display name", "Alice <alice@example.com>"],
    ["no @", "not-an-address"],
    ["two @", "alice@@example.com"],
    ["no domain", "alice@"],
    ["a space", "a b@example.com"],
    ["a line break", "alice@example.com\r\nbob@example.com"],
    ["a comma-separated list", "alice@example.com, bob@example.com"],
    ["a semicolon-separated list", "alice@example.com;bob@example.com"],
    ["a comma in the local part", "a,b@example.com"],
    ["a semicolon in the local part", "a;b@example.com"],
    ["a group name", "team:alice@example.com"],
    ["a comment", "alice(work)@example.com"],
    ["quotes", '"alice"@example.com'],
    ["an unmatched <", "<alice@example.com"],
    ["an unmatched >", "alice@example.com>"],
    ["an unmatched (", "alice(work@example.com"],
    ["an unmatched )", "alice)work@example.com"],
  ])("fails without sending when the destination has %s", async (_name, destination) => {
    const { transport, sendMail } = streamSmtp();

    const result = await transport.send(smtpTask({}, { destination }));

    expect(result).toEqual({
      success: false,
      retryable: false,
      error: "Destination is not a single email address",
    });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it.each(["first.last+tag@sub.example.co.uk", "o'brien@example.com", "üser@exämple.com"])(
    "sends to %s",
    async (destination) => {
      const { transport, sendMail } = streamSmtp();

      const result = await transport.send(smtpTask({}, { destination }));

      expect(result.success).toBe(true);
      expect(sendMail.mock.calls[0]![0]).toMatchObject({ to: destination });
    },
  );

  it("does not retry an envelope nodemailer refuses before sending it", async () => {
    const result = await failingSmtp({
      message: "No recipients defined",
      code: "EENVELOPE",
      command: "API",
    }).send(smtpTask());

    expect(result).toEqual({
      success: false,
      retryable: false,
      error: "No recipients defined",
    });
  });

  it("does not retry a permanent rejection (5xx)", async () => {
    const result = await failingSmtp({
      message:
        "Can't send mail - all recipients were rejected: 550 5.1.1 <recipient@example.com>: Recipient address rejected: User unknown",
      code: "EENVELOPE",
      command: "RCPT TO",
      responseCode: 550,
      permanent: true,
    }).send(smtpTask());

    expect(result).toEqual({
      success: false,
      retryable: false,
      error:
        "Can't send mail - all recipients were rejected: 550 5.1.1 <recipient@example.com>: Recipient address rejected: User unknown",
    });
  });

  it.each([
    [451, "451 4.7.1 Greylisted, try again later"],
    [421, "421 4.3.2 Service shutting down"],
    // nodemailer counts 503 (bad sequence of commands) as transient: a new
    // connection gets past it.
    [503, "503 5.5.1 Error: nested MAIL command"],
  ])("retries a transient rejection (%i)", async (responseCode, response) => {
    const result = await failingSmtp({
      message: `Mail command failed: ${response}`,
      code: "EENVELOPE",
      command: "MAIL FROM",
      response,
      responseCode,
      permanent: false,
    }).send(smtpTask());

    expect(result.success).toBe(false);
    expect(result).not.toHaveProperty("retryable");
    expect(result.error).toBe(`Mail command failed: ${response}`);
  });

  it("retries when the server can't be reached", async () => {
    // A port that was free a moment ago, so the connection is refused.
    const port = await new Promise<number>((resolve) => {
      const server = createServer().listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        server.close(() => resolve(port));
      });
    });
    const transport = new SmtpTransport({
      smtp: { host: "127.0.0.1", port },
      from: "notifications@example.com",
    });

    const result = await transport.send(smtpTask());

    expect(result.success).toBe(false);
    expect(result).not.toHaveProperty("retryable");
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it("gives up on a stalled server within delivery's send timeout", () => {
    // nodemailer's defaults (2 min connect, 30 s greeting, 10 min socket) far
    // outlast delivery's 10 s per-send timeout, so a hung server held sockets
    // and pool slots for minutes after the send had already been given up.
    const options = (smtp: any) =>
      (new SmtpTransport({ smtp, from: "n@example.com" }) as any).transporter.transporter.options;

    expect(options({ host: "127.0.0.1", port: 25 })).toMatchObject({
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });
    expect(options({ host: "127.0.0.1", port: 25, pool: true })).toMatchObject({
      socketTimeout: 10_000,
    });
    expect(options({ host: "127.0.0.1", socketTimeout: 60_000 })).toMatchObject({
      socketTimeout: 60_000,
      connectionTimeout: 10_000,
    });
    expect(options("smtp://127.0.0.1:25")).toMatchObject({ socketTimeout: 10_000 });
    expect(options("smtp://127.0.0.1:25?socketTimeout=60000")).toMatchObject({
      socketTimeout: 60_000,
    });
  });

  it("close() closes the underlying transporter", () => {
    const close = vi.fn();
    const transport = new SmtpTransport({
      smtp: { name: "closable", version: "1.0.0", send: vi.fn(), close } as any,
      from: "notifications@example.com",
    });

    transport.close();

    expect(close).toHaveBeenCalledOnce();
  });
});

import { Readable } from "node:stream";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { SesTransport } from "../packages/provider-ses/src/index.js";

describe("SesTransport (AWS SES Provider)", () => {
  const sesTask = (content: Record<string, unknown> = {}, overrides = {}): any => ({
    taskId: "task-uuid-123",
    destination: "recipient@example.com",
    renderedContent: {
      content: {
        subject: "Welcome Alice",
        body: "Hello Alice",
        htmlBody: "<h1>Hello Alice</h1>",
        ...content,
      },
    },
    ...overrides,
  });

  interface Reply {
    status: number;
    type?: string;
    body: unknown;
  }

  const limits = { limit: 14, windowSeconds: 1 };

  // A real SESv2 client with its HTTP layer swapped out, so these tests read
  // the exact signed request and the SDK parses SES's error replies the way it
  // does in production. Nothing leaves the machine.
  const sesWith = (
    reply: (options: { abortSignal?: AbortSignal }) => Reply | Promise<Reply>,
    options: Partial<ConstructorParameters<typeof SesTransport>[0]> = {},
  ) => {
    const handle = vi.fn(async (_request: any, handlerOptions: { abortSignal?: AbortSignal }) => {
      const { status, type, body } = await reply(handlerOptions ?? {});
      return {
        response: {
          statusCode: status,
          headers: {
            "content-type": "application/json",
            ...(type ? { "x-amzn-errortype": type } : {}),
          },
          body: Readable.from([Buffer.from(JSON.stringify(body))]),
        },
      };
    });
    const client = new SESv2Client({
      region: "eu-west-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      maxAttempts: 1,
      requestHandler: { handle } as any,
    });
    const transport = new SesTransport({
      client,
      from: "notifications@example.com",
      limits,
      ...options,
    });
    const request = () => handle.mock.calls[0]![0];
    const sent = () => JSON.parse(new TextDecoder().decode(request().body));
    return { transport, handle, request, sent };
  };

  const accepted = (): Reply => ({ status: 200, body: { MessageId: "ses-message-id-123" } });

  it("sends the email and returns SES's MessageId as providerMessageId", async () => {
    const { transport, request, sent } = sesWith(accepted);

    const result = await transport.send(sesTask());

    expect(result).toEqual({ success: true, providerMessageId: "ses-message-id-123" });
    expect(request()).toMatchObject({
      method: "POST",
      hostname: "email.eu-west-1.amazonaws.com",
      path: "/v2/email/outbound-emails",
    });
    expect(request().headers["content-type"]).toBe("application/json");
    expect(request().headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=test\//);
    expect(sent()).toEqual({
      FromEmailAddress: "notifications@example.com",
      Destination: { ToAddresses: ["recipient@example.com"] },
      Content: {
        Simple: {
          Subject: { Data: "Welcome Alice", Charset: "UTF-8" },
          Body: {
            Text: { Data: "Hello Alice", Charset: "UTF-8" },
            Html: { Data: "<h1>Hello Alice</h1>", Charset: "UTF-8" },
          },
        },
      },
    });
  });

  it("builds an escaped HTML part for a text-only template", async () => {
    const { transport, sent } = sesWith(accepted);

    await transport.send(sesTask({ htmlBody: undefined, body: "Hi <b>Alice</b>\nBye" }));

    expect(sent().Content.Simple.Body.Html).toEqual({
      Data: "<p>Hi &lt;b&gt;Alice&lt;/b&gt;<br>Bye</p>",
      Charset: "UTF-8",
    });
  });

  it("uses the template's from and replyTo, the unsubscribe headers and the configuration set", async () => {
    const { transport, sent } = sesWith(accepted, { configurationSetName: "notifkit-events" });

    await transport.send(
      sesTask(
        { from: "Acme Offers <marketing@example.com>", replyTo: "hello@example.com" },
        {
          deliveryOptions: {
            headers: {
              "List-Unsubscribe": "<https://x/u?t=1>",
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
          },
        },
      ),
    );

    expect(sent()).toMatchObject({
      FromEmailAddress: "Acme Offers <marketing@example.com>",
      ReplyToAddresses: ["hello@example.com"],
      ConfigurationSetName: "notifkit-events",
      Content: {
        Simple: {
          Headers: [
            { Name: "List-Unsubscribe", Value: "<https://x/u?t=1>" },
            { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
          ],
        },
      },
    });
  });

  it("falls back to the constructor's from when the template's is not a string", async () => {
    const { transport, sent } = sesWith(accepted);

    await transport.send(sesTask({ from: 123 }));

    expect(sent().FromEmailAddress).toBe("notifications@example.com");
  });

  it("fails without calling SES when the task has no destination", async () => {
    const { transport, handle } = sesWith(accepted);

    const result = await transport.send(sesTask({}, { destination: undefined }));

    expect(result).toEqual({
      success: false,
      retryable: false,
      error: "No destination (recipient address) on task",
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it.each([
    [400, "MessageRejected", "Email address is not verified."],
    [400, "MailFromDomainNotVerifiedException", "MAIL FROM domain is not verified."],
    [400, "BadRequestException", "Missing final '@domain'"],
    [400, "SendingPausedException", "Sending is paused for this account."],
    [400, "AccountSuspendedException", "Sending is suspended for this account."],
    [404, "NotFoundException", "Configuration set <notifkit-events> does not exist."],
  ])("does not retry a %i %s", async (status, type, message) => {
    const { transport } = sesWith(() => ({ status, type, body: { message } }));

    const result = await transport.send(sesTask());

    expect(result).toEqual({ success: false, retryable: false, error: `${type}: ${message}` });
  });

  it.each([
    [429, "TooManyRequestsException", "Too many requests.", true],
    // SES reports its send rate and daily quota as throttling, sent as a 400.
    [400, "ThrottlingException", "Maximum sending rate exceeded.", true],
    // Resets over 24 hours: waiting can't help, so it takes the ordinary retries.
    [400, "ThrottlingException", "Daily message quota exceeded.", false],
    [
      400,
      "LimitExceededException",
      "There are too many instances of the specified resource type.",
      true,
    ],
    [500, "InternalServiceErrorException", "Internal failure.", false],
    [408, "RequestTimeoutException", "Request timed out.", false],
  ])("retries a %i %s", async (status, type, message, throttled) => {
    const { transport } = sesWith(() => ({ status, type, body: { message } }));

    const result = await transport.send(sesTask());

    expect(result).toEqual({
      success: false,
      ...(throttled ? { throttled } : {}),
      error: `${type}: ${message}`,
    });
  });

  it("retries a 429 that has no SES error name", async () => {
    const { transport } = sesWith(() => ({ status: 429, body: {} }));

    const result = await transport.send(sesTask());

    expect(result).toEqual({ success: false, throttled: true, error: "Unknown: UnknownError" });
  });

  it("retries when SES can't be reached", async () => {
    const { transport } = sesWith(() => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
        code: "ECONNREFUSED",
      });
    });

    const result = await transport.send(sesTask());

    expect(result).toEqual({ success: false, error: "Error: connect ECONNREFUSED 127.0.0.1:443" });
  });

  // A request that never gets an answer, until its abort signal fires.
  const hang = ({ abortSignal }: { abortSignal?: AbortSignal }) =>
    new Promise<Reply>((_, reject) =>
      abortSignal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("Request aborted"), { name: "AbortError" })),
      ),
    );

  it("cancels the request when delivery aborts the send", async () => {
    const { transport, handle } = sesWith(hang);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("Transport timeout after 50ms")), 50);

    const result = await transport.send(sesTask({}, { signal: controller.signal }));

    expect(handle.mock.calls[0]![1]?.abortSignal?.aborted).toBe(true);
    expect(result).toEqual({ success: false, error: "AbortError: Request aborted" });
  });

  it("times out on its own after deliveryOptions.timeoutMs when called without a signal", async () => {
    const { transport } = sesWith(hang);
    const started = Date.now();

    const result = await transport.send(sesTask({}, { deliveryOptions: { timeoutMs: 50 } }));

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toEqual({ success: false, error: "AbortError: Request aborted" });
  });

  it("requires limits, since send rates differ from one account to the next", () => {
    const options = { from: "notifications@example.com", region: "eu-west-1" };

    expect(() => new SesTransport(options as any)).toThrow("SesTransport: limits is required");
    expect(() => new SesTransport({ ...options, limits: { limit: 0, windowSeconds: 1 } })).toThrow(
      "SesTransport: limits is required",
    );
    expect(() => new SesTransport({ ...options, limits: { limit: 14 } as any })).toThrow(
      "SesTransport: limits is required",
    );
    expect(new SesTransport({ ...options, limits }).limits).toEqual(limits);
  });

  it("builds its own client in the given region, with the SDK's retries turned off", async () => {
    const transport = new SesTransport({
      from: "notifications@example.com",
      region: "eu-west-1",
      limits,
    });
    const config = (transport as any).client.config;

    expect(await config.region()).toBe("eu-west-1");
    expect(await config.maxAttempts()).toBe(1);
  });

  it("close() destroys its own client but leaves a passed-in client open", () => {
    const own = new SesTransport({
      from: "notifications@example.com",
      region: "eu-west-1",
      limits,
    });
    const ownDestroy = vi.spyOn((own as any).client, "destroy");
    const client = new SESv2Client({ region: "eu-west-1" });
    const passedDestroy = vi.spyOn(client, "destroy");
    const passed = new SesTransport({ from: "notifications@example.com", client, limits });

    own.close();
    passed.close();

    expect(ownDestroy).toHaveBeenCalledOnce();
    expect(passedDestroy).not.toHaveBeenCalled();
  });
});

import { generateKeyPairSync, sign as signWithKey } from "node:crypto";
import type { MockInstance } from "vitest";

describe("SesTransport (SNS webhooks)", () => {
  const topicArn = "arn:aws:sns:eu-west-1:123456789012:ses-feedback";
  const certUrl = "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-test.pem";
  const subscribeUrl =
    "https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=t";
  // A key made for the test run. SNS signs with its own key and publishes the
  // certificate at SigningCertURL; fetch is stubbed to serve this public half.
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  let fetchMock: MockInstance<typeof fetch>;
  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof URL ? input.href : String(input);
      if (url === certUrl) return new Response(publicPem);
      if (url === subscribeUrl) return new Response("<ConfirmSubscriptionResponse/>");
      return new Response("not found", { status: 404 });
    });
  });
  afterEach(() => {
    fetchMock.mockRestore();
  });

  const limits = { limit: 14, windowSeconds: 1 };
  const transport = (snsTopicArns: string[] = [topicArn]) =>
    new SesTransport({
      from: "notifications@example.com",
      region: "eu-west-1",
      limits,
      snsTopicArns,
    });

  // SNS signs these fields in this order, each as `Name\nvalue\n`, with Subject
  // only when the message has one.
  function stringToSign(m: Record<string, string>) {
    const fields =
      m.Type === "Notification"
        ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
        : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
    return fields
      .filter((f) => m[f] !== undefined)
      .map((f) => `${f}\n${m[f]}\n`)
      .join("");
  }

  function snsBody(fields: Record<string, string>, version: "1" | "2" = "2") {
    const m: Record<string, string> = {
      Type: "Notification",
      MessageId: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324",
      TopicArn: topicArn,
      Timestamp: "2026-11-19T08:00:00.000Z",
      SignatureVersion: version,
      SigningCertURL: certUrl,
      ...fields,
    };
    const data = Buffer.from(stringToSign(m), "utf8");
    m.Signature = signWithKey(version === "1" ? "sha1" : "sha256", data, privateKey).toString(
      "base64",
    );
    return JSON.stringify(m);
  }

  const mail = { messageId: "ses-message-id-123", destination: ["alice@example.com"] };
  const bounce = (bounceType: string, recipients = ["alice@example.com"]) =>
    JSON.stringify({
      notificationType: "Bounce",
      mail,
      bounce: {
        bounceType,
        bounceSubType: "General",
        bouncedRecipients: recipients.map((emailAddress) => ({
          emailAddress,
          action: "failed",
          status: "5.1.1",
          diagnosticCode: "smtp; 550 5.1.1 user unknown",
        })),
        timestamp: "2026-11-19T08:00:01.000Z",
        feedbackId: "0102018f-feedback",
      },
    });
  const complaint = (complaintFeedbackType = "abuse") =>
    JSON.stringify({
      notificationType: "Complaint",
      mail,
      complaint: {
        complainedRecipients: [{ emailAddress: "alice@example.com" }],
        complaintFeedbackType,
        timestamp: "2026-11-19T08:00:02.000Z",
        feedbackId: "0102018f-feedback",
      },
    });

  it("exposes the webhook route, the signature gate and the parser", () => {
    const ses = transport();
    expect(ses.webhookPath).toBe("/webhooks/ses");
    expect(typeof ses.verifyWebhook).toBe("function");
    expect(typeof ses.parseWebhook).toBe("function");
  });

  it("accepts a message signed over the string AWS documents", async () => {
    // Written out by hand from the AWS docs, not built by the code under test.
    const signed =
      "Message\nMy Test Message\nMessageId\n4d4dc071-ddbf-465d-bba8-08f81c89da64\n" +
      "Subject\nMy subject\nTimestamp\n2019-01-31T04:37:04.321Z\n" +
      `TopicArn\n${topicArn}\nType\nNotification\n`;
    const rawBody = JSON.stringify({
      Type: "Notification",
      MessageId: "4d4dc071-ddbf-465d-bba8-08f81c89da64",
      TopicArn: topicArn,
      Subject: "My subject",
      Message: "My Test Message",
      Timestamp: "2019-01-31T04:37:04.321Z",
      SignatureVersion: "2",
      Signature: signWithKey("sha256", Buffer.from(signed), privateKey).toString("base64"),
      SigningCertURL: certUrl,
    });

    expect(await transport().verifyWebhook(rawBody)).toBe(true);
  });

  it("accepts SignatureVersion 1 (SHA1) and a notification without a Subject", async () => {
    expect(await transport().verifyWebhook(snsBody({ Message: bounce("Permanent") }, "1"))).toBe(
      true,
    );
  });

  it("rejects a message whose content was changed after signing", async () => {
    const signed = JSON.parse(snsBody({ Message: bounce("Permanent") }));
    signed.Message = bounce("Permanent", ["someone-else@example.com"]);

    expect(await transport().verifyWebhook(JSON.stringify(signed))).toBe(false);
  });

  it("rejects a correctly signed message from a topic it wasn't given", async () => {
    // Anyone can create an SNS topic, subscribe this endpoint and publish to it.
    const rawBody = snsBody({
      Message: bounce("Permanent"),
      TopicArn: "arn:aws:sns:eu-west-1:999999999999:not-yours",
    });

    expect(await transport().verifyWebhook(rawBody)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects everything when no snsTopicArns are configured", async () => {
    const rawBody = snsBody({ Message: bounce("Permanent") });

    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;
    const unconfigured = new SesTransport({
      from: "notifications@example.com",
      region: "eu-west-1",
      limits,
      logger,
    });
    expect(await unconfigured.verifyWebhook(rawBody)).toBe(false);
    expect(await transport([]).verifyWebhook(rawBody)).toBe(false);
    // Says what's missing, rather than only that the topic is unexpected.
    expect(logger.error).toHaveBeenCalledWith(
      "SES webhook rejected: snsTopicArns is not configured",
    );
  });

  it.each([
    ["plain HTTP", "http://sns.eu-west-1.amazonaws.com/SimpleNotificationService-test.pem"],
    ["a look-alike host", "https://sns.eu-west-1.amazonaws.com.evil.example/cert.pem"],
    ["another host", "https://evil.example/sns.eu-west-1.amazonaws.com.pem"],
    ["a port", "https://sns.eu-west-1.amazonaws.com:8443/SimpleNotificationService-test.pem"],
    ["credentials", "https://user@sns.eu-west-1.amazonaws.com/SimpleNotificationService-test.pem"],
    ["a path that isn't a .pem", "https://sns.eu-west-1.amazonaws.com/cert.txt"],
    ["not a URL", "sns.eu-west-1.amazonaws.com/SimpleNotificationService-test.pem"],
  ])("never fetches a signing certificate URL with %s", async (_name, url) => {
    const rawBody = snsBody({ Message: bounce("Permanent"), SigningCertURL: url });

    expect(await transport().verifyWebhook(rawBody)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown SignatureVersion", async () => {
    const signed = JSON.parse(snsBody({ Message: bounce("Permanent") }));
    signed.SignatureVersion = "3";

    expect(await transport().verifyWebhook(JSON.stringify(signed))).toBe(false);
  });

  it.each([
    ["a body that isn't JSON", "not json"],
    ["an empty body", ""],
    // What SNS sends when raw message delivery is on: no envelope, no signature.
    ["the bare SES payload", bounce("Permanent")],
    [
      "an envelope without a Signature",
      JSON.stringify({ ...JSON.parse(snsBody({ Message: "x" })), Signature: undefined }),
    ],
    [
      "a confirmation without a Token",
      snsBody({ Type: "SubscriptionConfirmation", Message: "x", SubscribeURL: subscribeUrl }),
    ],
  ])("rejects %s", async (_name, rawBody) => {
    expect(await transport().verifyWebhook(rawBody)).toBe(false);
  });

  it("fetches each signing certificate once", async () => {
    const ses = transport();
    await ses.verifyWebhook(snsBody({ Message: bounce("Permanent") }));
    await ses.verifyWebhook(snsBody({ Message: complaint() }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A redirect could hand the request to a host outside SNS.
    expect(fetchMock).toHaveBeenCalledWith(certUrl, expect.objectContaining({ redirect: "error" }));
  });

  // SNS counts any 4xx as delivered, so a 401 here would lose the bounce. A
  // throw makes the route answer 500, and SNS sends the message again.
  it("throws when the certificate can't be fetched, and tries again next time", async () => {
    const ses = transport();
    const rawBody = snsBody({ Message: bounce("Permanent") });
    fetchMock
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(ses.verifyWebhook(rawBody)).rejects.toThrow("HTTP 503");
    await expect(ses.parseWebhook(JSON.parse(rawBody), rawBody)).rejects.toThrow("fetch failed");
    expect(await ses.verifyWebhook(rawBody)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects a message when the fetched certificate isn't one", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not a certificate"));

    expect(await transport().verifyWebhook(snsBody({ Message: bounce("Permanent") }))).toBe(false);
  });

  it("maps a permanent bounce to a hard bounce for each recipient", async () => {
    const rawBody = snsBody({
      Message: bounce("Permanent", ["alice@example.com", "bob@example.com"]),
    });

    const events = await transport().parseWebhook(JSON.parse(rawBody), rawBody);

    expect(events).toEqual(
      ["alice@example.com", "bob@example.com"].map((recipient) => ({
        providerMessageId: "ses-message-id-123",
        status: "bounced",
        timestamp: new Date("2026-11-19T08:00:01.000Z"),
        recipient,
        bounceType: "hard",
        metadata: {
          bounceType: "Permanent",
          bounceSubType: "General",
          diagnosticCode: "smtp; 550 5.1.1 user unknown",
        },
      })),
    );
  });

  it.each(["Transient", "Undetermined"])("maps a %s bounce to a soft bounce", async (type) => {
    const rawBody = snsBody({ Message: bounce(type) });

    const [event] = await transport().parseWebhook(JSON.parse(rawBody), rawBody);

    expect(event).toMatchObject({ status: "bounced", bounceType: "soft" });
  });

  it("maps a complaint to complained for each recipient", async () => {
    const rawBody = snsBody({ Message: complaint() });

    const events = await transport().parseWebhook(JSON.parse(rawBody), rawBody);

    expect(events).toEqual([
      {
        providerMessageId: "ses-message-id-123",
        status: "complained",
        timestamp: new Date("2026-11-19T08:00:02.000Z"),
        recipient: "alice@example.com",
        metadata: { complaintFeedbackType: "abuse" },
      },
    ]);
  });

  it("ignores a not-spam report, which says the mail was wanted", async () => {
    const rawBody = snsBody({ Message: complaint("not-spam") });

    expect(await transport().parseWebhook(JSON.parse(rawBody), rawBody)).toEqual([]);
  });

  it("reads configuration-set event publishing, which names the field eventType", async () => {
    const event = JSON.parse(bounce("Permanent"));
    event.eventType = event.notificationType;
    delete event.notificationType;
    const rawBody = snsBody({ Message: JSON.stringify(event) });

    const [mapped] = await transport().parseWebhook(JSON.parse(rawBody), rawBody);

    expect(mapped).toMatchObject({ status: "bounced", bounceType: "hard" });
  });

  it("ignores delivery notifications", async () => {
    const rawBody = snsBody({
      Message: JSON.stringify({ notificationType: "Delivery", mail, delivery: {} }),
    });

    expect(await transport().parseWebhook(JSON.parse(rawBody), rawBody)).toEqual([]);
  });

  it("does not trust parseWebhook's input without checking the signature again", async () => {
    const signed = JSON.parse(snsBody({ Message: bounce("Permanent") }));
    signed.Message = bounce("Permanent", ["someone-else@example.com"]);
    const forged = JSON.stringify(signed);

    expect(await transport().parseWebhook(signed, forged)).toEqual([]);
  });

  const confirmation = (fields: Record<string, string> = {}) =>
    snsBody({
      Type: "SubscriptionConfirmation",
      Message: `You have chosen to subscribe to the topic ${topicArn}.`,
      SubscribeURL: subscribeUrl,
      Token: "t",
      ...fields,
    });

  it("confirms a subscription by visiting SubscribeURL, once the message checks out", async () => {
    const rawBody = confirmation();

    expect(await transport().parseWebhook(JSON.parse(rawBody), rawBody)).toEqual([]);
    const visited = fetchMock.mock.calls.map(([input]) => String(input));
    expect(visited).toEqual([certUrl, subscribeUrl]);
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ redirect: "error" });
  });

  it("never confirms a subscription to a topic it wasn't given", async () => {
    const rawBody = confirmation({ TopicArn: "arn:aws:sns:eu-west-1:999999999999:not-yours" });

    expect(await transport().parseWebhook(JSON.parse(rawBody), rawBody)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not visit a SubscribeURL outside SNS", async () => {
    const rawBody = confirmation({
      SubscribeURL: "https://evil.example/?Action=ConfirmSubscription",
    });

    expect(await transport().parseWebhook(JSON.parse(rawBody), rawBody)).toEqual([]);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([certUrl]);
  });

  it("acknowledges an unsubscribe confirmation without visiting anything", async () => {
    const rawBody = confirmation({ Type: "UnsubscribeConfirmation" });

    expect(await transport().parseWebhook(JSON.parse(rawBody), rawBody)).toEqual([]);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([certUrl]);
  });

  it("rejects a message type SNS doesn't send", async () => {
    expect(await transport().verifyWebhook(snsBody({ Type: "Something", Message: "x" }))).toBe(
      false,
    );
  });

  it("ignores an SNS message that isn't SES JSON", async () => {
    const rawBody = snsBody({ Message: "hello" });

    expect(await transport().verifyWebhook(rawBody)).toBe(true);
    expect(await transport().parseWebhook(JSON.parse(rawBody), rawBody)).toEqual([]);
  });

  it("keeps at most ten certificates, dropping the oldest", async () => {
    fetchMock.mockImplementation(async () => new Response(publicPem));
    const ses = transport();
    const urls = Array.from(
      { length: 11 },
      (_, i) => `https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-${i}.pem`,
    );
    for (const url of urls) {
      await ses.verifyWebhook(snsBody({ Message: "x", SigningCertURL: url }));
    }
    await ses.verifyWebhook(snsBody({ Message: "x", SigningCertURL: urls[10]! }));
    expect(fetchMock).toHaveBeenCalledTimes(11);

    await ses.verifyWebhook(snsBody({ Message: "x", SigningCertURL: urls[0]! }));
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });

  it("throws when the confirmation fails, so the route answers 500 and SNS sends it again", async () => {
    const rawBody = confirmation();
    const ses = transport();
    await ses.verifyWebhook(rawBody); // the certificate is cached now
    fetchMock.mockResolvedValueOnce(new Response("error", { status: 500 }));

    await expect(ses.parseWebhook(JSON.parse(rawBody), rawBody)).rejects.toThrow(/HTTP 500/);
  });
});
