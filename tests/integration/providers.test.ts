import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { TelegramTransport } from "../../packages/provider-telegram/src/index.js";
import { DiscordTransport } from "../../packages/provider-discord/src/index.js";
import { SlackTransport } from "../../packages/provider-slack/src/index.js";
import { WhatsAppTransport } from "../../packages/provider-whatsapp/src/index.js";
import { ResendTransport } from "../../packages/provider-resend/src/index.js";
import { TwilioTransport } from "../../packages/provider-twilio/src/index.js";
import { ConsoleTransport } from "../../packages/provider-console/src/index.js";
import type { NotificationDispatchedPayload } from "@/contracts/index.js";
import { startFakeInternet, type FakeInternet } from "./support/fake-internet.js";
import { useInfra, waitFor } from "./support/infra.js";
import { startNotifkit, apiClient, type Running } from "./support/pipeline.js";

/**
 * Each provider sends through its real code — real fetch, real request
 * bodies, real status handling — against a local stand-in for the vendor's
 * API. Webhook signatures are computed the way each vendor documents them,
 * not by the code under test.
 */

let net: FakeInternet;
beforeAll(async () => {
  net = await startFakeInternet();
});
afterAll(async () => {
  await net?.close();
});
beforeEach(() => {
  net.requests.length = 0;
});

function task(
  overrides: Partial<NotificationDispatchedPayload> & { content?: Record<string, unknown> } = {},
): NotificationDispatchedPayload {
  const { content, ...rest } = overrides;
  return {
    projectId: randomUUID(),
    taskId: `task-${randomUUID()}`,
    enrichedEventId: randomUUID(),
    recipientId: "u1",
    channel: "email",
    priority: "normal",
    templateVariables: {},
    deliveryOptions: { maxAttempts: 3, timeoutMs: 2_000 },
    destination: "dest",
    renderedContent: { content: content ?? { subject: "Hello", text: "Body" } },
    ...rest,
  } as NotificationDispatchedPayload;
}

// ─── Telegram ───────────────────────────────────────────────────────────────

describe("TelegramTransport", () => {
  const t = new TelegramTransport({ botToken: "123:abc", parseMode: "HTML" });

  it("posts the message to the bot API and returns its message id", async () => {
    net.on("api.telegram.org", () => ({ json: { ok: true, result: { message_id: 77 } } }));
    const r = await t.send(
      task({
        destination: "-100200",
        content: { subject: "Alert", text: "Disk full", disableNotification: true },
      }),
    );

    expect(r).toEqual({ success: true, providerMessageId: "77" });
    const [req] = net.requests;
    expect(req!.method).toBe("POST");
    expect(req!.path).toBe("/bot123:abc/sendMessage");
    expect(req!.json()).toEqual({
      chat_id: "-100200",
      text: "Alert\n\nDisk full",
      parse_mode: "HTML",
      disable_notification: true,
    });
  });

  it("sends a subject-only template as just the subject", async () => {
    net.on("api.telegram.org", () => ({ json: { ok: true, result: { message_id: 1 } } }));
    await t.send(task({ content: { subject: "Only a subject" } }));
    expect(net.requests[0]!.json().text).toBe("Only a subject");
  });

  it("marks a blocked bot or vanished chat as a dead destination", async () => {
    net.on("api.telegram.org", () => ({
      status: 403,
      json: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
    }));
    expect(await t.send(task())).toMatchObject({
      success: false,
      invalidToken: true,
      error: "Forbidden: bot was blocked by the user",
    });

    net.on("api.telegram.org", () => ({
      status: 400,
      json: { ok: false, error_code: 400, description: "Bad Request: chat not found" },
    }));
    expect((await t.send(task())).invalidToken).toBe(true);
  });

  it("treats a rate limit as retryable, not as a dead destination", async () => {
    net.on("api.telegram.org", () => ({
      status: 429,
      json: { ok: false, error_code: 429, description: "Too Many Requests: retry after 5" },
    }));
    expect(await t.send(task())).toMatchObject({ success: false, invalidToken: false });
  });

  it("reports a network failure or a non-JSON gateway page as a failed send", async () => {
    net.on("api.telegram.org", () => "hang-up");
    expect((await t.send(task())).success).toBe(false);
    net.on("api.telegram.org", () => ({ status: 502, text: "<html>Bad Gateway</html>" }));
    expect((await t.send(task())).success).toBe(false);
  });

  it("refuses a task with no chat id without calling the API", async () => {
    expect((await t.send(task({ destination: undefined }))).success).toBe(false);
    expect(net.requests).toEqual([]);
  });
});

