import { createHmac } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MailgunTransport } from "../packages/provider-mailgun/src/index.js";

function signMailgunWebhook(signingKey: string, timestamp: string, token: string) {
  return {
    timestamp,
    token,
    signature: createHmac("sha256", signingKey).update(`${timestamp}${token}`).digest("hex"),
  };
}

describe("MailgunTransport (Email Provider)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a form-encoded email via Mailgun v3 API with Basic Auth", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "<20261124120000.1.ABC@mg.example.com>",
          message: "Queued. Thank you.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const transport = new MailgunTransport({
      apiKey: "key-test-123",
      domain: "mg.example.com",
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
    expect(url).toBe("https://api.mailgun.net/v3/mg.example.com/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: `Basic ${Buffer.from("api:key-test-123", "utf8").toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    });

    const params = new URLSearchParams(init.body);
    expect(params.get("from")).toBe("notifications@example.com");
    expect(params.get("to")).toBe("recipient@example.com");
    expect(params.get("subject")).toBe("Welcome Alice");
    expect(params.get("text")).toBe("Hello Alice");
    expect(params.get("html")).toBe("<h1>Hello Alice</h1>");
    expect(params.get("h:Reply-To")).toBe("support@example.com");
    expect(params.get("h:List-Unsubscribe")).toBe("<https://example.com/unsub>");

    expect(result).toEqual({
      success: true,
      providerMessageId: "<20261124120000.1.ABC@mg.example.com>",
    });
  });

  it("supports custom EU apiBaseUrl, per-template from, and HTML-escaped text fallback", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "<eu-msg-1@mg.example.eu>" }), { status: 200 }),
    );

    const transport = new MailgunTransport({
      apiKey: "key-eu-123",
      domain: "mg.example.eu",
      from: "default@example.eu",
      apiBaseUrl: "https://api.eu.mailgun.net/",
    });

    const result = await transport.send({
      taskId: "task-eu",
      destination: "bob@example.eu",
      renderedContent: {
        content: {
          from: "billing@example.eu",
          subject: "Invoice",
          text: "Hi <Bob> &\nThanks",
        },
      },
    } as any);

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.eu.mailgun.net/v3/mg.example.eu/messages");
    const params = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(params.get("from")).toBe("billing@example.eu");
    expect(params.get("html")).toBe("<p>Hi &lt;Bob&gt; &amp;<br>Thanks</p>");
    expect(result).toEqual({ success: true, providerMessageId: "<eu-msg-1@mg.example.eu>" });
  });

  it("returns retryable: false without calling fetch when destination is missing", async () => {
    const transport = new MailgunTransport({
      apiKey: "key-test-123",
      domain: "mg.example.com",
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

  it("returns retryable: false on permanent 4xx failures", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "'to' parameter is not a valid address." }), {
        status: 400,
      }),
    );

    const transport = new MailgunTransport({
      apiKey: "key-test-123",
      domain: "mg.example.com",
      from: "notifications@example.com",
    });

    const result = await transport.send({
      taskId: "task-400",
      destination: "invalid-address",
      renderedContent: { content: { subject: "Hi", text: "Hello" } },
    } as any);

    expect(result).toEqual({
      success: false,
      retryable: false,
      error: "'to' parameter is not a valid address.",
    });
  });

  it("marks HTTP 429 as throttled and treats 5xx / network errors as retryable", async () => {
    const transport = new MailgunTransport({
      apiKey: "key-test-123",
      domain: "mg.example.com",
      from: "notifications@example.com",
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Too many requests" }), { status: 429 }),
    );
    expect(
      await transport.send({
        taskId: "task-429",
        destination: "alice@example.com",
        renderedContent: { content: { subject: "Hi", text: "Hello" } },
      } as any),
    ).toEqual({ success: false, throttled: true, error: "Too many requests" });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Service unavailable" }), { status: 503 }),
    );
    const serverErr = await transport.send({
      taskId: "task-503",
      destination: "alice@example.com",
      renderedContent: { content: { subject: "Hi", text: "Hello" } },
    } as any);
    expect(serverErr).toEqual({ success: false, error: "Service unavailable" });
    expect(serverErr.retryable).toBeUndefined();

    fetchMock.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    const netErr = await transport.send({
      taskId: "task-net",
      destination: "alice@example.com",
      renderedContent: { content: { subject: "Hi", text: "Hello" } },
    } as any);
    expect(netErr).toEqual({ success: false, error: "ETIMEDOUT" });
    expect(netErr.retryable).toBeUndefined();
  });
});

