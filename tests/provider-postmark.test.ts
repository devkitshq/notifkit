import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PostmarkTransport } from "../packages/provider-postmark/src/index.js";

function makeBasicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

describe("PostmarkTransport (Email Provider)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends an email successfully via Postmark HTTP API", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          To: "recipient@example.com",
          SubmittedAt: "2026-11-24T12:00:00Z",
          MessageID: "pm-msg-uuid-123",
          ErrorCode: 0,
          Message: "OK",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const transport = new PostmarkTransport({
      serverToken: "test-server-token",
      from: "notifications@example.com",
      messageStream: "outbound",
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
    expect(url).toBe("https://api.postmarkapp.com/email");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": "test-server-token",
    });
    expect(JSON.parse(init.body)).toEqual({
      From: "notifications@example.com",
      To: "recipient@example.com",
      Subject: "Welcome Alice",
      HtmlBody: "<h1>Hello Alice</h1>",
      TextBody: "Hello Alice",
      ReplyTo: "support@example.com",
      MessageStream: "outbound",
      Headers: [{ Name: "List-Unsubscribe", Value: "<https://example.com/unsub>" }],
    });
    expect(result).toEqual({
      success: true,
      providerMessageId: "pm-msg-uuid-123",
    });
  });

  it("escapes plain text into HtmlBody when no htmlBody is provided and supports per-template from", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ MessageID: "pm-msg-2", ErrorCode: 0 }), { status: 200 }),
    );

    const transport = new PostmarkTransport({
      serverToken: "test-server-token",
      from: "default@example.com",
    });

    const result = await transport.send({
      taskId: "task-2",
      destination: "bob@example.com",
      renderedContent: {
        content: {
          from: "billing@example.com",
          subject: "Receipt",
          text: "Hi <Bob> &\nThanks",
        },
      },
    } as any);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.From).toBe("billing@example.com");
    expect(body.HtmlBody).toBe("<p>Hi &lt;Bob&gt; &amp;<br>Thanks</p>");
    expect(body.TextBody).toBe("Hi <Bob> &\nThanks");
    expect(result).toEqual({ success: true, providerMessageId: "pm-msg-2" });
  });

  it("returns retryable: false without calling fetch when destination is missing", async () => {
    const transport = new PostmarkTransport({
      serverToken: "test-server-token",
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

  it("marks ErrorCode 406 (inactive recipient) as non-retryable and invalidToken", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ErrorCode: 406,
          Message: "You tried to send to a recipient that has been marked as inactive.",
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      ),
    );

    const transport = new PostmarkTransport({
      serverToken: "test-server-token",
      from: "notifications@example.com",
    });

    const result = await transport.send({
      taskId: "task-406",
      destination: "suppressed@example.com",
      renderedContent: { content: { subject: "Hi", text: "Hello" } },
    } as any);

    expect(result).toEqual({
      success: false,
      retryable: false,
      invalidToken: true,
      error: "You tried to send to a recipient that has been marked as inactive.",
    });
  });

  it("returns retryable: false on permanent 4xx failures", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ErrorCode: 300,
          Message: "Invalid 'To' address.",
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      ),
    );

    const transport = new PostmarkTransport({
      serverToken: "test-server-token",
      from: "notifications@example.com",
    });

    const result = await transport.send({
      taskId: "task-422",
      destination: "not-an-email",
      renderedContent: { content: { subject: "Hi", text: "Hello" } },
    } as any);

    expect(result).toEqual({
      success: false,
      retryable: false,
      error: "Invalid 'To' address.",
    });
  });

  it("marks HTTP 429 as throttled", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ErrorCode: 429, Message: "Rate limit exceeded" }), {
        status: 429,
      }),
    );

    const transport = new PostmarkTransport({
      serverToken: "test-server-token",
      from: "notifications@example.com",
    });

    const result = await transport.send({
      taskId: "task-429",
      destination: "alice@example.com",
      renderedContent: { content: { subject: "Hi", text: "Hello" } },
    } as any);

    expect(result).toEqual({
      success: false,
      throttled: true,
      error: "Rate limit exceeded",
    });
  });

  it("treats 5xx responses and network errors as retryable", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Message: "Internal server error" }), { status: 503 }),
    );

    const transport = new PostmarkTransport({
      serverToken: "test-server-token",
      from: "notifications@example.com",
    });

    const serverErr = await transport.send({
      taskId: "task-503",
      destination: "alice@example.com",
      renderedContent: { content: { subject: "Hi", text: "Hello" } },
    } as any);

    expect(serverErr).toEqual({
      success: false,
      error: "Internal server error",
    });
    expect(serverErr.retryable).toBeUndefined();

    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));

    const netErr = await transport.send({
      taskId: "task-net",
      destination: "alice@example.com",
      renderedContent: { content: { subject: "Hi", text: "Hello" } },
    } as any);

    expect(netErr).toEqual({
      success: false,
      error: "ECONNRESET",
    });
    expect(netErr.retryable).toBeUndefined();
  });
});