// ─── Discord ────────────────────────────────────────────────────────────────

describe("DiscordTransport", () => {
  const d = new DiscordTransport({ username: "Alerts" });
  const hook = "https://discord.com/api/webhooks/1/abc";

  it("posts to the webhook, waiting for the created message's id", async () => {
    net.on("discord.com", () => ({ json: { id: "msg-9" } }));
    const r = await d.send(
      task({
        destination: hook,
        content: { subject: "Deploy", text: "done", avatarUrl: "https://x/a.png" },
      }),
    );
    expect(r).toEqual({ success: true, providerMessageId: "msg-9" });
    expect(net.requests[0]!.path).toBe("/api/webhooks/1/abc?wait=true");
    expect(net.requests[0]!.json()).toEqual({
      content: "**Deploy**\ndone",
      username: "Alerts",
      avatar_url: "https://x/a.png",
    });
  });

  it("sends a subject-only template as just the subject", async () => {
    net.on("discord.com", () => ({ json: { id: "m" } }));
    await d.send(task({ destination: hook, content: { subject: "Heads up" } }));
    expect(net.requests[0]!.json().content).toBe("**Heads up**");
  });

  it("refuses to post anywhere but Discord", async () => {
    for (const bad of [
      "http://discord.com/api/webhooks/1/a",
      "https://evil.com/api/webhooks/1/a",
      "https://discord.com/other/1",
    ]) {
      expect(await d.send(task({ destination: bad }))).toMatchObject({
        success: false,
        invalidToken: true,
      });
    }
    expect(net.requests).toEqual([]);
  });

  it("marks a deleted webhook dead and a server error retryable", async () => {
    net.on("discord.com", () => ({
      status: 404,
      json: { message: "Unknown Webhook", code: 10015 },
    }));
    expect(await d.send(task({ destination: hook }))).toMatchObject({
      success: false,
      invalidToken: true,
    });
    net.on("discord.com", () => ({ status: 500, text: "oops" }));
    expect(await d.send(task({ destination: hook }))).toMatchObject({
      success: false,
      invalidToken: false,
    });
  });
});

// ─── Slack ──────────────────────────────────────────────────────────────────

describe("SlackTransport", () => {
  it("posts to chat.postMessage with the bot token", async () => {
    net.on("slack.com", () => ({ json: { ok: true, channel: "C1", ts: "1700.1" } }));
    const s = new SlackTransport({ botToken: "xoxb-1" });
    const r = await s.send(
      task({ destination: "C1", content: { text: "hi", blocks: [{ type: "divider" }] } }),
    );
    expect(r).toEqual({ success: true, providerMessageId: "C1:1700.1" });
    const req = net.requests[0]!;
    expect(req.path).toBe("/api/chat.postMessage");
    expect(req.headers.authorization).toBe("Bearer xoxb-1");
    expect(req.json()).toEqual({ channel: "C1", text: "hi", blocks: [{ type: "divider" }] });
  });

  it("uses a template's own channel over the recipient's", async () => {
    net.on("slack.com", () => ({ json: { ok: true, ts: "1" } }));
    await new SlackTransport({ token: "xoxb" }).send(
      task({ destination: "D-user", content: { channel: "C-alerts", subject: "S" } }),
    );
    expect(net.requests[0]!.json()).toMatchObject({ channel: "C-alerts", text: "S" });
  });

  it("marks an archived channel dead, but not a rate limit", async () => {
    const s = new SlackTransport({ botToken: "xoxb" });
    net.on("slack.com", () => ({ json: { ok: false, error: "is_archived" } }));
    expect(await s.send(task({ destination: "C" }))).toMatchObject({
      success: false,
      invalidToken: true,
    });
    net.on("slack.com", () => ({ json: { ok: false, error: "ratelimited" } }));
    expect(await s.send(task({ destination: "C" }))).toMatchObject({
      success: false,
      invalidToken: false,
    });
  });

  it("posts to an incoming webhook, and reads its plain-text errors", async () => {
    const s = new SlackTransport({ webhookUrl: "https://hooks.slack.com/services/T/B/x" });
    net.on("hooks.slack.com", () => ({ text: "ok" }));
    expect(
      await s.send(task({ destination: undefined, content: { text: "hello" } })),
    ).toMatchObject({ success: true });
    expect(net.requests[0]!.json()).toEqual({ text: "hello" });

    net.on("hooks.slack.com", () => ({ status: 404, text: "channel_not_found" }));
    expect(await s.send(task({ destination: undefined }))).toMatchObject({
      success: false,
      invalidToken: true,
    });
    net.on("hooks.slack.com", () => "hang-up");
    expect((await s.send(task({ destination: undefined }))).success).toBe(false);
  });

  it("explains, rather than calls Slack, when it has no way to send", async () => {
    expect((await new SlackTransport().send(task({ destination: undefined }))).error).toMatch(
      /No destination/,
    );
    expect((await new SlackTransport().send(task({ destination: "C1" }))).error).toMatch(
      /no botToken/,
    );
    expect(net.requests).toEqual([]);
  });
});