describe("MailgunTransport (Webhooks)", () => {
  const signingKey = "mg-webhook-signing-key-test";

  it("verifies valid HMAC-SHA256 webhook signatures and rejects invalid or unconfigured ones", () => {
    const transport = new MailgunTransport({
      apiKey: "key-test-123",
      domain: "mg.example.com",
      from: "notifications@example.com",
      webhookSigningKey: signingKey,
    });

    const validPayload = {
      signature: signMailgunWebhook(signingKey, "1732449600", "tok-abc-123"),
      "event-data": { event: "opened" },
    };
    expect(transport.verifyWebhook(JSON.stringify(validPayload), {})).toBe(true);

    const badPayload = {
      signature: {
        timestamp: "1732449600",
        token: "tok-abc-123",
        signature: "0".repeat(64),
      },
      "event-data": { event: "opened" },
    };
    expect(transport.verifyWebhook(JSON.stringify(badPayload), {})).toBe(false);
    expect(transport.verifyWebhook("not-json", {})).toBe(false);

    const unconfigured = new MailgunTransport({
      apiKey: "key-test-123",
      domain: "mg.example.com",
      from: "notifications@example.com",
    });
    expect(unconfigured.verifyWebhook(JSON.stringify(validPayload), {})).toBe(false);
  });

  it("parses permanent and temporary failed events into hard and soft bounces", async () => {
    const transport = new MailgunTransport({
      apiKey: "key-test-123",
      domain: "mg.example.com",
      from: "notifications@example.com",
      webhookSigningKey: signingKey,
    });

    const hardPayload = {
      signature: signMailgunWebhook(signingKey, "1732449601", "tok-hard"),
      "event-data": {
        event: "failed",
        severity: "permanent",
        reason: "bounce",
        timestamp: 1732449601,
        recipient: "bad@example.com",
        message: { headers: { "message-id": "<hard@mg.example.com>" } },
        "delivery-status": { message: "550 5.1.1 User unknown" },
      },
    };
    expect(
      await transport.parseWebhook(hardPayload, JSON.stringify(hardPayload), {}),
    ).toEqual([
      {
        providerMessageId: "<hard@mg.example.com>",
        status: "bounced",
        bounceType: "hard",
        recipient: "bad@example.com",
        timestamp: new Date(1732449601 * 1000),
        metadata: {
          severity: "permanent",
          reason: "bounce",
          bounceMessage: "550 5.1.1 User unknown",
        },
      },
    ]);

    const softPayload = {
      signature: signMailgunWebhook(signingKey, "1732449602", "tok-soft"),
      "event-data": {
        event: "failed",
        severity: "temporary",
        reason: "generic",
        timestamp: 1732449602,
        recipient: "full@example.com",
        message: { headers: { "message-id": "<soft@mg.example.com>" } },
      },
    };
    expect(
      await transport.parseWebhook(softPayload, JSON.stringify(softPayload), {}),
    ).toEqual([
      {
        providerMessageId: "<soft@mg.example.com>",
        status: "bounced",
        bounceType: "soft",
        recipient: "full@example.com",
        timestamp: new Date(1732449602 * 1000),
        metadata: {
          severity: "temporary",
          reason: "generic",
        },
      },
    ]);
  });

  it("parses complained, opened, clicked, and unsubscribed events and drops invalid signatures", async () => {
    const transport = new MailgunTransport({
      apiKey: "key-test-123",
      domain: "mg.example.com",
      from: "notifications@example.com",
      webhookSigningKey: signingKey,
    });

    const complainedPayload = {
      signature: signMailgunWebhook(signingKey, "1732449603", "tok-comp"),
      "event-data": {
        event: "complained",
        timestamp: 1732449603,
        recipient: "user@example.com",
        message: { headers: { "message-id": "<comp@mg.example.com>" } },
      },
    };
    expect(
      await transport.parseWebhook(complainedPayload, JSON.stringify(complainedPayload), {}),
    ).toEqual([
      {
        providerMessageId: "<comp@mg.example.com>",
        status: "complained",
        recipient: "user@example.com",
        timestamp: new Date(1732449603 * 1000),
      },
    ]);

    const clickPayload = {
      signature: signMailgunWebhook(signingKey, "1732449604", "tok-click"),
      "event-data": {
        event: "clicked",
        timestamp: 1732449604,
        recipient: "reader@example.com",
        url: "https://notifkit.dev/docs",
        message: { headers: { "message-id": "<click@mg.example.com>" } },
      },
    };
    expect(
      await transport.parseWebhook(clickPayload, JSON.stringify(clickPayload), {}),
    ).toEqual([
      {
        providerMessageId: "<click@mg.example.com>",
        status: "clicked",
        recipient: "reader@example.com",
        timestamp: new Date(1732449604 * 1000),
        metadata: { url: "https://notifkit.dev/docs" },
      },
    ]);

    const invalidPayload = {
      signature: { timestamp: "1732449604", token: "tok-click", signature: "bad" },
      "event-data": clickPayload["event-data"],
    };
    expect(
      await transport.parseWebhook(invalidPayload, JSON.stringify(invalidPayload), {}),
    ).toEqual([]);
  });
});
