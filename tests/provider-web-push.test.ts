import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSetVapidDetails, mockSendNotification } = vi.hoisted(() => ({
  mockSetVapidDetails: vi.fn(),
  mockSendNotification: vi.fn(),
}));

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: mockSetVapidDetails,
    sendNotification: mockSendNotification,
  },
}));

import { WebPushTransport } from "../packages/provider-web-push/src/index.js";

const VALID_SUBSCRIPTION = JSON.stringify({
  endpoint: "https://push.example.com/sub/123",
  keys: {
    p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    auth: "tBHItJI5svbpez7KI4CCXg",
  },
});

describe("WebPushTransport (Push Provider)", () => {
  beforeEach(() => {
    mockSetVapidDetails.mockReset();
    mockSendNotification.mockReset();
  });

  it("configures VAPID details and sends a serialized notification payload", async () => {
    mockSendNotification.mockResolvedValueOnce({ statusCode: 201, body: "", headers: {} });

    const transport = new WebPushTransport({
      subject: "mailto:notifications@example.com",
      publicKey: "pub-key",
      privateKey: "priv-key",
    });

    expect(mockSetVapidDetails).toHaveBeenCalledWith(
      "mailto:notifications@example.com",
      "pub-key",
      "priv-key",
    );

    const result = await transport.send({
      taskId: "task-wp-1",
      destination: VALID_SUBSCRIPTION,
      renderedContent: {
        content: {
          title: "Order shipped",
          text: "Your package is on the way",
          data: { orderId: "ord_123" },
        },
      },
    } as any);

    expect(mockSendNotification).toHaveBeenCalledWith(
      JSON.parse(VALID_SUBSCRIPTION),
      JSON.stringify({
        title: "Order shipped",
        body: "Your package is on the way",
        data: { orderId: "ord_123" },
      }),
    );
    expect(result).toEqual({
      success: true,
      providerMessageId: "task-wp-1",
    });
  });

  it("rejects missing destination, malformed JSON, and oversized payloads without calling web-push", async () => {
    const transport = new WebPushTransport({
      subject: "mailto:notifications@example.com",
      publicKey: "pub-key",
      privateKey: "priv-key",
    });

    expect(
      await transport.send({
        taskId: "task-missing",
        renderedContent: { content: { text: "Hello" } },
      } as any),
    ).toEqual({
      success: false,
      retryable: false,
      error: "No destination (JSON-encoded PushSubscription) on task",
    });

    expect(
      await transport.send({
        taskId: "task-bad-json",
        destination: "{not-json",
        renderedContent: { content: { text: "Hello" } },
      } as any),
    ).toEqual({
      success: false,
      invalidToken: true,
      retryable: false,
      error: "Invalid PushSubscription JSON",
    });

    expect(
      await transport.send({
        taskId: "task-oversize",
        destination: VALID_SUBSCRIPTION,
        renderedContent: { content: { text: "a".repeat(4200) } },
      } as any),
    ).toEqual({
      success: false,
      retryable: false,
      error: "Web Push payload exceeds 4096 bytes",
    });

    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("marks 404/410 as invalidToken + non-retryable, 429 as throttled, and 5xx/network as retryable", async () => {
    const transport = new WebPushTransport({
      subject: "mailto:notifications@example.com",
      publicKey: "pub-key",
      privateKey: "priv-key",
    });

    mockSendNotification.mockRejectedValueOnce(
      Object.assign(new Error("Gone"), { statusCode: 410 }),
    );
    expect(
      await transport.send({
        taskId: "task-410",
        destination: VALID_SUBSCRIPTION,
        renderedContent: { content: { text: "Hello" } },
      } as any),
    ).toEqual({
      success: false,
      invalidToken: true,
      retryable: false,
      error: "Gone",
    });

    mockSendNotification.mockRejectedValueOnce(
      Object.assign(new Error("Too many requests"), { statusCode: 429 }),
    );
    expect(
      await transport.send({
        taskId: "task-429",
        destination: VALID_SUBSCRIPTION,
        renderedContent: { content: { text: "Hello" } },
      } as any),
    ).toEqual({
      success: false,
      throttled: true,
      error: "Too many requests",
    });

    mockSendNotification.mockRejectedValueOnce(
      Object.assign(new Error("Upstream error"), { statusCode: 502 }),
    );
    const serverErr = await transport.send({
      taskId: "task-502",
      destination: VALID_SUBSCRIPTION,
      renderedContent: { content: { text: "Hello" } },
    } as any);
    expect(serverErr).toEqual({ success: false, error: "Upstream error" });
    expect(serverErr.retryable).toBeUndefined();

    mockSendNotification.mockRejectedValueOnce(new Error("ECONNRESET"));
    const netErr = await transport.send({
      taskId: "task-net",
      destination: VALID_SUBSCRIPTION,
      renderedContent: { content: { text: "Hello" } },
    } as any);
    expect(netErr).toEqual({ success: false, error: "ECONNRESET" });
    expect(netErr.retryable).toBeUndefined();
  });
});