// ─── WhatsApp ───────────────────────────────────────────────────────────────

describe("WhatsAppTransport", () => {
  const w = new WhatsAppTransport({
    phoneNumberId: "PN1",
    accessToken: "tok",
    verifyToken: "vt",
    appSecret: "shh",
  });

  it("sends a text message to the digits of the number", async () => {
    net.on("graph.facebook.com", () => ({ json: { messages: [{ id: "wamid.1" }] } }));
    const r = await w.send(
      task({ destination: "+1 (555) 010-0200", content: { text: "Your code is 1" } }),
    );
    expect(r).toEqual({ success: true, providerMessageId: "wamid.1" });
    const req = net.requests[0]!;
    expect(req.path).toBe("/v21.0/PN1/messages");
    expect(req.headers.authorization).toBe("Bearer tok");
    expect(req.json()).toEqual({
      messaging_product: "whatsapp",
      to: "15550100200",
      type: "text",
      text: { body: "Your code is 1" },
    });
  });

  it("flags an expired access token, and gives up on a hung API within the task's timeout", async () => {
    net.on("graph.facebook.com", () => ({
      status: 401,
      json: { error: { code: 190, message: "Session expired" } },
    }));
    expect(await w.send(task({ destination: "+1555", content: { text: "x" } }))).toMatchObject({
      success: false,
      invalidToken: true,
      error: "Session expired",
    });

    net.on("graph.facebook.com", () => ({ delayMs: 3_000, json: {} }));
    const started = Date.now();
    const r = await w.send(
      task({
        destination: "+1555",
        content: { text: "x" },
        deliveryOptions: { maxAttempts: 3, timeoutMs: 300 },
      }),
    );
    expect(r.success).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("answers Meta's verification handshake only with the right token", () => {
    expect(
      w.verifyWebhookChallenge(
        new URLSearchParams("hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42"),
      ),
    ).toBe("42");
    expect(
      w.verifyWebhookChallenge(
        new URLSearchParams("hub.mode=subscribe&hub.verify_token=no&hub.challenge=42"),
      ),
    ).toBeUndefined();
  });

  it("accepts only webhooks signed with the app secret", () => {
    const raw = JSON.stringify({ entry: [] });
    const sig = `sha256=${createHmac("sha256", "shh").update(raw).digest("hex")}`;
    expect(w.verifyWebhook(raw, { "x-hub-signature-256": sig })).toBe(true);
    expect(w.verifyWebhook(raw + " ", { "x-hub-signature-256": sig })).toBe(false);
    expect(w.verifyWebhook(raw, {})).toBe(false);
    expect(
      new WhatsAppTransport({ phoneNumberId: "p", accessToken: "t" }).verifyWebhook(raw, {
        "x-hub-signature-256": sig,
      }),
    ).toBe(false);
  });

  it("maps read and failed statuses, ignoring the rest", async () => {
    const events = await w.parseWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: "a", status: "read", recipient_id: "1555", timestamp: "1700000000" },
                  { id: "b", status: "failed", recipient_id: "1666", errors: [{ code: 131026 }] },
                  { id: "c", status: "delivered" },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events.map((e) => [e.providerMessageId, e.status, e.recipient, e.bounceType])).toEqual([
      ["a", "opened", "1555", undefined],
      ["b", "bounced", "1666", undefined],
    ]);
  });
});

// ─── Resend ─────────────────────────────────────────────────────────────────

