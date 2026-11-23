import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VonageTransport } from "../packages/provider-vonage/src/index.js";

const API_KEY = "test-api-key";
const API_SECRET = "test-api-secret";
const SIGNATURE_SECRET = "test-vonage-signature-secret";

function vonageTransport(overrides: Record<string, unknown> = {}) {
  return new VonageTransport({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    from: "+15550000001",
    signatureSecret: SIGNATURE_SECRET,
    ...overrides,
  } as any);
}

function smsTask(overrides: Record<string, unknown> = {}): any {
  return {
    taskId: "task-uuid-vonage-1",
    destination: "+15550000002",
    renderedContent: { content: { text: "Your verification code is 123456" } },
    ...overrides,
  };
}

function signJwt(
  payload: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): string {
  const b64url = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  const head = b64url(header);
  const body = b64url(payload);
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

describe("VonageTransport", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers against the sms channel and mounts webhookPath only when signatureSecret is set", () => {
    expect(vonageTransport().channel).toBe("sms");
    expect(vonageTransport().webhookPath).toBe("/webhooks/vonage");
    expect(vonageTransport({ signatureSecret: undefined }).webhookPath).toBeUndefined();
  });

  it("sends an SMS via Vonage Messages API v1, strips leading '+', and returns message_uuid", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message_uuid: "uuid-vonage-123" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await vonageTransport().send(smsTask());

    expect(result).toEqual({ success: true, providerMessageId: "uuid-vonage-123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.nexmo.com/v1/messages");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${Buffer.from(`${API_KEY}:${API_SECRET}`).toString("base64")}`,
    );
    expect(JSON.parse(init.body as string)).toEqual({
      message_type: "text",
      channel: "sms",
      to: "15550000002",
      from: "15550000001",
      text: "Your verification code is 123456",
    });
  });

  it("returns a non-retryable error without calling fetch when destination is missing", async () => {
    const result = await vonageTransport().send(smsTask({ destination: undefined }));

    expect(result).toEqual({
      success: false,
      retryable: false,
      error: "No destination (recipient phone number) on task",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks 4xx permanent failures as retryable: false", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: "https://developer.nexmo.com/api-errors#unauthenticated",
          title: "Unauthenticated",
          detail: "Invalid credentials",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await vonageTransport().send(smsTask());

    expect(result).toEqual({
      success: false,
      retryable: false,
      error: "Invalid credentials",
    });
  });

  it("marks 5xx, 429, and network errors as retryable", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Rate limit exceeded" }), { status: 429 }),
    );
    const rateLimited = await vonageTransport().send(smsTask());
    expect(rateLimited.success).toBe(false);
    expect(rateLimited.throttled).toBe(true);
    expect(rateLimited.retryable).toBeUndefined();

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Upstream error" }), { status: 503 }),
    );
    const serverErr = await vonageTransport().send(smsTask());
    expect(serverErr.success).toBe(false);
    expect(serverErr.retryable).toBeUndefined();

    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    const networkErr = await vonageTransport().send(smsTask());
    expect(networkErr).toEqual({ success: false, error: "socket hang up" });
  });

  it("verifies valid HS256 JWT webhooks and rejects invalid signatures", async () => {
    const transport = vonageTransport();
    const rawBody = JSON.stringify({
      message_uuid: "uuid-1",
      status: "rejected",
      to: "15550000002",
    });
    const payloadHash = createHash("sha256").update(rawBody, "utf8").digest("hex");

    const validToken = signJwt(
      { api_key: API_KEY, payload_hash: payloadHash, exp: Math.floor(Date.now() / 1000) + 60 },
      SIGNATURE_SECRET,
    );
    const badToken = signJwt(
      { api_key: API_KEY, payload_hash: payloadHash },
      "wrong-secret",
    );

    expect(
      await transport.verifyWebhook(rawBody, { authorization: `Bearer ${validToken}` }),
    ).toBe(true);
    expect(
      await transport.verifyWebhook(rawBody, { authorization: `Bearer ${badToken}` }),
    ).toBe(false);
    expect(await transport.verifyWebhook(rawBody, {})).toBe(false);
  });

  it("maps rejected and undeliverable status webhooks to bounced and ignores delivered", async () => {
    const transport = vonageTransport();

    for (const status of ["rejected", "undeliverable"] as const) {
      const body = {
        message_uuid: `uuid-${status}`,
        status,
        to: "15550000002",
        timestamp: "2026-11-23T12:00:00Z",
        error: { type: "https://developer.nexmo.com/api-errors/messages#1000", detail: "Failed" },
      };
      const rawBody = JSON.stringify(body);
      const token = signJwt(
        { payload_hash: createHash("sha256").update(rawBody, "utf8").digest("hex") },
        SIGNATURE_SECRET,
      );

      const events = await transport.parseWebhook(body, rawBody, {
        authorization: `Bearer ${token}`,
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        providerMessageId: `uuid-${status}`,
        status: "bounced",
        recipient: "15550000002",
        bounceType: "soft",
      });
    }

    const deliveredBody = {
      message_uuid: "uuid-delivered",
      status: "delivered",
      to: "15550000002",
    };
    const deliveredRaw = JSON.stringify(deliveredBody);
    const deliveredToken = signJwt(
      { payload_hash: createHash("sha256").update(deliveredRaw, "utf8").digest("hex") },
      SIGNATURE_SECRET,
    );

    const ignored = await transport.parseWebhook(deliveredBody, deliveredRaw, {
      authorization: `Bearer ${deliveredToken}`,
    });
    expect(ignored).toEqual([]);
  });
});
