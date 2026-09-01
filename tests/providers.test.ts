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
      error: "No destination (recipient phone number) on task",
    });
  });

  it("fails without reaching Twilio when the task carries no body", async () => {
    const result = await twilioTransport().send(
      smsTask({ renderedContent: { content: { subject: "no body here" } } }),
    );

    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: "No message body on task" });
  });

  it.each([
    [21211, "Invalid 'To' Phone Number"],
    [21610, "Attempt to send to unsubscribed recipient"],
    [21612, "Not reachable via SMS"],
    [21614, "'To' number is not a valid mobile number"],
  ])("flags a dead destination (%i) as an invalid token", async (code, message) => {
    mockCreateMessage.mockRejectedValueOnce(Object.assign(new Error(message), { code }));

    await expect(twilioTransport().send(smsTask())).resolves.toEqual({
      success: false,
      invalidToken: true,
      error: message,
    });
  });

  it("leaves a retryable failure retryable rather than suppressing the number", async () => {
    // 20429 is Twilio's rate limit: the number is fine, this attempt was not.
    mockCreateMessage.mockRejectedValueOnce(
      Object.assign(new Error("Too Many Requests"), { code: 20429 }),
    );

    await expect(twilioTransport().send(smsTask())).resolves.toEqual({
      success: false,
      invalidToken: false,
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
