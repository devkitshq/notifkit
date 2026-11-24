import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NtfyTransport } from "../packages/provider-ntfy/src/index.js";

describe("NtfyTransport (Push Provider)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("publishes a plain-text push notification to ntfy with Title, Priority, and Bearer token", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "ntfy-msg-123" }), { status: 200 }),
    );

    const transport = new NtfyTransport({
      serverUrl: "https://ntfy.example.com/",
      accessToken: "tk_test_token",
    });

    const result = await transport.send({
      taskId: "task-1",
      destination: "deploy-alerts",
      priority: "high",
      renderedContent: {
        content: {
          subject: "Deployment complete",
          text: "v1.4.2 is live",
        },
      },
    } as any);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ntfy.example.com/deploy-alerts");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "text/plain; charset=utf-8",
      Title: "Deployment complete",
      Priority: "4",
      Authorization: "Bearer tk_test_token",
    });
    expect(init.body).toBe("v1.4.2 is live");
    expect(result).toEqual({
      success: true,
      providerMessageId: "ntfy-msg-123",
    });
  });

  it("rejects missing or invalid topic names without calling fetch", async () => {
    const transport = new NtfyTransport();

    const missing = await transport.send({
      taskId: "task-missing",
      renderedContent: { content: { text: "Hello" } },
    } as any);
    expect(missing).toEqual({
      success: false,
      retryable: false,
      error: "No destination (ntfy topic) on task",
    });

    const traversal = await transport.send({
      taskId: "task-bad-topic",
      destination: "../admin/secret",
      renderedContent: { content: { text: "Hello" } },
    } as any);
    expect(traversal.success).toBe(false);
    expect(traversal.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks 401/403 as retryable: false and 429/5xx/network errors as retryable", async () => {
    const transport = new NtfyTransport();

    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    expect(
      await transport.send({
        taskId: "task-401",
        destination: "alerts",
        renderedContent: { content: { text: "Hello" } },
      } as any),
    ).toEqual({
      success: false,
      retryable: false,
      error: "unauthorized",
    });

    fetchMock.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    expect(
      await transport.send({
        taskId: "task-429",
        destination: "alerts",
        renderedContent: { content: { text: "Hello" } },
      } as any),
    ).toEqual({
      success: false,
      throttled: true,
      error: "rate limited",
    });

    fetchMock.mockResolvedValueOnce(new Response("bad gateway", { status: 502 }));
    const serverErr = await transport.send({
      taskId: "task-502",
      destination: "alerts",
      renderedContent: { content: { text: "Hello" } },
    } as any);
    expect(serverErr).toEqual({ success: false, error: "bad gateway" });
    expect(serverErr.retryable).toBeUndefined();

    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const netErr = await transport.send({
      taskId: "task-net",
      destination: "alerts",
      renderedContent: { content: { text: "Hello" } },
    } as any);
    expect(netErr).toEqual({ success: false, error: "ECONNREFUSED" });
    expect(netErr.retryable).toBeUndefined();
  });
});
