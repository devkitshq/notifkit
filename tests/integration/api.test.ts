import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { NotifkitClient } from "@/client.js";
import { signUnsubscribeToken } from "@/unsubscribe/index.js";
import { hashPassword } from "@/services/auth/index.js";
import { AdminUserRepository } from "@/repositories/index.js";
import { STREAMS } from "@/contracts/index.js";
import type { Transport, WebhookEvent } from "@/transport/index.js";
import { useInfra, waitFor, settle } from "./support/infra.js";
import {
  ADMIN_KEY,
  RecordingTransport,
  apiClient,
  startNotifkit,
  type Running,
} from "./support/pipeline.js";

/**
 * The HTTP API as a caller sees it: status codes, bodies, auth, tenancy, and
 * the side effects a request is supposed to have. Driven through the published
 * SDK client where it has a method, and raw HTTP where the point is the wire.
 */

const infra = useInfra();
let app: Running;
const SECRET = "api-test-unsubscribe-secret";

// A provider with a webhook, as Resend or Twilio would mount one.
class WebhookTransport extends RecordingTransport implements Transport {
  readonly webhookPath = "/webhooks/test";
  constructor() {
    super("email");
  }
  verifyWebhookChallenge(query: URLSearchParams) {
    return query.get("hub.verify_token") === "ok" ? (query.get("hub.challenge") ?? "") : undefined;
  }
  verifyWebhook(_raw: string, headers: Record<string, string | string[] | undefined>) {
    return headers["x-signature"] === "valid";
  }
  async parseWebhook(body: any): Promise<WebhookEvent[]> {
    return body.events;
  }
}
const email = new WebhookTransport();

beforeAll(async () => {
  app = await startNotifkit(infra, {
    services: ["api", "enricher", "engine", "delivery", "scheduler", "events"],
    providers: [email],
    env: {
      RATE_LIMIT_PER_HOUR: "100000",
      UNSUBSCRIBE_SECRET: SECRET,
      CORS_ORIGIN: "https://dash.example.com",
    },
  });
}, 120_000);

afterAll(async () => {
  await app?.stop();
}, 60_000);

/** Per-address counters for the public login and unsubscribe routes. */
async function clearRateLimits() {
  const keys = [
    ...(await infra.redis.keys("rate-limit:api:unsub:*")),
    ...(await infra.redis.keys("rate-limit:api:auth:*")),
  ];
  if (keys.length > 0) await infra.redis.del(...keys);
}

function sdk(apiKey: string, headers: Record<string, string> = {}) {
  return new NotifkitClient({ baseUrl: app.baseUrl, apiKey, headers });
}

async function project() {
  const p = await app.project();
  return { ...p, client: sdk(p.apiKey) };
}

// ─── Authentication & tenancy ───────────────────────────────────────────────