/** Signs a payload the way Resend (via Svix) does. */
function svixSign(secret: string, id: string, timestamp: number, payload: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": `v1,${sig}` };
}

describe("ResendTransport", () => {
  const secret = `whsec_${randomBytes(24).toString("base64")}`;
  const r = new ResendTransport({
    apiKey: "re_test",
    from: "Acme <no-reply@acme.test>",
    webhookSecret: secret,
  });

  it("sends the rendered email with its headers and returns Resend's id", async () => {
    net.on("api.resend.com", () => ({ json: { id: "re-1" } }));
    const res = await r.send(
      task({
        destination: "u@x.com",
        content: {
          subject: "Hi",
          html: "<b>Hi</b>",
          text: "Hi",
          from: "Sales <sales@acme.test>",
          replyTo: "help@acme.test",
        },
        deliveryOptions: {
          maxAttempts: 3,
          timeoutMs: 1000,
          headers: { "List-Unsubscribe": "<https://u>" },
        },
      }),
    );
    expect(res).toEqual({ success: true, providerMessageId: "re-1" });
    const req = net.requests[0]!;
    expect(req.path).toBe("/emails");
    expect(req.headers.authorization).toBe("Bearer re_test");
    expect(req.json()).toMatchObject({
      from: "Sales <sales@acme.test>",
      to: "u@x.com",
      subject: "Hi",
      html: "<b>Hi</b>",
      text: "Hi",
      reply_to: "help@acme.test",
      headers: { "List-Unsubscribe": "<https://u>" },
    });
  });

  it("escapes a text-only body when it builds the HTML part", async () => {
    net.on("api.resend.com", () => ({ json: { id: "re-2" } }));
    await r.send(
      task({
        destination: "u@x.com",
        content: { subject: "S", text: 'Hi <img src=x onerror="alert(1)">' },
      }),
    );
    const html = net.requests[0]!.json().html as string;
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("reports Resend's rejection", async () => {
    net.on("api.resend.com", () => ({
      status: 422,
      json: { statusCode: 422, name: "validation_error", message: "Invalid `to` field" },
    }));
    expect(await r.send(task({ destination: "nope" }))).toMatchObject({
      success: false,
      error: "Invalid `to` field",
    });
  });

  it("verifies Svix-signed webhooks and maps bounces, complaints, opens and clicks", async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      type: "email.bounced",
      created_at: new Date().toISOString(),
      data: {
        email_id: "re-1",
        to: ["u@x.com"],
        bounce: { type: "Permanent", message: "no such user" },
      },
    });
    const headers = svixSign(secret, "msg_1", now, payload);

    expect(r.verifyWebhook(payload, headers)).toBe(true);
    const [bounce] = await r.parseWebhook(JSON.parse(payload), payload, headers);
    expect(bounce).toMatchObject({
      providerMessageId: "re-1",
      status: "bounced",
      bounceType: "hard",
      recipient: "u@x.com",
    });

    const click = JSON.stringify({
      type: "email.clicked",
      data: { email_id: "re-2", to: ["u@x.com"], click: { link: "https://acme.test" } },
    });
    const [c] = await r.parseWebhook(null, click, svixSign(secret, "msg_2", now, click));
    expect(c).toMatchObject({ status: "clicked", metadata: { url: "https://acme.test" } });

    const delivered = JSON.stringify({ type: "email.delivered", data: { email_id: "re-3" } });
    expect(
      await r.parseWebhook(null, delivered, svixSign(secret, "msg_3", now, delivered)),
    ).toEqual([]);
  });

  it("rejects a forged, replayed-from-long-ago or unsigned webhook", async () => {
    const payload = JSON.stringify({
      type: "email.complained",
      data: { email_id: "re-1", to: ["u@x.com"] },
    });
    const forged = svixSign(
      `whsec_${randomBytes(24).toString("base64")}`,
      "m",
      Math.floor(Date.now() / 1000),
      payload,
    );
    expect(r.verifyWebhook(payload, forged)).toBe(false);
    expect(
      r.verifyWebhook(
        payload,
        svixSign(secret, "m", Math.floor(Date.now() / 1000) - 3600, payload),
      ),
    ).toBe(false);
    expect(r.verifyWebhook(payload, {})).toBe(false);
    expect(await r.parseWebhook(JSON.parse(payload), payload, forged)).toEqual([]);
    expect(
      new ResendTransport({ apiKey: "k", from: "f" }).verifyWebhook(
        payload,
        svixSign(secret, "m", Math.floor(Date.now() / 1000), payload),
      ),
    ).toBe(false);
  });
});

