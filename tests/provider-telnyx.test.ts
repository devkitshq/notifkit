import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TelnyxTransport } from "../packages/provider-telnyx/src/index.js";

function signTelnyxWebhook(privateKeyPem: string, timestamp: string, rawBody: string): string {
  return cryptoSign(null, Buffer.from(`${timestamp}|${rawBody}`, "utf8"), privateKeyPem).toString(
    "base64",
  );
}

describe("TelnyxTransport (SMS Provider)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends an SMS via Telnyx v2 API and returns data.id", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { id: "telnyx-msg-123" } }), { status: 200 }),
    );

    const transport = new TelnyxTransport({
      apiKey: "KEY_test_123",
      from: "+15550100000",
    });

    const result = await transport.send({
      taskId: "task-1",
      destination: "+15550199999",
      renderedContent: { content: { text: "Your code is 482910" } },
    } as any);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telnyx.com/v2/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer KEY_test_123",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({
      to: "+15550199999",
      text: "Your code is 482910",
      from: "+15550100000",
    });
    expect(result).toEqual({
      success: true,
      providerMessageId: "telnyx-msg-123",
    });
  });

  it("rejects missing or non-E.164 destination without calling fetch", async () => {
    const transport = new TelnyxTransport({
      apiKey: "KEY_test_123",
      from: "+15550100000",
    });

    expect(
      await transport.send({
        taskId: "task-missing",
        renderedContent: { content: { text: "Hi" } },
      } as any),
    ).toEqual({
      success: false,
      retryable: false,
      error: "No destination (recipient phone number) on task",
    });

    const invalid = await transport.send({
      taskId: "task-bad-e164",
      destination: "555-019-9999",
      renderedContent: { content: { text: "Hi" } },
    } as any);
    expect(invalid.success).toBe(false);
    expect(invalid.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks 4xx as retryable: false and 429/5xx/network errors as retryable", async () => {
    const transport = new TelnyxTransport({
      apiKey: "KEY_test_123",
      messagingProfileId: "mp-123",
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ detail: "Invalid destination number" }] }), {
        status: 422,
      }),
    );
    expect(
      await transport.send({
        taskId: "task-422",
        destination: "+15550199999",
        renderedContent: { content: { text: "Hi" } },
      } as any),
    ).toEqual({
      success: false,
      retryable: false,
      error: "Invalid destination number",
    });

    fetchMock.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    expect(
      await transport.send({
        taskId: "task-429",
        destination: "+15550199999",
        renderedContent: { content: { text: "Hi" } },
      } as any),
    ).toEqual({
      success: false,
      throttled: true,
      error: "Telnyx API error (HTTP 429)",
    });

    fetchMock.mockResolvedValueOnce(new Response("error", { status: 503 }));
    const serverErr = await transport.send({
      taskId: "task-503",
      destination: "+15550199999",
      renderedContent: { content: { text: "Hi" } },
    } as any);
    expect(serverErr).toEqual({ success: false, error: "Telnyx API error (HTTP 503)" });
    expect(serverErr.retryable).toBeUndefined();

    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const netErr = await transport.send({
      taskId: "task-net",
      destination: "+15550199999",
      renderedContent: { content: { text: "Hi" } },
    } as any);
    expect(netErr).toEqual({ success: false, error: "ECONNRESET" });
    expect(netErr.retryable).toBeUndefined();
  });
});

describe("TelnyxTransport (Webhooks)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  it("verifies Ed25519 webhook signatures and rejects invalid or unconfigured ones", () => {
    const transport = new TelnyxTransport({
      apiKey: "KEY_test_123",
      from: "+15550100000",
      webhookPublicKey: publicKey,
    });

    const rawBody = JSON.stringify({ data: { event_type: "message.finalized" } });
    const timestamp = "1732449600";
    const signature = signTelnyxWebhook(privateKey, timestamp, rawBody);

    expect(
      transport.verifyWebhook(rawBody, {
        "telnyx-signature-ed25519": signature,
        "telnyx-timestamp": timestamp,
      }),
    ).toBe(true);

    expect(
      transport.verifyWebhook(rawBody, {
        "telnyx-signature-ed25519": Buffer.from("bad-sig").toString("base64"),
        "telnyx-timestamp": timestamp,
      }),
    ).toBe(false);

    const unconfigured = new TelnyxTransport({
      apiKey: "KEY_test_123",
      from: "+15550100000",
    });
    expect(
      unconfigured.verifyWebhook(rawBody, {
        "telnyx-signature-ed25519": signature,
        "telnyx-timestamp": timestamp,
      }),
    ).toBe(false);
  });

  it("parses message.finalized delivery_failed and sending_failed events as bounced", async () => {
    const transport = new TelnyxTransport({
      apiKey: "KEY_test_123",
      from: "+15550100000",
      webhookPublicKey: publicKey,
    });

    for (const status of ["delivery_failed", "sending_failed"]) {
      const payload = {
        data: {
          event_type: "message.finalized",
          occurred_at: "2026-11-24T12:10:00Z",
          payload: {
            id: `telnyx-${status}`,
            to: [{ phone_number: "+15550199999", status }],
            errors: [{ detail: "Carrier rejected message" }],
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = "1732449610";
      const headers = {
        "telnyx-signature-ed25519": signTelnyxWebhook(privateKey, timestamp, rawBody),
        "telnyx-timestamp": timestamp,
      };

      expect(await transport.parseWebhook(payload, rawBody, headers)).toEqual([
        {
          providerMessageId: `telnyx-${status}`,
          status: "bounced",
          bounceType: "soft",
          recipient: "+15550199999",
          timestamp: new Date("2026-11-24T12:10:00Z"),
          metadata: {
            telnyxStatus: status,
            bounceMessage: "Carrier rejected message",
          },
        },
      ]);
    }
  });
});