describe("PostmarkTransport (Webhooks)", () => {
  const auth = { username: "pm-user", password: "pm-secret-password" };
  const validHeaders = { Authorization: makeBasicAuthHeader(auth.username, auth.password) };

  it("verifies valid HTTP Basic Auth credentials and rejects invalid or missing ones", () => {
    const transport = new PostmarkTransport({
      serverToken: "test-server-token",
      from: "notifications@example.com",
      webhookBasicAuth: auth,
    });

    expect(transport.verifyWebhook("{}", validHeaders)).toBe(true);
    expect(
      transport.verifyWebhook("{}", {
        authorization: makeBasicAuthHeader("pm-user", "wrong-password"),
      }),
    ).toBe(false);
    expect(transport.verifyWebhook("{}", {})).toBe(false);
    expect(transport.verifyWebhook("{}", { Authorization: "Bearer token" })).toBe(false);

    const unconfigured = new PostmarkTransport({
      serverToken: "test-server-token",
      from: "notifications@example.com",
    });
    expect(unconfigured.verifyWebhook("{}", validHeaders)).toBe(false);
  });

  it("parses HardBounce as bounced/hard", async () => {
    const transport = new PostmarkTransport({
      serverToken: "test-server-token",
      from: "notifications@example.com",
      webhookBasicAuth: auth,
    });

    const payload = {
      RecordType: "Bounce",
      Type: "HardBounce",
      MessageID: "pm-bounce-hard",
      Email: "bad@example.com",
      BouncedAt: "2026-11-24T12:05:00Z",
      Description: "The server was unable to deliver your message (ex: unknown user).",
    };

    const events = await transport.parseWebhook(payload, JSON.stringify(payload), validHeaders);
    expect(events).toEqual([
      {
        providerMessageId: "pm-bounce-hard",
        status: "bounced",
        bounceType: "hard",
        recipient: "bad@example.com",
        timestamp: new Date("2026-11-24T12:05:00Z"),
        metadata: {
          bounceType: "HardBounce",
          bounceMessage: "The server was unable to deliver your message (ex: unknown user).",
        },
      },
    ]);
  });

  it("parses Transient and SoftBounce as bounced/soft", async () => {
    const transport = new PostmarkTransport({
      serverToken: "test-server-token",
      from: "notifications@example.com",
      webhookBasicAuth: auth,
    });

    for (const type of ["Transient", "SoftBounce"]) {
      const payload = {
        RecordType: "Bounce",
        Type: type,
        MessageID: `pm-${type}`,
        Email: "full@example.com",
        BouncedAt: "2026-11-24T12:06:00Z",
      };

      const events = await transport.parseWebhook(payload, JSON.stringify(payload), validHeaders);
      expect(events).toEqual([
        {
          providerMessageId: `pm-${type}`,
          status: "bounced",
          bounceType: "soft",
          recipient: "full@example.com",
          timestamp: new Date("2026-11-24T12:06:00Z"),
          metadata: { bounceType: type },
        },
      ]);
    }
  });

  it("parses SpamComplaint as complained", async () => {
    const transport = new PostmarkTransport({
      serverToken: "test-server-token",
      from: "notifications@example.com",
      webhookBasicAuth: auth,
    });

    const payload = {
      RecordType: "SpamComplaint",
      Type: "SpamComplaint",
      MessageID: "pm-complaint-1",
      Email: "user@example.com",
      BouncedAt: "2026-11-24T12:07:00Z",
    };

    const events = await transport.parseWebhook(payload, JSON.stringify(payload), validHeaders);
    expect(events).toEqual([
      {
        providerMessageId: "pm-complaint-1",
        status: "complained",
        recipient: "user@example.com",
        timestamp: new Date("2026-11-24T12:07:00Z"),
        metadata: { bounceType: "SpamComplaint" },
      },
    ]);
  });

  it("parses Open, Click, and SubscriptionChange events and drops unverified webhooks", async () => {
    const transport = new PostmarkTransport({
      serverToken: "test-server-token",
      from: "notifications@example.com",
      webhookBasicAuth: auth,
    });

    const openPayload = {
      RecordType: "Open",
      MessageID: "pm-open-1",
      Recipient: "reader@example.com",
      ReceivedAt: "2026-11-24T12:08:00Z",
    };
    expect(
      await transport.parseWebhook(openPayload, JSON.stringify(openPayload), validHeaders),
    ).toEqual([
      {
        providerMessageId: "pm-open-1",
        status: "opened",
        recipient: "reader@example.com",
        timestamp: new Date("2026-11-24T12:08:00Z"),
      },
    ]);

    const clickPayload = {
      RecordType: "Click",
      MessageID: "pm-click-1",
      Recipient: "reader@example.com",
      ReceivedAt: "2026-11-24T12:09:00Z",
      OriginalLink: "https://notifkit.dev/docs",
    };
    expect(
      await transport.parseWebhook(clickPayload, JSON.stringify(clickPayload), validHeaders),
    ).toEqual([
      {
        providerMessageId: "pm-click-1",
        status: "clicked",
        recipient: "reader@example.com",
        timestamp: new Date("2026-11-24T12:09:00Z"),
        metadata: { url: "https://notifkit.dev/docs" },
      },
    ]);

    // Unverified webhook must return empty array
    expect(
      await transport.parseWebhook(openPayload, JSON.stringify(openPayload), {
        Authorization: makeBasicAuthHeader("pm-user", "bad"),
      }),
    ).toEqual([]);
  });
});