// ─── Twilio (webhook side; sending goes through Twilio's own HTTPS client) ──

/** Twilio's documented request signature: HMAC-SHA1 over URL + sorted params. */
function twilioSign(authToken: string, url: string, params: Record<string, string>) {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}

describe("TwilioTransport webhooks", () => {
  const url = "https://api.acme.test/webhooks/twilio";
  const t = new TwilioTransport({
    accountSid: "AC1",
    authToken: "secret",
    from: "+1000",
    statusCallbackUrl: url,
  });

  it("mounts at the callback URL's path", () => {
    expect(t.webhookPath).toBe("/webhooks/twilio");
    expect(
      () =>
        new TwilioTransport({
          accountSid: "a",
          authToken: "b",
          from: "c",
          statusCallbackUrl: "not a url",
        }),
    ).toThrow();
  });

  it("verifies Twilio's signature over every posted field", async () => {
    const params = {
      MessageSid: "SM1",
      MessageStatus: "undelivered",
      To: "+1555",
      ErrorCode: "30005",
      NewField: "x",
    };
    const raw = new URLSearchParams(params).toString();
    const sig = twilioSign("secret", url, params);

    expect(await t.verifyWebhook(raw, { "x-twilio-signature": sig })).toBe(true);
    expect(
      await t.verifyWebhook(raw.replace("30005", "30006"), { "x-twilio-signature": sig }),
    ).toBe(false);
    expect(await t.verifyWebhook(raw, {})).toBe(false);

    const [e] = await t.parseWebhook({}, raw, { "x-twilio-signature": sig });
    expect(e).toMatchObject({
      providerMessageId: "SM1",
      status: "bounced",
      bounceType: "hard",
      recipient: "+1555",
    });
  });

  it("treats a STOP reply as an unsubscribe and ignores progress reports", async () => {
    const stop = { MessageSid: "SM2", MessageStatus: "failed", To: "+1555", ErrorCode: "21610" };
    const raw = new URLSearchParams(stop).toString();
    const [e] = await t.parseWebhook({}, raw, {
      "x-twilio-signature": twilioSign("secret", url, stop),
    });
    expect(e!.status).toBe("unsubscribed");

    const sent = { MessageSid: "SM3", MessageStatus: "sent" };
    const raw2 = new URLSearchParams(sent).toString();
    expect(
      await t.parseWebhook({}, raw2, { "x-twilio-signature": twilioSign("secret", url, sent) }),
    ).toEqual([]);
  });

  it("refuses to send without a destination or a body", async () => {
    expect((await t.send(task({ destination: undefined }))).success).toBe(false);
    expect((await t.send(task({ destination: "+1", content: { subject: "only" } }))).success).toBe(
      false,
    );
  });
});

describe("ConsoleTransport", () => {
  it("delivers after the configured latency and returns a message id", async () => {
    const c = new ConsoleTransport({ channel: "sms", latencyMs: "50-60" });
    const started = Date.now();
    const r = await c.send(task());
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(r.success).toBe(true);
    expect(r.providerMessageId).toMatch(/^console-/);
    expect(new ConsoleTransport().channel).toBe("push");
  });
});

// ─── Which failures are worth retrying ─────────────────────────────────────
//
// `retryable: false` tells delivery that sending again cannot help: it fails
// the task at once, and the circuit breaker does not count it against the
// provider. A request the provider refused as wrong (4xx) is that; a timeout,
// a rate limit, a 5xx or a dropped connection is not.

type Reply = Parameters<FakeInternet["on"]>[1];
const permanent = { success: false, retryable: false };
const notPermanent = (r: { success: boolean; retryable?: boolean }) =>
  r.success === false && r.retryable !== false;

