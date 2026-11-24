import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SendGridTransport } from "../packages/provider-sendgrid/src/index.js";

function signSendGridWebhook(privateKeyPem: string, timestamp: string, rawBody: string): string {
  return cryptoSign("sha256", Buffer.from(`${timestamp}${rawBody}`, "utf8"), privateKeyPem).toString(
    "base64",
  );
}

describe("SendGridTransport (Email Provider)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends an email via SendGrid v3 API and reads X-Message-Id", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 202,
        headers: { "X-Message-Id": "sg-msg-abc-123" },
      }),
    );

    const transport = new SendGridTransport({
      apiKey: "sg-test-api-key",
      from: "notifications@example.com",
    });

    const result = await transport.send({
      taskId: "task-1",
      destination: "recipient@example.com",
      renderedContent: {
        content: {
          subject: "Welcome Alice",
          body: "Hello Alice",
          htmlBody: "<h1>Hello Alice</h1>",
          replyTo: "support@example.com",
        },
      },
      deliveryOptions: {
        headers: {
          "List-Unsubscribe": "<https://example.com/unsub>",
        },
      },
    } as any);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer sg-test-api-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({
      personalizations: [{ to: [{ email: "recipient@example.com" }] }],
      from: { email: "notifications@example.com" },
      subject: "Welcome Alice",
      content: [
        { type: "text/plain", value: "Hello Alice" },
        { type: "text/html", value: "<h1>Hello Alice</h1>" },
      ],
      reply_to: { email: "support@example.com" },
      headers: { "List-Unsubscribe": "<https://example.com/unsub>" },
    });
    expect(result).toEqual({
      success: true,
      providerMessageId: "sg-msg-abc-123",
    });
  });

  it("returns retryable: false without calling fetch when destination is missing", async () => {
    const transport = new SendGridTransport({
      apiKey: "sg-test-api-key",
      from: "notifications@example.com",
    });

    const result = await transport.send({
      taskId: "task-missing",
      renderedContent: { content: { subject: "Hi", text: "Hello" } },
    } as any);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      retryable: false,
      error: "No destination (recipient address) on task",
    });
  });

  it("marks permanent 4xx as retryable: false and 429/5xx/network errors as retryable", async () => {
    const transport = new SendGridTransport({
      apiKey: "sg-test-api-key",
      from: "notifications@example.com",
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: "Invalid email address" }] }), {
        status: 400,
      }),
    );
    expect(
      await transport.send({
        taskId: "task-400",
        destination: "bad",
        renderedContent: { content: { subject: "Hi", text: "Hello" } },
      } as any),
    ).toEqual({
      success: false,
      retryable: false,
      error: "Invalid email address",
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: "Rate limit" }] }), { status: 429 }),
    );
    expect(
      await transport.send({
        taskId: "task-429",
        destination: "alice@example.com",
        renderedContent: { content: { subject: "Hi", text: "Hello" } },
      } as any),
    ).toEqual({
      success: false,
      throttled: true,
      error: "Rate limit",
    });

    fetchMock.mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }));
    const serverErr = await transport.send({
      taskId: "task-503",
      destination: "alice@example.com",
      renderedContent: { content: { subject: "Hi", text: "Hello" } },
    } as any);
    expect(serverErr).toEqual({
      success: false,
      error: "SendGrid API error (HTTP 503)",
    });
    expect(serverErr.retryable).toBeUndefined();

    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const netErr = await transport.send({
      taskId: "task-net",
      destination: "alice@example.com",
      renderedContent: { content: { subject: "Hi", text: "Hello" } },
    } as any);
    expect(netErr).toEqual({ success: false, error: "ECONNRESET" });
    expect(netErr.retryable).toBeUndefined();
  });
});

