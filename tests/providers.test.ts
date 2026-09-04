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

// ─── Telegram ────────────────────────────────────────────────────────────────

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

    expect(result).toEqual({ success: false, invalidToken, error: description });
  });

  it("falls back to a synthetic message when the API omits a description", async () => {
    stubTelegram({ ok: false, error_code: 429 });
    expect(await telegramTransport().send(telegramTask())).toEqual({
      success: false,
      invalidToken: false,
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

    expect(await telegramTransport().send(telegramTask())).toEqual({
      success: false,
      invalidToken: false,
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
      error: "No destination (Discord webhook URL) on task",
    });
  });

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
    [404, true],
    [401, true],
    [500, false],
    [429, false],
  ])("classifies a %i response as dead=%s", async (status, invalidToken) => {
    stubDiscord("rate limited or gone", status);

    const result = await new DiscordTransport().send(discordTask());

    expect(result).toEqual({
      success: false,
      invalidToken,
      error: `Discord webhook error ${status}: rate limited or gone`,
    });
  });

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

  it("rides the existing webhook channel rather than adding one of its own", () => {
    expect(new SlackTransport().channel).toBe("webhook");
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
        error: "No destination (Slack channel/user ID, or webhook URL) on task",
      });
    });

    it("refuses a channel id when no token is configured", async () => {
      const fetchMock = stubSlackApi({ ok: true });

      const result = await new SlackTransport().send(slackTask());

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
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
      ["channel_not_found", true],
      ["is_archived", true],
      ["channel_is_archived", true],
      ["user_not_found", true],
      ["account_inactive", true],
      ["not_in_channel", true],
      ["ratelimited", false],
      ["invalid_auth", false],
    ])("classifies %s as dead-destination=%s", async (error, invalidToken) => {
      stubSlackApi({ ok: false, error });

      const result = await new SlackTransport({ botToken: SLACK_BOT_TOKEN }).send(slackTask());

      expect(result).toEqual({ success: false, invalidToken, error });
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

      expect(result).toEqual({ success: false, invalidToken, error: body });
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
  });
});