describe("which failures are worth retrying", () => {
  describe("Telegram", () => {
    const t = new TelegramTransport({ botToken: "123:abc" });
    const reply =
      (status: number, description: string): Reply =>
      () => ({
        status,
        json: { ok: false, error_code: status, description },
      });

    it("gives up on a request Telegram refused, or a chat that is gone", async () => {
      net.on("api.telegram.org", reply(400, "Bad Request: message is too long"));
      expect(await t.send(task({ destination: "1" }))).toMatchObject(permanent);
      net.on("api.telegram.org", reply(403, "Forbidden: bot was blocked by the user"));
      expect(await t.send(task({ destination: "1" }))).toMatchObject({
        ...permanent,
        invalidToken: true,
      });
      expect(await t.send(task({ destination: undefined }))).toMatchObject(permanent);
    });

    it("tries again after a rate limit, a server error or a dropped connection", async () => {
      net.on("api.telegram.org", reply(429, "Too Many Requests: retry after 5"));
      expect(notPermanent(await t.send(task({ destination: "1" })))).toBe(true);
      net.on("api.telegram.org", () => ({ status: 502, text: "<html>Bad Gateway</html>" }));
      expect(notPermanent(await t.send(task({ destination: "1" })))).toBe(true);
      net.on("api.telegram.org", () => "hang-up");
      expect(notPermanent(await t.send(task({ destination: "1" })))).toBe(true);
    });
  });

  describe("Discord", () => {
    const d = new DiscordTransport();
    const hook = "https://discord.com/api/webhooks/1/abc";

    it("gives up on a request Discord refused, or a webhook that is gone", async () => {
      net.on("discord.com", () => ({
        status: 400,
        json: { message: "Cannot send an empty message" },
      }));
      expect(await d.send(task({ destination: hook }))).toMatchObject(permanent);
      net.on("discord.com", () => ({ status: 404, json: { message: "Unknown Webhook" } }));
      expect(await d.send(task({ destination: hook }))).toMatchObject({
        ...permanent,
        invalidToken: true,
      });
      expect(await d.send(task({ destination: "https://evil.com/x" }))).toMatchObject(permanent);
    });

    it("tries again after a rate limit or a server error", async () => {
      net.on("discord.com", () => ({
        status: 429,
        json: { message: "You are being rate limited." },
      }));
      expect(notPermanent(await d.send(task({ destination: hook })))).toBe(true);
      net.on("discord.com", () => ({ status: 503, text: "unavailable" }));
      expect(notPermanent(await d.send(task({ destination: hook })))).toBe(true);
    });
  });

  describe("Slack", () => {
    // The Web API answers almost every error with HTTP 200 and a code.
    const s = new SlackTransport({ botToken: "xoxb" });
    const webhook = new SlackTransport({ webhookUrl: "https://hooks.slack.com/services/T/B/x" });

    it("gives up on a request Slack refused", async () => {
      for (const error of ["is_archived", "invalid_blocks", "msg_too_long", "invalid_auth"]) {
        net.on("slack.com", () => ({ json: { ok: false, error } }));
        expect(await s.send(task({ destination: "C" }))).toMatchObject(permanent);
      }
      net.on("hooks.slack.com", () => ({ status: 400, text: "invalid_payload" }));
      expect(await webhook.send(task({ destination: undefined }))).toMatchObject(permanent);
      expect(await new SlackTransport().send(task({ destination: "C1" }))).toMatchObject(permanent);
    });

    it("tries again after a rate limit, an outage on Slack's side or a dropped connection", async () => {
      for (const error of ["ratelimited", "internal_error", "service_unavailable"]) {
        net.on("slack.com", () => ({ json: { ok: false, error } }));
        expect(notPermanent(await s.send(task({ destination: "C" })))).toBe(true);
      }
      net.on("hooks.slack.com", () => ({ status: 500, text: "oops" }));
      expect(notPermanent(await webhook.send(task({ destination: undefined })))).toBe(true);
      net.on("hooks.slack.com", () => "hang-up");
      expect(notPermanent(await webhook.send(task({ destination: undefined })))).toBe(true);
    });
  });

  describe("WhatsApp", () => {
    const w = new WhatsAppTransport({ phoneNumberId: "PN1", accessToken: "tok" });
    const send = () => w.send(task({ destination: "+1555", content: { text: "x" } }));
    const graphError =
      (status: number, code: number): Reply =>
      () => ({
        status,
        json: { error: { code, message: `error ${code}` } },
      });

    it("gives up on a request Meta refused", async () => {
      net.on("graph.facebook.com", graphError(400, 131009)); // parameter value is not valid
      expect(await send()).toMatchObject(permanent);
      expect(await w.send(task({ destination: undefined }))).toMatchObject(permanent);
    });

    it("tries again after a rate limit, even the ones Meta sends as a 400", async () => {
      for (const code of [4, 80007, 130429, 131048, 131056]) {
        net.on("graph.facebook.com", graphError(400, code));
        expect(notPermanent(await send())).toBe(true);
      }
      net.on("graph.facebook.com", graphError(429, 130429));
      expect(notPermanent(await send())).toBe(true);
      net.on("graph.facebook.com", graphError(500, 131000));
      expect(notPermanent(await send())).toBe(true);
    });
  });

  describe("Resend", () => {
    const r = new ResendTransport({ apiKey: "re_test", from: "a@acme.test" });
    const rejection =
      (statusCode: number, name: string): Reply =>
      () => ({
        status: statusCode,
        json: { statusCode, name, message: name },
      });

    it("gives up on a request Resend refused", async () => {
      net.on("api.resend.com", rejection(422, "validation_error"));
      expect(await r.send(task({ destination: "nope" }))).toMatchObject(permanent);
      net.on("api.resend.com", rejection(403, "invalid_from_address"));
      expect(await r.send(task({ destination: "u@x.com" }))).toMatchObject(permanent);
      expect(await r.send(task({ destination: undefined }))).toMatchObject(permanent);
    });

    it("tries again after a rate limit, a server error or a dropped connection", async () => {
      net.on("api.resend.com", rejection(429, "rate_limit_exceeded"));
      expect(notPermanent(await r.send(task({ destination: "u@x.com" })))).toBe(true);
      net.on("api.resend.com", rejection(500, "internal_server_error"));
      expect(notPermanent(await r.send(task({ destination: "u@x.com" })))).toBe(true);
      net.on("api.resend.com", () => "hang-up");
      expect(notPermanent(await r.send(task({ destination: "u@x.com" })))).toBe(true);
    });
  });
});