describe("SendGridTransport (Webhooks)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  it("verifies ECDSA webhook signatures and rejects invalid or unconfigured ones", () => {
    const transport = new SendGridTransport({
      apiKey: "sg-test-api-key",
      from: "notifications@example.com",
      webhookPublicKey: publicKey,
    });

    const rawBody = JSON.stringify([{ event: "open", sg_message_id: "sg-1.filter" }]);
    const timestamp = "1732449600";
    const signature = signSendGridWebhook(privateKey, timestamp, rawBody);

    expect(
      transport.verifyWebhook(rawBody, {
        "x-twilio-email-event-webhook-signature": signature,
        "x-twilio-email-event-webhook-timestamp": timestamp,
      }),
    ).toBe(true);

    expect(
      transport.verifyWebhook(rawBody, {
        "x-twilio-email-event-webhook-signature": Buffer.from("invalid").toString("base64"),
        "x-twilio-email-event-webhook-timestamp": timestamp,
      }),
    ).toBe(false);

    const unconfigured = new SendGridTransport({
      apiKey: "sg-test-api-key",
      from: "notifications@example.com",
    });
    expect(
      unconfigured.verifyWebhook(rawBody, {
        "x-twilio-email-event-webhook-signature": signature,
        "x-twilio-email-event-webhook-timestamp": timestamp,
      }),
    ).toBe(false);
  });

  it("parses bounce, blocked, deferred, spamreport, and unsubscribe arrays", async () => {
    const transport = new SendGridTransport({
      apiKey: "sg-test-api-key",
      from: "notifications@example.com",
      webhookPublicKey: publicKey,
    });

    const events = [
      {
        event: "bounce",
        email: "hard@example.com",
        timestamp: 1732449601,
        sg_message_id: "sg-msg-1.filter001",
        reason: "550 User unknown",
      },
      {
        event: "blocked",
        email: "block@example.com",
        timestamp: 1732449602,
        sg_message_id: "sg-msg-2.filter001",
      },
      {
        event: "deferred",
        email: "defer@example.com",
        timestamp: 1732449603,
        sg_message_id: "sg-msg-3.filter001",
      },
      {
        event: "spamreport",
        email: "spam@example.com",
        timestamp: 1732449604,
        sg_message_id: "sg-msg-4.filter001",
      },
      {
        event: "unsubscribe",
        email: "unsub@example.com",
        timestamp: 1732449605,
        sg_message_id: "sg-msg-5.filter001",
      },
    ];
    const rawBody = JSON.stringify(events);
    const timestamp = "1732449605";
    const headers = {
      "X-Twilio-Email-Event-Webhook-Signature": signSendGridWebhook(privateKey, timestamp, rawBody),
      "X-Twilio-Email-Event-Webhook-Timestamp": timestamp,
    };

    const parsed = await transport.parseWebhook(events, rawBody, headers);
    expect(parsed).toEqual([
      {
        providerMessageId: "sg-msg-1",
        status: "bounced",
        bounceType: "hard",
        recipient: "hard@example.com",
        timestamp: new Date(1732449601 * 1000),
        metadata: { sgMessageId: "sg-msg-1.filter001", bounceMessage: "550 User unknown" },
      },
      {
        providerMessageId: "sg-msg-2",
        status: "bounced",
        bounceType: "soft",
        recipient: "block@example.com",
        timestamp: new Date(1732449602 * 1000),
        metadata: { sgMessageId: "sg-msg-2.filter001" },
      },
      {
        providerMessageId: "sg-msg-3",
        status: "bounced",
        bounceType: "soft",
        recipient: "defer@example.com",
        timestamp: new Date(1732449603 * 1000),
        metadata: { sgMessageId: "sg-msg-3.filter001" },
      },
      {
        providerMessageId: "sg-msg-4",
        status: "complained",
        recipient: "spam@example.com",
        timestamp: new Date(1732449604 * 1000),
        metadata: { sgMessageId: "sg-msg-4.filter001" },
      },
      {
        providerMessageId: "sg-msg-5",
        status: "unsubscribed",
        recipient: "unsub@example.com",
        timestamp: new Date(1732449605 * 1000),
        metadata: { sgMessageId: "sg-msg-5.filter001" },
      },
    ]);
  });
});