describe("authentication", () => {
  it("rejects requests without a key, with an unknown key, or with a wrong admin key", async () => {
    const anon = apiClient(app.baseUrl);
    expect((await anon("GET", "/v1/users")).status).toBe(401);
    expect((await apiClient(app.baseUrl, "nk_live_nope")("GET", "/v1/users")).status).toBe(401);
    expect((await apiClient(app.baseUrl, "wrong-admin")("GET", "/v1/projects")).status).toBe(401);
    expect((await anon("GET", "/v1/projects")).status).toBe(401);
  });

  it("accepts the key as a bearer token or an x-api-key header", async () => {
    const p = await project();
    expect((await apiClient(app.baseUrl, p.apiKey)("GET", "/v1/segments")).status).toBe(200);
    const viaHeader = apiClient(app.baseUrl, undefined, { "x-api-key": p.apiKey });
    expect((await viaHeader("GET", "/v1/segments")).status).toBe(200);
  });

  it("lets the admin key act on a project named in x-project-id, and requires one", async () => {
    const p = await project();
    await p.client.addUser({ id: "u", email: "u@x.com" });
    expect((await app.admin("GET", "/v1/users")).status).toBe(400);
    const asAdmin = sdk(ADMIN_KEY, { "x-project-id": p.id });
    expect((await asAdmin.getUser("u")).userId).toBe("u");
  });

  it("keeps each project's data invisible to other projects", async () => {
    const a = await project();
    const b = await project();
    await a.client.addUser({ id: "secret", email: "s@x.com" });
    await expect(b.client.getUser("secret")).rejects.toThrow(/user_not_found/);
    expect((await b.client.listUsers()).users).toEqual([]);
  });

  it("forbids writes with a read-only key but allows reads", async () => {
    const p = await project();
    const key = await app.admin("POST", `/v1/projects/${p.id}/keys`, { role: "read_only" });
    expect(key.status).toBe(201);
    const ro = apiClient(app.baseUrl, key.body.apiKey);
    expect((await ro("GET", "/v1/users")).status).toBe(200);
    expect((await ro("POST", "/v1/users", { id: "x" })).status).toBe(403);
  });

  it("stops accepting a key as soon as it is deleted", async () => {
    const p = await project();
    const key = await app.admin("POST", `/v1/projects/${p.id}/keys`, {});
    const client = apiClient(app.baseUrl, key.body.apiKey);
    expect((await client("GET", "/v1/segments")).status).toBe(200); // now cached

    const del = await app.admin("DELETE", `/v1/projects/${p.id}/keys/${key.body.id}`);
    expect(del.status).toBe(204);
    await waitFor(
      "revoked",
      async () => (await client("GET", "/v1/segments")).status === 401,
      5_000,
    );
  });

  it("enforces a project's request rate limit", async () => {
    const p = await project();
    await app.admin("PATCH", `/v1/projects/${p.id}`, { rateLimitRpm: 3 });
    await settle(200); // the auth cache drops the old limit over pub/sub
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await p.api("GET", "/v1/segments")).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    const limited = await p.api("GET", "/v1/segments");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  describe("admin sessions", () => {
    it("logs in, reads the session, reaches admin routes, and logs out", async () => {
      await clearRateLimits();
      await new AdminUserRepository(infra.db).create({
        email: "ops@example.com",
        username: "ops",
        passwordHash: await hashPassword("correct horse"),
      });
      const anon = apiClient(app.baseUrl, undefined, { "x-forwarded-for": randomUUID() });

      expect(
        (await anon("POST", "/v1/auth/login", { identifier: "ops", password: "wrong" })).status,
      ).toBe(401);
      expect(
        (await anon("POST", "/v1/auth/login", { identifier: "nobody", password: "x" })).status,
      ).toBe(401);
      expect((await anon("POST", "/v1/auth/login", {})).status).toBe(400);

      const login = await anon("POST", "/v1/auth/login", {
        identifier: "OPS@example.com",
        password: "correct horse",
      });
      expect(login.status).toBe(200);
      expect(login.body.user).toMatchObject({ email: "ops@example.com", username: "ops" });
      const session = apiClient(app.baseUrl, login.body.token);

      expect((await session("GET", "/v1/auth/me")).body.user.email).toBe("ops@example.com");
      expect((await session("GET", "/v1/projects")).status).toBe(200);
      expect((await session("GET", "/v1/system/health")).status).toBe(200);

      expect((await session("POST", "/v1/auth/logout")).status).toBe(200);
      expect((await session("GET", "/v1/auth/me")).status).toBe(401);
      expect((await session("GET", "/v1/projects")).status).toBe(401);
      expect((await anon("GET", "/v1/auth/me")).status).toBe(401);
    });

    /** Signs in as a new dashboard user with `role`, returning a client for the session. */
    async function sessionWithRole(role: string) {
      await clearRateLimits();
      const name = `${role}-${randomUUID().slice(0, 8)}`;
      await new AdminUserRepository(infra.db).create({
        email: `${name}@example.com`,
        username: name,
        passwordHash: await hashPassword("correct horse"),
        role,
      });
      const login = await apiClient(app.baseUrl)("POST", "/v1/auth/login", {
        identifier: name,
        password: "correct horse",
      });
      expect(login.status).toBe(200);
      return (headers: Record<string, string> = {}) =>
        apiClient(app.baseUrl, login.body.token, headers);
    }

    it.each(["read_only", "viewer"])(
      "lets a %s session read but not write project data",
      async (role) => {
        const p = await project();
        const session = (await sessionWithRole(role))({ "x-project-id": p.id });
        expect((await session("GET", "/v1/users")).status).toBe(200);
        expect((await session("POST", "/v1/users", { id: "x" })).status).toBe(403);
      },
    );

    it.each(["read_only", "viewer"])(
      "keeps a %s session from managing projects and keys",
      async (role) => {
        const p = await project();
        const session = (await sessionWithRole(role))();
        expect((await session("GET", "/v1/projects")).status).toBe(200);
        expect((await session("POST", "/v1/projects", { name: "mine" })).status).toBe(403);
        expect((await session("POST", `/v1/projects/${p.id}/keys`, {})).status).toBe(403);
        expect((await session("PATCH", `/v1/projects/${p.id}`, { rateLimitRpm: 1 })).status).toBe(
          403,
        );
        expect((await session("DELETE", `/v1/projects/${p.id}`)).status).toBe(403);
        expect((await app.admin("GET", `/v1/projects/${p.id}/keys`)).body.keys).toHaveLength(1);
      },
    );

    it("lets an admin session manage projects", async () => {
      const session = (await sessionWithRole("admin"))();
      expect((await session("POST", "/v1/projects", { name: "theirs" })).status).toBe(201);
    });

    it("throttles repeated login attempts from one address", async () => {
      await clearRateLimits();
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        statuses.push(
          (
            await apiClient(app.baseUrl)("POST", "/v1/auth/login", {
              identifier: "x",
              password: "y",
            })
          ).status,
        );
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
    });
  });
});

// ─── Projects & keys ────────────────────────────────────────────────────────

describe("projects", () => {
  it("creates, lists, updates and deletes projects", async () => {
    const created = await app.admin("POST", "/v1/projects", { name: "Acme" });
    expect(created.status).toBe(201);
    expect(created.body.apiKey).toMatch(/^nk_live_[0-9a-f]{64}$/);
    const [row] =
      await infra.sql`SELECT key_hash FROM project_api_keys WHERE project_id = ${created.body.id}`;
    expect(row!.key_hash).toBe(createHash("sha256").update(created.body.apiKey).digest("hex"));

    expect((await app.admin("POST", "/v1/projects", {})).status).toBe(400);
    const list = await sdk(ADMIN_KEY).listProjects();
    expect(list.projects.map((p) => p.id)).toContain(created.body.id);

    expect(
      (await app.admin("PATCH", `/v1/projects/${created.body.id}`, { throttleLimit: "x" })).status,
    ).toBe(400);
    await sdk(ADMIN_KEY).updateProject(created.body.id, { throttleLimit: 7 });
    const [settings] =
      await infra.sql`SELECT throttle_limit FROM projects WHERE id = ${created.body.id}`;
    expect(settings!.throttle_limit).toBe(7);

    await sdk(ADMIN_KEY).deleteProject(created.body.id);
    expect((await apiClient(app.baseUrl, created.body.apiKey)("GET", "/v1/users")).status).toBe(
      401,
    );
  });

  it("answers 404, not 500, for projects that do not exist or ids that are not ids", async () => {
    const missing = randomUUID();
    expect((await app.admin("PATCH", `/v1/projects/${missing}`, { throttleLimit: 1 })).status).toBe(
      404,
    );
    expect((await app.admin("DELETE", `/v1/projects/${missing}`)).status).toBe(404);
    expect((await app.admin("POST", `/v1/projects/${missing}/keys`, {})).status).toBe(404);
    expect((await app.admin("DELETE", `/v1/projects/${missing}/keys/${randomUUID()}`)).status).toBe(
      404,
    );
    expect((await app.admin("DELETE", "/v1/projects/not-a-uuid")).status).toBe(404);
    expect((await app.admin("GET", "/v1/projects/not-a-uuid/keys")).status).toBe(404);
  });

  it("lists a project's keys without revealing them", async () => {
    const p = await project();
    const client = sdk(ADMIN_KEY);
    const created = await client.createProjectKey(p.id, { role: "read_only" });
    const { keys } = await client.listProjectKeys(p.id);
    expect(keys).toHaveLength(2);
    expect(keys.find((k) => k.id === created.id)!.role).toBe("read_only");
    expect(JSON.stringify(keys)).not.toContain(p.apiKey.slice(8));
    await client.deleteProjectKey(p.id, created.id);
    expect((await client.listProjectKeys(p.id)).keys).toHaveLength(1);
  });
});

// ─── Templates ──────────────────────────────────────────────────────────────

describe("templates", () => {
  it("syncs, lists with filters, reads and deletes templates", async () => {
    const p = await project();
    expect(
      await p.client.syncTemplates([
        { id: "a", channel: "email", topic: "news", content: { subject: "A" } },
        { id: "b", channel: "sms", content: { text: "B" } },
      ]),
    ).toEqual({ synced: 2 });
    expect((await p.api("PUT", "/v1/templates", { templates: [] })).status).toBe(400);

    expect((await p.client.listTemplates()).templates.map((t) => t.id).sort()).toEqual(["a", "b"]);
    expect(
      (await p.api("GET", "/v1/templates?channel=sms")).body.templates.map((t: any) => t.id),
    ).toEqual(["b"]);
    expect(
      (await p.api("GET", "/v1/templates?topic=news")).body.templates.map((t: any) => t.id),
    ).toEqual(["a"]);
    expect((await p.api("GET", "/v1/templates?limit=1")).body.templates).toHaveLength(1);
    expect(await p.client.getTemplate("a")).toMatchObject({
      id: "a",
      topics: ["news"],
      content: { subject: "A" },
    });

    await p.client.deleteTemplate("a");
    await expect(p.client.getTemplate("a")).rejects.toThrow(/template_not_found/);
    await expect(p.client.deleteTemplate("a")).rejects.toThrow(/template_not_found/);
  });

  it("uses an edited template for the very next send", async () => {
    const p = await project();
    await p.client.addUser({ id: "u", email: "u@x.com" });
    await p.client.syncTemplates([{ id: "t", channel: "email", content: { subject: "v1" } }]);
    await p.client.notify({ user: "u", template: "t" });
    await waitFor("v1 sent", () => email.for(p.id).length === 1);

    await p.client.syncTemplates([{ id: "t", channel: "email", content: { subject: "v2" } }]);
    await settle(200);
    await p.client.notify({ user: "u", template: "t" });
    await waitFor("v2 sent", () => email.for(p.id).length === 2);
    expect(email.for(p.id)[1]!.renderedContent.content).toEqual({ subject: "v2" });
  });
});

// ─── Users, contacts, preferences ───────────────────────────────────────────

describe("users", () => {
  it("creates a user with contacts through every input style, and reads it back", async () => {
    const p = await project();
    await p.client.addUser("u1", [{ channel: "sms", target: "+1" }], {
      language: "fr",
      email: "u1@x.com",
    });
    await p.client.identify({
      id: "u2",
      phone: ["+2", "+3"],
      pushToken: "tok",
      segments: ["beta"],
    });

    const u1 = await p.client.getUser("u1");
    expect(u1).toMatchObject({ userId: "u1", language: "fr", email: "u1@x.com" });
    expect(u1.contacts!.map((c) => `${c.channel}:${c.target}`).sort()).toEqual([
      "email:u1@x.com",
      "sms:+1",
    ]);

    const u2 = await p.client.getUserContacts("u2");
    expect(u2.contacts.map((c) => c.target).sort()).toEqual(["+2", "+3", "tok"]);
    expect((await p.client.getUser("u2")).segments).toEqual(["beta"]);
    expect((await p.api("POST", "/v1/users", { email: "no-id@x.com" })).status).toBe(400);
  });

  it("updates a user, adding contacts and keeping the old ones", async () => {
    const p = await project();
    await p.client.addUser({ id: "u", email: "old@x.com", timezone: "UTC" });
    await p.client.updateUser("u", {
      timezone: "Asia/Tokyo",
      contacts: [{ channel: "sms", target: "+9", preferences: { topics: { promo: false } } }],
    });

    const u = await p.client.getUser("u");
    expect(u.timezone).toBe("Asia/Tokyo");
    expect(u.email).toBe("old@x.com");
    expect(u.contacts!.map((c) => c.target).sort()).toEqual(["+9", "old@x.com"]);
    expect(u.contacts!.find((c) => c.target === "+9")!.preferences).toEqual({
      topics: { promo: false },
    });
    await expect(p.client.updateUser("ghost", { language: "x" })).rejects.toThrow(/user_not_found/);
  });

  it("adds and removes contacts individually and in batches", async () => {
    const p = await project();
    await p.client.addUser({ id: "u" });
    await p.client.addContact("u", { channel: "email", target: "a@x.com" });
    await p.client.addContacts("u", [
      { channel: "sms", target: "+1" },
      { channel: "webhook", target: "https://hooks.example.com/a b" },
    ]);
    expect((await p.client.getUserContacts("u")).contacts).toHaveLength(3);

    await p.client.deleteContact("u", "webhook", "https://hooks.example.com/a b");
    await p.client.deleteContact("u", "sms", "+1");
    expect((await p.client.getUserContacts("u")).contacts.map((c) => c.target)).toEqual([
      "a@x.com",
    ]);

    await expect(p.client.deleteContact("u", "sms", "+1")).rejects.toThrow(/contact_not_found/);
    expect((await p.api("DELETE", "/v1/users/u/contacts/pigeon/x")).status).toBe(400);
    expect(
      (await p.api("POST", "/v1/users/ghost/contacts", { channel: "sms", target: "+1" })).status,
    ).toBe(404);
    expect((await p.api("POST", "/v1/users/u/contacts", { channel: "sms" })).status).toBe(400);
  });

  it("reads and updates preferences", async () => {
    const p = await project();
    await p.client.addUser({ id: "u", preferences: { topics: { news: true } } });
    await p.client.updateUserPreferences("u", {
      channels: { sms: false },
      quietHours: [{ start: "22:00", end: "07:00" }],
    });
    expect(await p.client.getUserPreferences("u")).toEqual({
      topics: { news: true },
      channels: { sms: false },
      quietHours: [{ start: "22:00", end: "07:00" }],
    });
    expect(
      (
        await p.api("PATCH", "/v1/users/u/preferences", {
          quietHours: [{ start: "25:00", end: "x" }],
        })
      ).status,
    ).toBe(400);
    expect((await p.api("GET", "/v1/users/ghost/preferences")).status).toBe(404);
    expect((await p.api("PATCH", "/v1/users/ghost/preferences", {})).status).toBe(404);
  });

  it("deletes a user", async () => {
    const p = await project();
    await p.client.addUser({ id: "u", email: "u@x.com" });
    await p.client.deleteUser("u");
    await expect(p.client.getUser("u")).rejects.toThrow(/user_not_found/);
    await expect(p.client.deleteUser("u")).rejects.toThrow(/user_not_found/);
  });

  it("lists and filters users, paging with the cursor", async () => {
    const p = await project();
    for (let i = 0; i < 7; i++) {
      await p.client.addUser({
        id: `user-${i}`,
        email: `user${i}@x.com`,
        language: i % 2 ? "de" : "en",
        segments: i < 2 ? ["vip"] : [],
      });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await p.client.listUsers({ limit: 3, cursor });
      seen.push(...page.users.map((u) => u.userId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen.sort()).toEqual(Array.from({ length: 7 }, (_, i) => `user-${i}`));
    expect((await p.client.listUsers({ language: "de" })).users).toHaveLength(3);
    expect((await p.client.listUsers({ segment: "vip" })).users).toHaveLength(2);
    expect((await p.client.listUsers({ search: "user6" })).users.map((u) => u.userId)).toEqual([
      "user-6",
    ]);
    expect((await p.client.listSegments()).segments).toEqual(["vip"]);
  });

  it("shows a user's recent messages in their details", async () => {
    const p = await project();
    await p.client.syncTemplates([{ id: "t", channel: "email", content: { subject: "s" } }]);
    await p.client.addUser({ id: "u", email: "detail@x.com" });
    await p.client.notify({ user: "u", template: "t" });
    let details: any;
    await waitFor("logged", async () => {
      details = await p.client.getUserDetails("u");
      return details.logs.some((l: any) => l.status === "delivered");
    });
    expect(details.contacts.map((c: any) => c.target)).toEqual(["detail@x.com"]);
  });

  it("shows a user's details however many messages they have been sent", async () => {
    const p = await project();
    await p.client.addUser({ id: "busy", email: "busy@x.com" });
    // More sends than Postgres takes bind parameters (65,535), which is what
    // listing every task id the address was ever sent and passing them back in
    // ran into.
    await infra.sql`
      INSERT INTO delivery_outbox (task_id, channel, destination)
      SELECT 'busy-' || n, 'email', 'busy@x.com' FROM generate_series(1, 70000) n`;
    await infra.sql`
      INSERT INTO message_logs (project_id, task_id, channel, attempt, status)
      VALUES (${p.id}, 'busy-70000', 'email', 1, 'delivered')`;

    const details = await p.client.getUserDetails("busy");
    expect(details.logs.map((l: any) => l.taskId)).toEqual(["busy-70000"]);
  });

  it("finds an address's sends by index rather than by reading the whole outbox", async () => {
    const indexes = await infra.sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'delivery_outbox'`;
    expect(indexes.some((i) => /\(destination\)/.test(i.indexdef))).toBe(true);
  });
});

// ─── Notify ─────────────────────────────────────────────────────────────────

describe("notify", () => {
  it("validates the request", async () => {
    const p = await project();
    expect((await p.api("POST", "/v1/notify", { template: "t" })).status).toBe(400);
    expect(
      (await p.api("POST", "/v1/notify", { user: "u", segment: "s", template: "t" })).status,
    ).toBe(400);
    expect((await p.api("POST", "/v1/notify", { user: "u" })).status).toBe(400);
    expect(
      (await p.api("POST", "/v1/notify", "{not json", { "content-type": "application/json" }))
        .status,
    ).toBe(400);
  });

  it("fans a list of users out into one request each", async () => {
    const p = await project();
    await p.client.syncTemplates([{ id: "t", channel: "email", content: { subject: "s" } }]);
    for (const id of ["a", "b", "c"]) await p.client.addUser({ id, email: `${id}@x.com` });
    const res = await p.api("POST", "/v1/notify", {
      user: ["a", "b", "c"],
      template: "t",
      campaign: "trio",
    });
    expect(res.status).toBe(202);
    expect(res.body.messageIds).toHaveLength(3);
    expect(res.body.campaign).toBe("trio");
    await waitFor("3 sent", () => email.for(p.id).length === 3);
  });

  it("refuses a payload larger than 5MB", async () => {
    const p = await project();
    const res = await p
      .api("POST", "/v1/notify", {
        user: "u",
        template: "t",
        data: { blob: "x".repeat(6 * 1024 * 1024) },
      })
      .catch((err) => ({ status: 413, err }));
    expect(res.status).toBe(413);
  });
});

// ─── Scheduled notifications ────────────────────────────────────────────────

describe("scheduled notifications", () => {
  it("lists them page by page and cancels one, only within its own project", async () => {
    const p = await project();
    const other = await project();
    await p.client.syncTemplates([{ id: "t", channel: "email", content: { subject: "s" } }]);
    for (const id of ["a", "b", "c"]) await p.client.addUser({ id, email: `${id}@x.com` });
    const sendAt = new Date(Date.now() + 3600_000).toISOString();
    await p.api("POST", "/v1/notify", { user: ["a", "b", "c"], template: "t", sendAt });

    await waitFor(
      "3 parked",
      async () => (await p.client.getScheduledMessages()).scheduled.length === 3,
    );
    const first = await p.api("GET", "/v1/notifications/scheduled?limit=2");
    const second = await p.api(
      "GET",
      `/v1/notifications/scheduled?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(first.body.scheduled).toHaveLength(2);
    expect(second.body.scheduled).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    expect((await p.api("GET", "/v1/notifications/scheduled?channel=sms")).body.scheduled).toEqual(
      [],
    );
    expect((await other.client.getScheduledMessages()).scheduled).toEqual([]);

    const taskId = first.body.scheduled[0].taskId;
    await expect(other.client.cancelNotification(taskId)).rejects.toThrow();
    expect(await p.client.cancelNotification(taskId)).toEqual({ success: true });
    await expect(p.client.cancelNotification(taskId)).rejects.toThrow();
    expect((await p.client.getScheduledMessages()).scheduled).toHaveLength(2);
  });

  it("reports an unknown notification as not found", async () => {
    const p = await project();
    await expect(p.client.getNotificationStatus("nope")).rejects.toThrow(/not found/i);
  });
});

// ─── Suppressions ───────────────────────────────────────────────────────────

describe("suppressions", () => {
  it("creates (normalised), lists with filters, and deletes suppressions", async () => {
    const p = await project();
    expect(
      await p.client.createSuppression({
        channel: "email",
        target: " Mixed@Case.COM ",
        reason: "bounced",
      }),
    ).toEqual({
      channel: "email",
      target: "mixed@case.com",
      reason: "bounced",
    });
    await p.client.createSuppression({ channel: "sms", target: "+15550001" });
    await p.client.createSuppression({ channel: "sms", target: "+15550001" }); // idempotent
    expect((await p.api("POST", "/v1/suppressions", { channel: "fax", target: "x" })).status).toBe(
      400,
    );

    expect((await p.client.listSuppressions()).suppressions).toHaveLength(2);
    expect(
      (await p.client.listSuppressions({ channel: "sms" })).suppressions.map((s) => s.target),
    ).toEqual(["+15550001"]);
    expect((await p.client.listSuppressions({ reason: "bounced" })).suppressions).toHaveLength(1);
    expect((await p.client.listSuppressions({ target: "MIXED" })).suppressions).toHaveLength(1);

    await p.client.deleteSuppression("email", "MIXED@case.com");
    expect((await p.client.listSuppressions()).suppressions.map((s) => s.channel)).toEqual(["sms"]);
  });
});

// ─── Unsubscribe links ──────────────────────────────────────────────────────

describe("unsubscribe", () => {
  beforeEach(clearRateLimits);
  function token(
    claim: Partial<Parameters<typeof signUnsubscribeToken>[0]> & { projectId: string },
    secret = SECRET,
  ) {
    return signUnsubscribeToken(
      { userId: "u", channel: "email", target: "u@x.com", topics: ["news"], ...claim },
      secret,
    );
  }
  const anon = () => apiClient(app.baseUrl, undefined, { "x-forwarded-for": randomUUID() });

  it("shows a confirmation page on GET without unsubscribing anyone", async () => {
    const p = await project();
    await p.client.addUser({ id: "u", email: "u@x.com" });
    const page = await anon()(
      "GET",
      `/v1/unsubscribe?token=${encodeURIComponent(token({ projectId: p.id }))}`,
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(page.body).toContain('<form method="post"');
    expect(await p.client.getUserPreferences("u")).toEqual({ topics: {}, channels: {} });
  });

  it("rejects a forged or tampered token on both GET and POST", async () => {
    const p = await project();
    const forged = token({ projectId: p.id }, "some-other-secret");
    expect(
      (await anon()("GET", `/v1/unsubscribe?token=${encodeURIComponent(forged)}`)).status,
    ).toBe(400);
    expect(
      (await anon()("POST", `/v1/unsubscribe?token=${encodeURIComponent(forged)}`)).status,
    ).toBe(400);
    expect((await anon()("POST", "/v1/unsubscribe")).status).toBe(400);
  });

  it("opts the user out of the template's topics on POST", async () => {
    const p = await project();
    await p.client.addUser({ id: "u", email: "u@x.com" });
    const res = await anon()(
      "POST",
      `/v1/unsubscribe?token=${encodeURIComponent(token({ projectId: p.id }))}`,
      "List-Unsubscribe=One-Click",
      {
        "content-type": "application/x-www-form-urlencoded",
      },
    );
    expect(res.status).toBe(200);
    expect((await p.client.getUserPreferences("u")).topics).toEqual({ news: false });
  });

  it("suppresses the address outright when there is no topic to scope to, or the user is gone", async () => {
    const p = await project();
    await anon()(
      "POST",
      `/v1/unsubscribe?token=${encodeURIComponent(token({ projectId: p.id, topics: [], target: "Whole@X.com" }))}`,
    );
    await anon()(
      "POST",
      `/v1/unsubscribe?token=${encodeURIComponent(token({ projectId: p.id, userId: "deleted", target: "gone@x.com" }))}`,
    );
    const targets = (await p.client.listSuppressions()).suppressions.map((s) => s.target).sort();
    expect(targets).toEqual(["gone@x.com", "whole@x.com"]);
  });

  it("caps unsubscribe requests per client address", async () => {
    await clearRateLimits();
    const same = apiClient(app.baseUrl, undefined, { "x-forwarded-for": "203.0.113.9" });
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++)
      statuses.push((await same("GET", "/v1/unsubscribe?token=x")).status);
    // Without TRUST_PROXY the header is ignored and every request is from the
    // loopback address, which is what is being limited here.
    expect(statuses.slice(0, 60).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(60)).toEqual([429, 429]);
    await clearRateLimits();
  });
});

// ─── Provider webhooks ──────────────────────────────────────────────────────

describe("provider webhooks", () => {
  const hook = (body: unknown, signature = "valid") =>
    apiClient(app.baseUrl)("POST", "/webhooks/test", body, { "x-signature": signature });

  it("answers the provider's verification challenge", async () => {
    const ok = await fetch(`${app.baseUrl}/webhooks/test?hub.verify_token=ok&hub.challenge=abc123`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("abc123");
    expect((await fetch(`${app.baseUrl}/webhooks/test?hub.verify_token=no`)).status).toBe(403);
  });

  it("rejects an unsigned webhook", async () => {
    expect((await hook({ events: [] }, "forged")).status).toBe(401);
  });

  it("records engagement against the message and suppresses dead or unwilling addresses", async () => {
    const p = await project();
    await p.client.syncTemplates([{ id: "t", channel: "email", content: { subject: "s" } }]);
    for (const id of ["hard", "soft", "unsub", "open"])
      await p.client.addUser({ id, email: `${id}@x.com` });
    for (const id of ["hard", "soft", "unsub", "open"])
      await p.client.notify({ user: id, template: "t", campaign: "hooks" });
    await waitFor("4 sent", () => email.for(p.id).length === 4);
    await waitFor("4 logged", async () => {
      const rows =
        await infra.sql`SELECT 1 FROM message_logs WHERE project_id = ${p.id} AND status = 'delivered'`;
      return rows.length === 4;
    });
    const pm = (id: string) => `pm-${email.for(p.id).find((t) => t.recipientId === id)!.taskId}`;

    const events: WebhookEvent[] = [
      {
        providerMessageId: pm("hard"),
        status: "bounced",
        bounceType: "hard",
        recipient: "HARD@x.com",
      },
      {
        providerMessageId: pm("soft"),
        status: "bounced",
        bounceType: "soft",
        recipient: "soft@x.com",
      },
      { providerMessageId: pm("unsub"), status: "unsubscribed", recipient: "unsub@x.com" },
      { providerMessageId: pm("open"), status: "opened" },
      { providerMessageId: pm("open"), status: "opened" },
      {
        providerMessageId: "pm-from-someone-else",
        status: "complained",
        recipient: "victim@x.com",
      },
    ];
    expect((await hook({ events })).status).toBe(200);
    expect((await hook({ events })).status).toBe(200); // providers retry; must be harmless

    const targets = (await p.client.listSuppressions()).suppressions
      .map((s) => `${s.target}:${s.reason}`)
      .sort();
    expect(targets).toEqual(["hard@x.com:bounced", "unsub@x.com:unsubscribed"]);
    const [{ n }] =
      (await infra.sql`SELECT count(*)::int AS n FROM suppressions WHERE target = 'victim@x.com'`) as any;
    expect(n).toBe(0);

    const stats = await p.client.getCampaignStats("hooks");
    expect(stats.totals).toMatchObject({
      sent: 4,
      delivered: 4,
      opened: 1,
      bounced: 2,
      unsubscribed: 1,
    });
    expect(stats.engagementTracked).toBe(true);
  });
});

// ─── Events, campaigns, system ──────────────────────────────────────────────

describe("events", () => {
  it("accepts an event onto the events stream", async () => {
    const p = await project();
    const res = await p.client.ingestEvent({ name: "order.paid", properties: { orderId: "o1" } });
    expect(res.eventId).toMatch(/^[0-9a-f-]{36}$/);
    const entries = await infra.redis.xrange(STREAMS.EVENTS_INBOUND, "-", "+");
    const ev = entries
      .map(([, f]) => JSON.parse(f[1]!))
      .find((e) => e.metadata.traceId === res.eventId);
    expect(ev.payload).toEqual({
      projectId: p.id,
      eventName: "order.paid",
      payload: { orderId: "o1" },
    });
  });

  it("refuses an expired event and a malformed one", async () => {
    const p = await project();
    const old = await p.api(
      "POST",
      "/v1/events",
      { name: "e", properties: {} },
      {
        "x-timestamp": new Date(Date.now() - 600_000).toISOString(),
        "x-expiry": "60",
      },
    );
    expect(old.status).toBe(400);
    expect((await p.api("POST", "/v1/events", { name: "e" })).status).toBe(400);
  });

  it("streams this project's deliveries, and only this project's, over SSE", async () => {
    const p = await project();
    const other = await project();
    for (const x of [p, other]) {
      await x.client.syncTemplates([{ id: "t", channel: "email", content: { subject: "s" } }]);
      await x.client.addUser({ id: "u", email: "u@x.com" });
    }

    const controller = new AbortController();
    const res = await fetch(`${app.baseUrl}/v1/events/stream`, {
      headers: { authorization: `Bearer ${p.apiKey}` },
      signal: controller.signal,
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    let text = "";
    const reading = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    })().catch(() => {});

    await other.client.notify({ user: "u", template: "t" });
    await p.client.notify({ user: "u", template: "t" });
    await waitFor("own delivery streamed", () => text.includes("event: delivery:delivered"));
    await settle(500);
    controller.abort();
    await reading;

    const taskIds = [...text.matchAll(/"taskId":"([^"]+)"/g)].map((m) => m[1]);
    const mine = email.for(p.id).map((t) => t.taskId);
    expect(taskIds.length).toBeGreaterThan(0);
    expect(taskIds.every((id) => mine.includes(id!))).toBe(true);
  });
});

describe("campaigns", () => {
  it("lists campaigns with their filters, and 404s an unknown one", async () => {
    const p = await project();
    await p.client.syncTemplates([{ id: "t", channel: "email", content: { subject: "s" } }]);
    for (const id of ["a", "b"]) await p.client.addUser({ id, email: `${id}@x.com` });
    await p.client.notify({ user: "a", template: "t", campaign: "alpha" });
    await p.client.notify({ user: ["a", "b"], template: "t", campaign: "beta" } as any);
    await waitFor("logged", async () => (await p.client.listCampaigns()).campaigns.length === 2);
    await waitFor(
      "counted",
      async () => (await p.client.listCampaigns({ search: "bet" })).campaigns[0]?.messages === 2,
    );

    expect(
      (await p.client.listCampaigns({ minMessages: 2 })).campaigns.map((c) => c.campaign),
    ).toEqual(["beta"]);
    expect((await p.client.listCampaigns({ channel: "sms" })).campaigns).toEqual([]);
    expect(
      (await p.client.listCampaigns({ since: new Date(Date.now() + 3600_000) })).campaigns,
    ).toEqual([]);
    expect(
      (await p.client.listCampaigns({ until: new Date(Date.now() - 3600_000) })).campaigns,
    ).toEqual([]);
    await expect(p.client.getCampaignStats("nope")).rejects.toThrow(/No messages/);
  });
});

describe("system", () => {
  it("reports health, readiness and liveness", async () => {
    expect((await fetch(`${app.baseUrl}/live`)).status).toBe(200);
    expect((await fetch(`${app.baseUrl}/ready`)).status).toBe(200);
    await waitFor("workers reported", async () => {
      const h: any = await (await fetch(`${app.baseUrl}/health`)).json();
      return h.workers.delivery.state === "running";
    });
    const health: any = await (await fetch(`${app.baseUrl}/health`)).json();
    expect(health).toMatchObject({ status: "ok", redis: true, database: true });
    expect(health.workers.ai.status).toBe("unknown");
  });

  it("serves Prometheus metrics to loopback callers", async () => {
    const res = await fetch(`${app.baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("notifkit_messages_processed_total");
  });

  it("reports system health and per-project delivery stats", async () => {
    const p = await project();
    await p.client.syncTemplates([{ id: "t", channel: "email", content: { subject: "s" } }]);
    await p.client.addUser({ id: "u", email: "u@x.com" });
    await p.client.notify({ user: "u", template: "t" });
    await waitFor(
      "logged",
      async () => (await p.client.getSystemMetrics()).deliveryStats.delivered === 1,
    );

    const metrics = await p.client.getSystemMetrics();
    expect(metrics.deliveryStats).toEqual({ total: 1, delivered: 1, failed: 0, successRate: 100 });
    const health = await sdk(ADMIN_KEY).getSystemHealth();
    expect(health.status).toBe("healthy");
    expect(Object.keys(health.workers)).toContain("engine");
  });

  it("deletes a dead-lettered message, but only the project's own", async () => {
    const p = await project();
    const other = await project();
    const ev = {
      id: randomUUID(),
      type: "notification.dispatched",
      timestamp: new Date().toISOString(),
      payload: { projectId: p.id },
      metadata: { traceId: "t", source: "s", retryCount: 0 },
      dlq: {
        originalStream: STREAMS.OUTBOUND_NORMAL,
        ackedAt: new Date().toISOString(),
        reason: "boom",
      },
    };
    const id = await infra.redis.xadd(STREAMS.DEAD_LETTER, "*", "data", JSON.stringify(ev));

    const listed = await p.client.getDLQMessages();
    expect(listed.messages.find((m) => m.id === id)).toMatchObject({
      eventType: "notification.dispatched",
      error: "boom",
    });
    expect((await other.client.getDLQMessages()).messages.find((m) => m.id === id)).toBeUndefined();
    await expect(other.client.deleteDLQMessage(id!)).rejects.toThrow();
    await expect(other.client.replayDLQMessage(id!)).rejects.toThrow();

    expect(await p.client.deleteDLQMessage(id!)).toEqual({ success: true });
    expect(await infra.redis.xlen(STREAMS.DEAD_LETTER)).toBe(0);
    await expect(p.client.replayDLQMessage("")).rejects.toThrow();
  });
});

describe("http plumbing", () => {
  it("answers CORS preflights, echoing only the configured origin on admin routes", async () => {
    const pre = await fetch(`${app.baseUrl}/v1/notify`, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");

    const allowed = await fetch(`${app.baseUrl}/v1/projects`, {
      method: "OPTIONS",
      headers: { origin: "https://dash.example.com" },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://dash.example.com");
    const denied = await fetch(`${app.baseUrl}/v1/projects`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example.com" },
    });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("404s an unknown route", async () => {
    const p = await project();
    expect((await p.api("GET", "/v1/nothing-here")).status).toBe(404);
  });

  it("the SDK client surfaces a non-JSON error response as an error with its status", async () => {
    await clearRateLimits();
    const client = new NotifkitClient({ baseUrl: app.baseUrl });
    await expect((client as any).request("/v1/unsubscribe?token=bad", "POST")).rejects.toThrow(
      /400/,
    );
  });
});

describe("SDK client helpers", () => {
  it("sync() pushes the templates given at construction, and is a no-op without any", async () => {
    const p = await project();
    const withTemplates = new NotifkitClient({
      baseUrl: app.baseUrl,
      apiKey: p.apiKey,
      templates: [{ id: "x", channel: "email", content: {} }],
    });
    expect(await withTemplates.sync()).toEqual({ synced: 1 });
    expect(await p.client.sync()).toEqual({ synced: 0 });
    expect((await p.client.listTemplates()).templates.map((t) => t.id)).toEqual(["x"]);
  });

  it("covers workflows through the client", async () => {
    const p = await project();
    await p.client.createWorkflow({ name: "wf-a", steps: [{ action: "wait", duration: "1h" }] });
    await p.client.createWorkflow({ name: "wf-b", steps: [{ action: "wait", duration: "1h" }] });
    expect((await p.client.listWorkflows({ search: "A" })).workflows.map((w) => w.name)).toEqual([
      "wf-a",
    ]);
    expect((await p.client.listWorkflows({ limit: 1 })).workflows).toHaveLength(1);
    const trig = await p.client.triggerWorkflow({
      name: "wf-a",
      user: { id: "inline-user", email: "i@x.com" },
    });
    expect(trig.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(p.client.getWorkflow(randomUUID())).rejects.toThrow(/workflow_not_found/);
    await expect(p.client.getWorkflow("not-a-uuid")).rejects.toThrow(/workflow_not_found/);
    await expect(p.client.cancelWorkflow(randomUUID())).rejects.toThrow(/workflow_not_cancelable/);
    // The inline user was created by the trigger.
    await waitFor(
      "inline user",
      async () => (await p.api("GET", "/v1/users/inline-user")).status === 200,
    );
  });

  it("reads the delivery log with filters", async () => {
    const p = await project();
    await p.client.syncTemplates([
      { id: "t1", channel: "email", content: { subject: "s" } },
      { id: "t2", channel: "email", content: { subject: "s" } },
    ]);
    await p.client.addUser({ id: "u", email: "u@x.com" });
    await p.client.notify({ user: "u", template: "t1", campaign: "c1" });
    await p.client.notify({ user: "u", template: "t2" });
    await waitFor(
      "both logged",
      async () => (await p.client.getNotificationLogs({ status: "delivered" })).logs.length === 2,
    );

    expect(
      (await p.client.getNotificationLogs({ templateId: "t1" })).logs.map((l) => l.templateId),
    ).toEqual(["t1"]);
    expect((await p.client.getNotificationLogs({ campaign: "c1" })).logs).toHaveLength(1);
    expect((await p.client.getNotificationLogs({ channel: "sms" })).logs).toEqual([]);
    const one = (await p.client.getNotificationLogs({ templateId: "t2" })).logs[0]!;
    expect((await p.client.getNotificationLogs({ taskId: one.taskId })).logs).toHaveLength(1);
    expect(
      (await p.client.getNotificationLogs({ search: one.taskId.slice(0, 12) })).logs.length,
    ).toBeGreaterThanOrEqual(1);
    expect((await p.client.getNotificationStatus(one.taskId)).status).toBe("delivered");
  });
});

describe("admin dashboard", () => {
  // Pointed at a port nothing listens on, so the static bundle is served. The
  // bundle is a fixture: dashboard/dist is a gitignored build output, absent in
  // CI and on a fresh checkout, and stale whenever it is present.
  const saved: Record<string, string | undefined> = {};
  let fixture = "";
  beforeAll(async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    fixture = mkdtempSync(join(tmpdir(), "notifkit-dashboard-"));
    mkdirSync(join(fixture, "assets"));
    writeFileSync(
      join(fixture, "index.html"),
      '<!doctype html><div id="root" data-fixture="notifkit-test"></div>',
    );
    writeFileSync(join(fixture, "assets", "app-abc123.js"), "console.log(1)");
    writeFileSync(join(fixture, "favicon.svg"), "<svg/>");

    for (const k of ["VITE_DEV_URL", "NOTIFKIT_DASHBOARD_DIR"]) saved[k] = process.env[k];
    const { freePort } = await import("./support/pipeline.js");
    process.env.VITE_DEV_URL = `http://127.0.0.1:${await freePort()}`;
    process.env.NOTIFKIT_DASHBOARD_DIR = fixture;
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const { rmSync } = await import("node:fs");
    rmSync(fixture, { recursive: true, force: true });
  });

  const get = (path: string) => fetch(`${app.baseUrl}${path}`, { redirect: "manual" });

  it("redirects /admin to /admin/ and serves the SPA's index", async () => {
    const redirect = await get("/admin?x=1");
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("/admin/?x=1");

    const index = await get("/admin/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(index.headers.get("cache-control")).toContain("must-revalidate");
    expect(await index.text()).toContain('data-fixture="notifkit-test"');
  });

  it("serves built assets with their type and a long cache lifetime", async () => {
    const res = await get("/admin/assets/app-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect((await get("/admin/favicon.svg")).headers.get("content-type")).toBe("image/svg+xml");
  });

  it("falls back to the index for client-side routes", async () => {
    const res = await get("/admin/projects/123/logs");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('data-fixture="notifkit-test"');
  });

  it("never serves a file outside the bundle", async () => {
    for (const path of [
      "/admin/../package.json",
      "/admin/%2e%2e/%2e%2e/package.json",
      "/admin/..%2f..%2fpackage.json",
      "/admin/..%5c..%5cpackage.json",
    ]) {
      const res = await get(path);
      const body = await res.text();
      expect(body).not.toContain('"name": "notifkit"');
    }
  });

  it("proxies to the dashboard dev server when one is running", async () => {
    const http = await import("node:http");
    const dev = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "x-dev": "1" });
      res.end(`dev:${req.method} ${req.url}`);
    });
    await new Promise<void>((r) => dev.listen(0, "127.0.0.1", r));
    const before = process.env.VITE_DEV_URL;
    process.env.VITE_DEV_URL = `http://127.0.0.1:${(dev.address() as any).port}`;
    try {
      const res = await get("/admin/src/main.tsx");
      expect(res.headers.get("x-dev")).toBe("1");
      expect(await res.text()).toBe("dev:GET /admin/src/main.tsx");
    } finally {
      process.env.VITE_DEV_URL = before;
      await new Promise((r) => dev.close(r));
    }
  });
});

// ─── Regressions ────────────────────────────────────────────────────────────

describe("regressions", () => {
  it("keeps a user's stored profile when notify carries only part of it inline", async () => {
    const p = await project();
    await p.client.syncTemplates([{ id: "t", channel: "email", content: { subject: "s" } }]);
    await p.client.addUser({ id: "u", email: "u@x.com", timezone: "Europe/Paris", language: "fr" });

    const res = await p.api("POST", "/v1/notify", {
      user: { id: "u", phone: ["+15550009"] },
      template: "t",
    });
    expect(res.status).toBe(202);

    const u = await p.client.getUser("u");
    expect(u).toMatchObject({ timezone: "Europe/Paris", language: "fr", email: "u@x.com" });
    expect(u.contacts!.map((c) => c.target).sort()).toEqual(["+15550009", "u@x.com"]);
  });

  it("still gives a brand-new inline user the default language and timezone", async () => {
    const p = await project();
    await p.client.syncTemplates([{ id: "t", channel: "email", content: { subject: "s" } }]);
    await p.api("POST", "/v1/notify", { user: { id: "fresh", email: ["f@x.com"] }, template: "t" });
    expect(await p.client.getUser("fresh")).toMatchObject({ language: "en", timezone: "UTC" });
  });

  it("honours a legacy millisecond cursor on the delivery log", async () => {
    const p = await project();
    await p.client.syncTemplates([{ id: "t", channel: "email", content: { subject: "s" } }]);
    await p.client.addUser({ id: "u", email: "u@x.com" });
    await p.client.notify({ user: "u", template: "t" });
    await waitFor(
      "logged",
      async () => (await p.client.getNotificationLogs({ status: "delivered" })).logs.length === 1,
    );
    // A cursor from 1970 is older than every row, so the page is empty.
    const res = await p.api("GET", "/v1/notifications/logs?cursor=1");
    expect(res.body.logs).toEqual([]);
  });

  it("lets a browser send the idempotency key the API reads", async () => {
    const res = await fetch(`${app.baseUrl}/v1/notify`, { method: "OPTIONS" });
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "x-idempotency-key",
    );
  });

  it("answers a key deletion with an empty 204", async () => {
    const p = await project();
    const key = await app.admin("POST", `/v1/projects/${p.id}/keys`, {});
    const res = await fetch(`${app.baseUrl}/v1/projects/${p.id}/keys/${key.body.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("content-length") ?? "0").toBe("0");
  });

  it("refuses an event whose timestamp cannot be read", async () => {
    const p = await project();
    const res = await p.api(
      "POST",
      "/v1/events",
      { name: "e", properties: {} },
      { "x-timestamp": "not-a-date", "x-expiry": "60" },
    );
    expect(res.status).toBe(400);
  });

  it("treats % and _ in a search as literal characters", async () => {
    const p = await project();
    await p.client.createSuppression({ channel: "email", target: "a_b@x.com" });
    await p.client.createSuppression({ channel: "email", target: "axb@x.com" });
    const found = (await p.client.listSuppressions({ target: "a_b" })).suppressions;
    expect(found.map((s) => s.target)).toEqual(["a_b@x.com"]);
    expect((await p.client.listSuppressions({ target: "%" })).suppressions).toEqual([]);
  });

  it("serves many live event streams without leaking listener warnings", async () => {
    const p = await project();
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.name);
    process.on("warning", onWarning);
    const controllers = Array.from({ length: 12 }, () => new AbortController());
    try {
      await Promise.all(
        controllers.map((c) =>
          fetch(`${app.baseUrl}/v1/events/stream`, {
            headers: { authorization: `Bearer ${p.apiKey}` },
            signal: c.signal,
          }),
        ),
      );
      await settle(200);
      expect(warnings).not.toContain("MaxListenersExceededWarning");
    } finally {
      for (const c of controllers) c.abort();
      process.off("warning", onWarning);
    }
  });
});