// ─── A provider end to end ─────────────────────────────────────────────────

describe("Resend inside notifkit", () => {
  const infra = useInfra();
  let app: Running;
  const secret = `whsec_${randomBytes(24).toString("base64")}`;

  beforeAll(async () => {
    app = await startNotifkit(infra, {
      services: ["api", "enricher", "engine", "delivery", "events"],
      providers: [
        new ResendTransport({
          apiKey: "re_live",
          from: "no-reply@acme.test",
          webhookSecret: secret,
        }),
      ],
      env: { RATE_LIMIT_PER_HOUR: "100000" },
    });
  }, 120_000);
  afterAll(async () => {
    await app?.stop();
  }, 60_000);

  it("delivers through Resend's API, then suppresses the address when Resend reports a hard bounce", async () => {
    let n = 0;
    net.on("api.resend.com", () => ({ json: { id: `re-${++n}` } }));
    const p = await app.project();
    await p.api("PUT", "/v1/templates", {
      templates: [
        { id: "t", channel: "email", content: { subject: "Hi {{name}}", text: "Hello" } },
      ],
    });
    await p.api("POST", "/v1/users", { id: "u", email: "gone@x.com" });
    await p.api("POST", "/v1/notify", { user: "u", template: "t", data: { name: "Al" } });

    await waitFor("sent to Resend", () => net.requests.some((r) => r.host === "api.resend.com"));
    const sent = net.requests.find((r) => r.host === "api.resend.com")!.json();
    expect(sent).toMatchObject({ to: "gone@x.com", subject: "Hi Al", from: "no-reply@acme.test" });
    await waitFor("logged", async () => {
      const rows =
        await infra.sql`SELECT 1 FROM message_logs WHERE provider_message_id = 're-1' AND status = 'delivered'`;
      return rows.length === 1;
    });

    const payload = JSON.stringify({
      type: "email.bounced",
      data: { email_id: "re-1", to: ["gone@x.com"], bounce: { type: "Permanent" } },
    });
    const res = await apiClient(app.baseUrl)("POST", "/webhooks/resend", payload, {
      "content-type": "application/json",
      ...svixSign(secret, "msg_e2e", Math.floor(Date.now() / 1000), payload),
    });
    expect(res.status).toBe(200);

    const suppressions = await p.api("GET", "/v1/suppressions");
    expect(suppressions.body.suppressions.map((s: any) => [s.target, s.reason])).toEqual([
      ["gone@x.com", "bounced"],
    ]);
  });
});
