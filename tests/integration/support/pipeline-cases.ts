import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { STREAMS, buildStreamEvent } from "@/contracts/index.js";
import { globalEmitter } from "@/shared/index.js";
import { useInfra, waitFor, settle } from "./infra.js";
import {
  RecordingTransport,
  startNotifkit,
  apiClient,
  type Running,
  type Api,
} from "./pipeline.js";

/**
 * The delivery guarantees notifkit makes, checked end to end: a request goes
 * in through the HTTP API, and the assertion is on what the provider was
 * actually asked to send — never on which internal function was called.
 *
 * Run twice: once with every stage hopping through Redis streams, and once
 * with the fused in-process pipeline, since the two take different code paths.
 */
export function definePipelineSuite(mode: { fused: boolean }) {
  const infra = useInfra();
  let app: Running;

  // "bounce…" addresses hard-bounce: permanent, so delivery fails them at once
  // rather than retrying.
  const email = new RecordingTransport("email", {
    behaviour: (task) =>
      task.destination?.startsWith("bounce")
        ? { success: false, error: "mailbox unavailable", retryable: false }
        : { success: true, providerMessageId: `pm-${task.taskId}` },
  });
  const sms = new RecordingTransport("sms");
  const push = new RecordingTransport("push", {
    behaviour: (task) =>
      task.destination === "dead-token"
        ? { success: false, invalidToken: true }
        : { success: true, providerMessageId: `push-${task.taskId}` },
  });
  // A provider that only takes one message every two seconds.
  const whatsapp = new RecordingTransport("whatsapp", { limits: { limit: 1, windowSeconds: 2 } });

  beforeAll(async () => {
    app = await startNotifkit(infra, {
      fusedPipeline: mode.fused,
      providers: [email, sms, push, whatsapp],
      env: {
        RATE_LIMIT_PER_HOUR: "100000",
        SEGMENT_MAX_USERS: "5",
        UNSUBSCRIBE_SECRET: "an-unsubscribe-secret-for-tests",
        PUBLIC_URL: "https://notify.example.com",
      },
    });
  }, 120_000);

  afterAll(async () => {
    await app?.stop();
  }, 60_000);

  /** A fresh project with the usual templates, so tests never see each other's data. */
  async function project() {
    const p = await app.project();
    const res = await p.api("PUT", "/v1/templates", {
      templates: [
        {
          id: "receipt",
          channel: "email",
          content: {
            subject: "Receipt for {{name}}",
            html: "<p>Hi {{name}}</p>",
            text: "Hi {{name}}, raw: {{{name}}}",
          },
        },
        {
          id: "news",
          channel: "email",
          topic: "newsletter",
          content: { subject: "News", text: "Hello" },
        },
        { id: "otp", channel: "sms", content: { text: "Code {{code}}" } },
      ],
    });
    expect(res.status).toBe(200);
    return p;
  }

  async function addUser(api: Api, body: Record<string, unknown>) {
    const res = await api("POST", "/v1/users", body);
    expect(res.status).toBe(201);
  }

  async function notify(api: Api, body: Record<string, unknown>, headers?: Record<string, string>) {
    const res = await api("POST", "/v1/notify", body, headers);
    expect(res.status).toBe(202);
    return res.body;
  }

  const allSent = (projectId: string) => [
    ...email.for(projectId),
    ...sms.for(projectId),
    ...push.for(projectId),
    ...whatsapp.for(projectId),
  ];

  /**
   * Nothing delivered after the pipeline has had time to act. A marker
   * notification sent afterwards to a control user proves the pipeline is
   * running, so an empty result is not just a slow one.
   */
  async function expectNothingSentFor(
    p: { id: string; api: Api },
    filter: (t: any) => boolean = () => true,
  ) {
    const control = `control-${randomUUID().slice(0, 6)}`;
    await addUser(p.api, { id: control, email: `${control}@x.com` });
    await notify(p.api, { user: control, template: "receipt", data: { name: "c" } });
    await waitFor("control delivered", () =>
      email.for(p.id).some((t) => t.recipientId === control),
    );
    await settle(300);
    expect(
      allSent(p.id)
        .filter((t) => t.recipientId !== control)
        .filter(filter),
    ).toEqual([]);
  }

  describe(`pipeline (${mode.fused ? "fused" : "streamed"})`, () => {
    it("delivers one rendered email per notify, and records it", async () => {
      const p = await project();
      await addUser(p.api, { id: "u1", email: "u1@x.com" });

      await notify(p.api, { user: "u1", template: "receipt", data: { name: "<Al>\r\nBcc: x" } });

      await waitFor("delivered", () => email.for(p.id).length === 1);
      const [task] = email.for(p.id);
      expect(task!.destination).toBe("u1@x.com");
      expect(task!.renderedContent.content).toEqual({
        subject: "Receipt for <Al> Bcc: x",
        html: "<p>Hi &lt;Al&gt;\r\nBcc: x</p>",
        text: "Hi <Al>\r\nBcc: x, raw: <Al>\r\nBcc: x",
      });

      await waitFor("logged", async () => {
        const rows =
          await infra.sql`SELECT kind, status FROM message_logs WHERE task_id = ${task!.taskId} ORDER BY kind`;
        return rows.length === 2;
      });
      const rows =
        await infra.sql`SELECT kind, status, provider_message_id FROM message_logs WHERE task_id = ${task!.taskId} ORDER BY kind`;
      expect(rows.map((r) => [r.kind, r.status])).toEqual([
        ["attempt", "delivered"],
        ["dispatched", "dispatched"],
      ]);
      expect(rows[0]!.provider_message_id).toBe(`pm-${task!.taskId}`);

      const status = await p.api("GET", `/v1/notifications/${encodeURIComponent(task!.taskId)}`);
      expect(status.status).toBe(200);
      expect(status.body.status).toBe("delivered");

      const [outbox] =
        await infra.sql`SELECT provider_message_id FROM delivery_outbox WHERE task_id = ${task!.taskId}`;
      expect(outbox!.provider_message_id).toBe(`pm-${task!.taskId}`);

      await settle(300);
      expect(email.for(p.id)).toHaveLength(1);
    });

    it("sends once per requested channel and once per address", async () => {
      const p = await project();
      await addUser(p.api, { id: "u", email: ["a@x.com", "b@x.com"], phone: "+15550001" });

      await notify(p.api, { user: "u", template: "receipt", channels: ["email", "sms"] });

      await waitFor("three sends", () => allSent(p.id).length === 3);
      expect(
        email
          .for(p.id)
          .map((t) => t.destination)
          .sort(),
      ).toEqual(["a@x.com", "b@x.com"]);
      expect(sms.for(p.id).map((t) => t.destination)).toEqual(["+15550001"]);
      await settle(300);
      expect(allSent(p.id)).toHaveLength(3);
    });

    it("creates inline users on the fly", async () => {
      const p = await project();
      await notify(p.api, { user: { id: "inline", email: "inline@x.com" }, template: "receipt" });
      await waitFor("delivered", () => email.for(p.id).length === 1);
      expect(email.for(p.id)[0]!.destination).toBe("inline@x.com");
    });

    it("reaches an address added seconds after the user's last send", async () => {
      const p = await project();
      await notify(p.api, { user: { id: "u", email: "u@x.com" }, template: "receipt" });
      await waitFor("email delivered", () => email.for(p.id).length === 1);

      // A signup's OTP: the same user, now with a phone, right after the welcome mail.
      await notify(p.api, {
        user: { id: "u", phone: "+15550002" },
        template: "otp",
        channels: ["sms"],
        data: { code: "1234" },
      });
      await waitFor("sms delivered", () => sms.for(p.id).length === 1);
      expect(sms.for(p.id)[0]!.destination).toBe("+15550002");
    });

    it("reaches every member of a segment exactly once, and only in this project", async () => {
      const p = await project();
      const other = await project();
      for (const id of ["s1", "s2", "s3"])
        await addUser(p.api, { id, email: `${id}@x.com`, segments: ["vip"] });
      await addUser(p.api, { id: "outsider", email: "out@x.com" });
      await addUser(other.api, { id: "foreign", email: "foreign@x.com", segments: ["vip"] });

      await notify(p.api, { segment: "vip", template: "receipt" });

      await waitFor("3 delivered", () => email.for(p.id).length === 3);
      await settle(500);
      expect(
        email
          .for(p.id)
          .map((t) => t.recipientId)
          .sort(),
      ).toEqual(["s1", "s2", "s3"]);
      expect(email.for(other.id)).toEqual([]);
    });

    it("reaches users subscribed to a topic", async () => {
      const p = await project();
      await addUser(p.api, {
        id: "fan",
        email: "fan@x.com",
        preferences: { topics: { launches: true } },
      });
      await addUser(p.api, {
        id: "meh",
        email: "meh@x.com",
        preferences: { topics: { launches: false } },
      });

      await notify(p.api, { topic: "launches", template: "receipt" });

      await waitFor("delivered", () => email.for(p.id).length === 1);
      expect(email.for(p.id)[0]!.recipientId).toBe("fan");
    });

    it("refuses a segment larger than the fan-out limit, and says so", async () => {
      const p = await project();
      for (let i = 0; i < 6; i++)
        await addUser(p.api, { id: `big${i}`, email: `big${i}@x.com`, segments: ["huge"] });

      const failures: unknown[][] = [];
      const onFailed = (...args: unknown[]) => failures.push(args);
      app.server.on("notification:failed", onFailed);
      try {
        await notify(p.api, { segment: "huge", template: "receipt" });
        await waitFor("failure reported", () => failures.length > 0);
        expect(String(failures[0]![1])).toMatch(/exceeds limit/);
        await expectNothingSentFor(p);
      } finally {
        app.server.off("notification:failed", onFailed);
      }
    });

    it("sends nothing to an unknown user", async () => {
      const p = await project();
      await notify(p.api, { user: "ghost", template: "receipt" });
      await expectNothingSentFor(p);
    });

    it("sends nothing for a template that does not exist", async () => {
      const p = await project();
      await addUser(p.api, { id: "u", email: "u@x.com" });
      await notify(p.api, { user: "u", template: "missing" });
      await expectNothingSentFor(p);
    });

    it("sends once for repeated requests carrying the same idempotency key", async () => {
      const p = await project();
      await addUser(p.api, { id: "u", email: "u@x.com" });
      const key = `order-${randomUUID()}`;
      await Promise.all([
        notify(p.api, { user: "u", template: "receipt" }, { "x-idempotency-key": key }),
        notify(p.api, { user: "u", template: "receipt" }, { "x-idempotency-key": key }),
        notify(p.api, { user: "u", template: "receipt" }, { "x-idempotency-key": key }),
      ]);
      await waitFor("delivered", () => email.for(p.id).length >= 1);
      await settle(1_000);
      expect(email.for(p.id)).toHaveLength(1);
    });

    describe("idempotency marker lifetimes", () => {
      // Markers are most of what Redis holds under load: a few per message.
      // Only a caller's own key is a promise that outlives the pipeline (the
      // documented 24-hour window); the rest just have to outlast redelivery.
      const HOUR = 3_600;

      /** Every marker written while `run` executes, with its remaining TTL. */
      async function markersWrittenDuring(run: () => Promise<void>) {
        const before = new Set(await infra.redis.keys("notif:processed:*"));
        await run();
        const added = (await infra.redis.keys("notif:processed:*")).filter((k) => !before.has(k));
        return Promise.all(added.map(async (key) => ({ key, ttl: await infra.redis.ttl(key) })));
      }

      it("keeps a caller's idempotency key for 24 hours", async () => {
        const p = await project();
        await addUser(p.api, { id: "u", email: "u@x.com" });
        const key = `order-${randomUUID()}`;
        const markers = await markersWrittenDuring(async () => {
          await notify(p.api, { user: "u", template: "receipt" }, { "x-idempotency-key": key });
          await waitFor("delivered", () => email.for(p.id).length === 1);
          await settle(300);
        });

        const clientMarker = markers.find(
          (m) => m.key === `notif:processed:enricher:${p.id}:${key}`,
        );
        expect(clientMarker?.ttl).toBeGreaterThan(23 * HOUR);
        for (const m of markers.filter((m) => m !== clientMarker)) {
          expect(m, m.key).toMatchObject({ ttl: expect.any(Number) });
          expect(m.ttl, m.key).toBeLessThanOrEqual(HOUR);
        }
      });

      it("keeps every marker of a request without a key for at most an hour", async () => {
        const p = await project();
        await addUser(p.api, { id: "u", email: "u@x.com" });
        const markers = await markersWrittenDuring(async () => {
          await notify(p.api, { user: "u", template: "receipt" });
          await waitFor("delivered", () => email.for(p.id).length === 1);
          await settle(300);
        });

        // enricher and delivery always; the engine too when streamed.
        expect(markers.length).toBeGreaterThanOrEqual(2);
        for (const m of markers) {
          expect(m.ttl, m.key).toBeGreaterThan(0);
          expect(m.ttl, m.key).toBeLessThanOrEqual(HOUR);
        }
      });
    });

    it("sends once when the same inbound event is read twice", async () => {
      const p = await project();
      await addUser(p.api, { id: "u", email: "u@x.com" });
      const event = {
        ...buildStreamEvent(
          "notification.requested",
          { projectId: p.id, target: { type: "user", userId: "u" }, templateId: "receipt" },
          "test",
        ),
        id: randomUUID(),
        timestamp: new Date().toISOString(),
      };
      await infra.redis.xadd(STREAMS.INBOUND_NORMAL, "*", "data", JSON.stringify(event));
      await infra.redis.xadd(STREAMS.INBOUND_NORMAL, "*", "data", JSON.stringify(event));

      await waitFor("delivered", () => email.for(p.id).length >= 1);
      await settle(1_000);
      expect(email.for(p.id)).toHaveLength(1);
    });

    describe("legacy notification.created events", () => {
      async function legacy(projectId: string, recipientId: string, templateId: string) {
        const event = {
          ...buildStreamEvent(
            "notification.created",
            { projectId, recipientId, channel: "email", templateId, payload: { name: "Legacy" } },
            "test",
          ),
          id: randomUUID(),
          timestamp: new Date().toISOString(),
        };
        await infra.redis.xadd(STREAMS.INBOUND_NORMAL, "*", "data", JSON.stringify(event));
      }

      it("are still delivered", async () => {
        const p = await project();
        await addUser(p.api, { id: "old", email: "old@x.com" });
        await legacy(p.id, "old", "receipt");
        await waitFor("delivered", () => email.for(p.id).length === 1);
        expect(email.for(p.id)[0]!.renderedContent.content).toMatchObject({
          subject: "Receipt for Legacy",
        });
      });

      it("respect the user's topic opt-outs", async () => {
        const p = await project();
        await addUser(p.api, {
          id: "old",
          email: "old@x.com",
          preferences: { topics: { newsletter: false } },
        });
        await legacy(p.id, "old", "news");
        await expectNothingSentFor(p);
      });
    });

    describe("consent", () => {
      it("does not send a topic's mail to a user who opted out of that topic", async () => {
        const p = await project();
        await addUser(p.api, {
          id: "u",
          email: "u@x.com",
          preferences: { topics: { newsletter: false } },
        });
        await notify(p.api, { user: "u", template: "news" });
        await expectNothingSentFor(p);
      });

      it("stops a topic's mail as soon as the user opts out of it", async () => {
        const p = await project();
        await addUser(p.api, { id: "u", email: "u@x.com" });
        await notify(p.api, { user: "u", template: "news" });
        await waitFor("delivered", () => email.for(p.id).length === 1);

        const res = await p.api("PATCH", "/v1/users/u/preferences", {
          topics: { newsletter: false },
        });
        expect(res.status).toBe(200);

        await notify(p.api, { user: "u", template: "news", data: { after: true } });
        await expectNothingSentFor(p, (t) => t.templateVariables?.after === true);
      });

      it("still sends transactional mail to that user", async () => {
        const p = await project();
        await addUser(p.api, {
          id: "u",
          email: "u@x.com",
          preferences: { topics: { newsletter: false } },
        });
        await notify(p.api, { user: "u", template: "receipt" });
        await waitFor("delivered", () => email.for(p.id).length === 1);
      });

      it("applies a topic added to a template straight away", async () => {
        const p = await project();
        await addUser(p.api, {
          id: "u",
          email: "u@x.com",
          preferences: { topics: { newsletter: false } },
        });
        await notify(p.api, { user: "u", template: "receipt", data: { name: "before" } });
        await waitFor("delivered", () => email.for(p.id).length === 1);

        const res = await p.api("PUT", "/v1/templates", {
          templates: [
            {
              id: "receipt",
              channel: "email",
              topic: "newsletter",
              content: { subject: "Receipt for {{name}}", text: "Hi {{name}}" },
            },
          ],
        });
        expect(res.status).toBe(200);
        await settle(300);

        await notify(p.api, { user: "u", template: "receipt", data: { name: "after" } });
        await expectNothingSentFor(
          p,
          (t) => t.renderedContent.content.subject === "Receipt for after",
        );
      });

      it("skips only the address that opted out of the topic", async () => {
        const p = await project();
        await addUser(p.api, {
          id: "u",
          contacts: [
            {
              channel: "email",
              target: "work@x.com",
              preferences: { topics: { newsletter: false } },
            },
            { channel: "email", target: "home@x.com" },
          ],
        });
        await notify(p.api, { user: "u", template: "news" });
        await waitFor("delivered", () => email.for(p.id).length >= 1);
        await settle(500);
        expect(email.for(p.id).map((t) => t.destination)).toEqual(["home@x.com"]);
      });

      it("does not use a channel the user switched off", async () => {
        const p = await project();
        await addUser(p.api, {
          id: "u",
          email: "u@x.com",
          phone: "+15550000555",
          preferences: { channels: { sms: false } },
        });
        await notify(p.api, { user: "u", template: "receipt", channels: ["email", "sms"] });
        await waitFor("email delivered", () => email.for(p.id).length === 1);
        await settle(500);
        expect(sms.for(p.id)).toEqual([]);
      });

      it("never sends to a suppressed address, whatever its case, even when critical", async () => {
        const p = await project();
        const res = await p.api("POST", "/v1/suppressions", {
          channel: "email",
          target: "Blocked@X.com",
          reason: "complained",
        });
        expect(res.status).toBe(201);
        await addUser(p.api, { id: "u", email: "blocked@x.com" });
        await notify(p.api, { user: "u", template: "receipt", priority: "critical" });
        await expectNothingSentFor(p, (t) => t.recipientId === "u");
      });

      it("puts a working one-click unsubscribe on topic mail, and honours it", async () => {
        const p = await project();
        await addUser(p.api, { id: "u", email: "u@x.com" });
        await notify(p.api, { user: "u", template: "news" });
        await waitFor("delivered", () => email.for(p.id).length === 1);

        const headers = email.for(p.id)[0]!.deliveryOptions.headers!;
        expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
        const url = new URL(headers["List-Unsubscribe"]!.slice(1, -1));
        expect(url.origin).toBe("https://notify.example.com");

        // What a mail client does when the recipient presses the button.
        const oneClick = await apiClient(app.baseUrl)(
          "POST",
          `${url.pathname}${url.search}`,
          "List-Unsubscribe=One-Click",
          {
            "content-type": "application/x-www-form-urlencoded",
          },
        );
        expect(oneClick.status).toBe(200);

        const prefs = await p.api("GET", "/v1/users/u/preferences");
        expect(prefs.body.topics).toEqual({ newsletter: false });
      });

      it("puts no unsubscribe link on transactional mail", async () => {
        const p = await project();
        await addUser(p.api, { id: "u", email: "u@x.com" });
        await notify(p.api, { user: "u", template: "receipt" });
        await waitFor("delivered", () => email.for(p.id).length === 1);
        expect(email.for(p.id)[0]!.deliveryOptions.headers).toBeUndefined();
      });
    });

    describe("throttling", () => {
      it("caps non-critical sends per user at the project's limit", async () => {
        const p = await project();
        const patched = await app.admin("PATCH", `/v1/projects/${p.id}`, { throttleLimit: 2 });
        expect(patched.status).toBe(200);
        await addUser(p.api, { id: "u", email: "u@x.com" });

        for (let i = 0; i < 4; i++) await notify(p.api, { user: "u", template: "receipt" });

        await waitFor("two delivered", () => email.for(p.id).length === 2);
        await settle(1_000);
        expect(email.for(p.id)).toHaveLength(2);
      });

      it("lets critical sends through the per-user cap", async () => {
        const p = await project();
        await app.admin("PATCH", `/v1/projects/${p.id}`, { throttleLimit: 1 });
        await addUser(p.api, { id: "u", email: "u@x.com" });
        for (let i = 0; i < 3; i++)
          await notify(p.api, { user: "u", template: "receipt", priority: "critical" });
        await waitFor("three delivered", () => email.for(p.id).length === 3);
      });

      it("defers sends over a provider's rate limit instead of dropping them", async () => {
        const p = await project();
        await p.api("PUT", "/v1/templates", {
          templates: [{ id: "wa", channel: "whatsapp", content: { text: "hi" } }],
        });
        await addUser(p.api, {
          id: "u",
          contacts: [{ channel: "whatsapp", target: "+15550000777" }],
        });

        for (let i = 0; i < 3; i++)
          await notify(p.api, { user: "u", template: "wa", channels: ["whatsapp"] });

        await waitFor(
          "all three eventually delivered",
          () => whatsapp.for(p.id).length === 3,
          60_000,
        );
      }, 90_000);
    });

    describe("fallback", () => {
      it("moves to the next channel when the first fails", async () => {
        const p = await project();
        await addUser(p.api, { id: "u", email: "bounce@x.com", phone: "+15550000555" });
        await notify(p.api, {
          user: "u",
          template: "receipt",
          channels: ["email", "sms"],
          fallback: true,
        });
        await waitFor("sms fallback delivered", () => sms.for(p.id).length === 1);
        expect(email.for(p.id)).toEqual([]);
      });

      it("counts a notification once against the user's cap, however many channels it falls back through", async () => {
        const p = await project();
        await app.admin("PATCH", `/v1/projects/${p.id}`, { throttleLimit: 1 });
        await addUser(p.api, { id: "u", email: "bounce-cap@x.com", phone: "+15550000555" });

        await notify(p.api, {
          user: "u",
          template: "receipt",
          channels: ["email", "sms"],
          fallback: true,
        });
        await waitFor("sms fallback delivered", () => sms.for(p.id).length === 1);

        // The cap itself still holds: a second notification is over it.
        await notify(p.api, { user: "u", template: "receipt", channels: ["sms"] });
        await settle(1_500);
        expect(sms.for(p.id)).toHaveLength(1);
      });

      it("moves to the next channel when the user has no address on the first", async () => {
        const p = await project();
        await addUser(p.api, { id: "u", phone: "+15550000555" });
        await notify(p.api, {
          user: "u",
          template: "receipt",
          channels: ["email", "sms"],
          fallback: true,
        });
        await waitFor("sms delivered", () => sms.for(p.id).length === 1, 10_000);
      });

      it("does not use the fallback when the first channel works", async () => {
        const p = await project();
        await addUser(p.api, { id: "u", email: "ok@x.com", phone: "+15550000555" });
        await notify(p.api, {
          user: "u",
          template: "receipt",
          channels: ["email", "sms"],
          fallback: true,
        });
        await waitFor("email delivered", () => email.for(p.id).length === 1);
        await settle(500);
        expect(sms.for(p.id)).toEqual([]);
      });
    });

    describe("failures", () => {
      it("records a failed send and dead-letters it where the project can see and replay it", async () => {
        const p = await project();
        await addUser(p.api, { id: "u", email: "bounce-dlq@x.com" });
        await notify(p.api, { user: "u", template: "receipt" });

        await waitFor("failure logged", async () => {
          const rows =
            await infra.sql`SELECT status FROM message_logs WHERE project_id = ${p.id} AND status = 'failed'`;
          return rows.length === 1;
        });

        let dlq: any;
        await waitFor("visible in the project's DLQ", async () => {
          dlq = await p.api("GET", "/v1/dlq");
          return dlq.body.messages?.length === 1;
        });
        const entry = dlq.body.messages[0];
        expect(entry.eventType).toBe("notification.dispatched");
        expect(entry.payload.projectId).toBe(p.id);

        // The provider recovers; replaying the entry now delivers it.
        email.behaviour = (task) => ({ success: true, providerMessageId: `pm-${task.taskId}` });
        try {
          const replay = await p.api("POST", "/v1/dlq/replay", { id: entry.id });
          expect(replay.status).toBe(200);
          await waitFor("replayed and delivered", () => email.for(p.id).length === 1);
          expect((await p.api("GET", "/v1/dlq")).body.messages).toEqual([]);
        } finally {
          email.behaviour = (task) =>
            task.destination?.startsWith("bounce")
              ? { success: false, error: "mailbox unavailable", retryable: false }
              : { success: true, providerMessageId: `pm-${task.taskId}` };
        }
      });

      it("deactivates a push token the provider says is dead", async () => {
        const p = await project();
        await addUser(p.api, { id: "u", pushToken: ["dead-token", "live-token"] });
        await notify(p.api, { user: "u", template: "receipt", channels: ["push"] });

        await waitFor("live token delivered", () => push.for(p.id).length === 1);
        expect(push.for(p.id)[0]!.destination).toBe("live-token");
        await waitFor("dead token deactivated", async () => {
          const contacts = await p.api("GET", "/v1/users/u/contacts");
          return (
            contacts.body.contacts.find((c: any) => c.target === "dead-token")?.active === false
          );
        });
      });
    });

    describe("scheduling", () => {
      it("holds a scheduled send until its time, then sends it once", async () => {
        const p = await project();
        await addUser(p.api, { id: "u", email: "u@x.com" });
        const sendAt = new Date(Date.now() + 3_000);
        await notify(p.api, { user: "u", template: "receipt", sendAt: sendAt.toISOString() });

        await waitFor(
          "parked",
          async () =>
            (await p.api("GET", "/v1/notifications/scheduled")).body.scheduled?.length === 1,
        );
        expect(email.for(p.id)).toEqual([]);

        await waitFor("sent", () => email.for(p.id).length === 1, 20_000);
        expect(Date.now()).toBeGreaterThanOrEqual(sendAt.getTime());
        await waitFor(
          "unparked",
          async () =>
            (await p.api("GET", "/v1/notifications/scheduled")).body.scheduled?.length === 0,
        );
        await settle(500);
        expect(email.for(p.id)).toHaveLength(1);
      }, 30_000);

      it("does not send a scheduled notification that was canceled", async () => {
        const p = await project();
        await addUser(p.api, { id: "u", email: "u@x.com" });
        await notify(p.api, {
          user: "u",
          template: "receipt",
          sendAt: new Date(Date.now() + 3_000).toISOString(),
        });

        let scheduled: any[] = [];
        await waitFor("parked", async () => {
          scheduled = (await p.api("GET", "/v1/notifications/scheduled")).body.scheduled ?? [];
          return scheduled.length === 1;
        });
        const cancel = await p.api(
          "DELETE",
          `/v1/notifications/${encodeURIComponent(scheduled[0].taskId)}`,
        );
        expect(cancel.status).toBe(200);

        await settle(8_000);
        expect(email.for(p.id)).toEqual([]);
      }, 30_000);

      describe("quiet hours", () => {
        const hhmm = (d: Date) => d.toISOString().slice(11, 16);
        const minutes = (n: number) => new Date(Date.now() + n * 60_000);

        async function parkedSendTime(p: { api: Api }): Promise<number> {
          let scheduled: any[] = [];
          await waitFor("parked", async () => {
            scheduled = (await p.api("GET", "/v1/notifications/scheduled")).body.scheduled ?? [];
            return scheduled.length === 1;
          });
          return Date.parse(scheduled[0].payload.scheduledAt);
        }

        it("defers a send during the user's quiet hours until they end", async () => {
          const p = await project();
          const end = minutes(60);
          await addUser(p.api, {
            id: "u",
            email: "u@x.com",
            timezone: "UTC",
            preferences: { quietHours: [{ start: hhmm(minutes(-60)), end: hhmm(end) }] },
          });
          await notify(p.api, { user: "u", template: "receipt" });

          const at = await parkedSendTime(p);
          expect(Math.abs(at - end.getTime())).toBeLessThan(61_000);
          expect(email.for(p.id)).toEqual([]);
        });

        it("sends critical notifications during quiet hours", async () => {
          const p = await project();
          await addUser(p.api, {
            id: "u",
            email: "u@x.com",
            timezone: "UTC",
            preferences: { quietHours: [{ start: hhmm(minutes(-60)), end: hhmm(minutes(60)) }] },
          });
          await notify(p.api, { user: "u", template: "receipt", priority: "critical" });
          await waitFor("delivered", () => email.for(p.id).length === 1);
        });

        it("keeps a send scheduled for next week on next week, even if it is quiet hours now", async () => {
          const p = await project();
          const nextWeek = new Date(Date.now() + 7 * 24 * 3600_000 + 3 * 3600_000);
          await addUser(p.api, {
            id: "u",
            email: "u@x.com",
            timezone: "UTC",
            preferences: { quietHours: [{ start: hhmm(minutes(-60)), end: hhmm(minutes(60)) }] },
          });
          await notify(p.api, { user: "u", template: "receipt", sendAt: nextWeek.toISOString() });

          expect(await parkedSendTime(p)).toBe(nextWeek.getTime());
        });

        it("defers a scheduled send that would land inside quiet hours", async () => {
          const p = await project();
          const quietStart = minutes(30);
          const quietEnd = minutes(120);
          await addUser(p.api, {
            id: "u",
            email: "u@x.com",
            timezone: "UTC",
            preferences: { quietHours: [{ start: hhmm(quietStart), end: hhmm(quietEnd) }] },
          });
          await notify(p.api, {
            user: "u",
            template: "receipt",
            sendAt: minutes(60).toISOString(),
          });

          const at = await parkedSendTime(p);
          expect(Math.abs(at - quietEnd.getTime())).toBeLessThan(61_000);
        });
      });
    });

    describe("reporting", () => {
      it("attributes every message to its campaign", async () => {
        const p = await project();
        for (const id of ["c1", "c2"])
          await addUser(p.api, { id, email: `${id}@x.com`, segments: ["camp"] });
        await notify(p.api, { segment: "camp", template: "receipt", campaign: "spring-sale" });
        await waitFor("two delivered", () => email.for(p.id).length === 2);

        let stats: any;
        await waitFor("stats", async () => {
          stats = await p.api("GET", "/v1/campaigns/spring-sale/stats");
          return stats.status === 200 && stats.body.totals.delivered === 2;
        });
        expect(stats.body.totals).toMatchObject({
          sent: 2,
          delivered: 2,
          failed: 0,
          deliveryRate: 100,
        });

        const list = await p.api("GET", "/v1/campaigns");
        expect(list.body.campaigns).toEqual([
          expect.objectContaining({ campaign: "spring-sale", messages: 2 }),
        ]);
      });

      it("pages through the delivery log without skipping or repeating a message", async () => {
        const p = await project();
        for (let i = 0; i < 12; i++)
          await addUser(p.api, { id: `l${i}`, email: `l${i}@x.com`, segments: ["logs"] });
        // SEGMENT_MAX_USERS is 5 in this file; send in batches of users instead.
        for (let i = 0; i < 12; i++) await notify(p.api, { user: `l${i}`, template: "receipt" });
        await waitFor("12 delivered", () => email.for(p.id).length === 12);
        await waitFor("12 logged", async () => {
          const { n } = (
            await infra.sql`SELECT count(*)::int AS n FROM message_logs WHERE project_id = ${p.id} AND status = 'delivered'`
          )[0]!;
          return n === 12;
        });

        const seen: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 20; page++) {
          const res: any = await p.api(
            "GET",
            `/v1/notifications/logs?limit=5${cursor ? `&cursor=${cursor}` : ""}`,
          );
          seen.push(...res.body.logs.map((l: any) => l.taskId));
          cursor = res.body.nextCursor;
          if (!cursor) break;
        }
        expect(new Set(seen).size).toBe(12);
        expect(seen).toHaveLength(12);
      });

      it("emits delivery events on the server", async () => {
        const p = await project();
        await addUser(p.api, { id: "u", email: "u@x.com" });
        const delivered: unknown[][] = [];
        const on = (...args: unknown[]) => delivered.push(args);
        app.server.on("delivery:delivered", on);
        try {
          await notify(p.api, { user: "u", template: "receipt" });
          await waitFor("event", () => delivered.some((a) => a[3] === p.id));
          const [taskId, providerMessageId, channel] = delivered.find((a) => a[3] === p.id)!;
          expect(channel).toBe("email");
          expect(providerMessageId).toBe(`pm-${taskId}`);
        } finally {
          app.server.off("delivery:delivered", on);
        }
      });
    });
  });

  return { infra, app: () => app, globalEmitter };
}
