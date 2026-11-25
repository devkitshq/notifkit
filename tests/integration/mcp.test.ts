import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../packages/mcp/src/index.js";
import { NotifkitApi, NotifkitApiError } from "../../packages/mcp/src/client.js";
import { STREAMS } from "@/contracts/index.js";
import { useInfra, waitFor } from "./support/infra.js";
import { ADMIN_KEY, RecordingTransport, startNotifkit, type Running } from "./support/pipeline.js";

/**
 * The MCP server as an agent uses it: a real MCP client, connected over the
 * SDK's in-memory transport, calls tools; the tools call a running notifkit.
 * Every tool is exercised and judged by its effect, not by the URL it built.
 */

const infra = useInfra();
let app: Running;
const email = new RecordingTransport("email");
const telegram = new RecordingTransport("telegram");
const slack = new RecordingTransport("slack");

beforeAll(async () => {
  app = await startNotifkit(infra, {
    services: ["api", "enricher", "engine", "delivery", "scheduler", "events", "workflow"],
    providers: [email, telegram, slack],
    env: { RATE_LIMIT_PER_HOUR: "100000" },
  });
}, 120_000);

afterAll(async () => {
  await app?.stop();
}, 60_000);

async function agent(apiKey: string, projectId?: string) {
  const server = createServer({ baseUrl: app.baseUrl, apiKey, projectId });
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);

  async function call(name: string, args: Record<string, unknown> = {}) {
    const res: any = await client.callTool({ name, arguments: args });
    const text = res.content[0].text as string;
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      // plain text result
    }
    return { isError: Boolean(res.isError), text, body };
  }
  return { client, call, close: () => client.close() };
}

async function projectAgent() {
  const p = await app.project();
  return { ...p, ...(await agent(p.apiKey)) };
}

describe("MCP server", () => {
  it("lists all of its tools with input schemas", async () => {
    const a = await projectAgent();
    const { tools } = await a.client.listTools();
    expect(tools).toHaveLength(46);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
    await a.close();
  });

  it("sends to existing users and reports the campaign", async () => {
    const a = await projectAgent();
    expect(
      (
        await a.call("upsert_template", {
          id: "hi",
          channel: "email",
          content: { subject: "Hi {{name}}" },
        })
      ).isError,
    ).toBe(false);
    expect(
      (await a.call("upsert_user", { id: "u1", email: "u1@x.com", segments: ["beta"] })).isError,
    ).toBe(false);

    const sent = await a.call("send_notification", {
      template: "hi",
      user: "u1",
      data: { name: "Ann" },
      campaign: "c-1",
    });
    expect(sent.isError).toBe(false);
    await waitFor("delivered", () => email.for(a.id).length === 1);
    expect(email.for(a.id)[0]!.renderedContent.content).toEqual({ subject: "Hi Ann" });

    await waitFor(
      "stats",
      async () =>
        (await a.call("get_campaign_stats", { campaign: "c-1" })).body?.totals?.delivered === 1,
    );
    const campaigns = await a.call("list_campaigns", {});
    expect(campaigns.body.campaigns.map((c: any) => c.campaign)).toEqual(["c-1"]);
    await a.close();
  });

  it("send_campaign reaches every distinct address once, on email and on chat channels", async () => {
    const a = await projectAgent();
    await a.call("upsert_template", {
      id: "promo",
      channel: "email",
      content: { subject: "Sale" },
    });
    await a.call("upsert_template", { id: "ping", channel: "telegram", content: { text: "Ping" } });
    await a.call("upsert_template", { id: "note", channel: "slack", content: { text: "Note" } });

    const res = await a.call("send_campaign", {
      campaign: "spring",
      template: "promo",
      emails: ["A@x.com", "a@x.com", "b@x.com"],
    });
    expect(res.body).toMatchObject({ queued: 2, duplicatesRemoved: 1 });
    await waitFor("emails", () => email.for(a.id).length === 2);
    expect(
      email
        .for(a.id)
        .map((t) => t.destination)
        .sort(),
    ).toEqual(["a@x.com", "b@x.com"]);

    await a.call("send_campaign", {
      campaign: "chat",
      template: "ping",
      channel: "telegram",
      recipients: ["-1001", "-1002"],
    });
    await waitFor("telegram", () => telegram.for(a.id).length === 2, 10_000);
    expect(
      telegram
        .for(a.id)
        .map((t) => t.destination)
        .sort(),
    ).toEqual(["-1001", "-1002"]);

    await a.call("send_campaign", {
      campaign: "room",
      template: "note",
      channel: "slack",
      recipients: ["C123"],
    });
    await waitFor("slack", () => slack.for(a.id).length === 1, 10_000);

    // A user given the same address twice, once as `email` and once as a contact.
    const both = await a.call("upsert_user", {
      id: "twice",
      email: "t@x.com",
      contacts: [{ channel: "email", target: "t@x.com" }],
    });
    expect(both.isError).toBe(false);

    expect((await a.call("send_campaign", { campaign: "x", template: "promo" })).isError).toBe(
      true,
    );
    await a.close();
  });

  it("previews a template exactly as the pipeline renders it", async () => {
    const a = await projectAgent();
    const content = {
      subject: "Re: {{topic}}",
      html: "<p>{{body}}</p>",
      text: "{{body}} / {{{body}}}",
    };
    await a.call("upsert_template", { id: "rich", channel: "email", content });
    await a.call("upsert_user", { id: "u", email: "u@x.com" });
    const data = { topic: "a\r\nBcc: evil", body: "<b>bold</b>" };

    const preview = await a.call("preview_template", { id: "rich", data: { ...data, extra: 1 } });
    await a.call("send_notification", { template: "rich", user: "u", data });
    await waitFor("sent", () => email.for(a.id).length === 1);

    expect(preview.body.rendered).toEqual(email.for(a.id)[0]!.renderedContent.content);
    expect(preview.body).toMatchObject({ templateId: "rich", channel: "email" });
    expect(preview.body.resolvedVariables.sort()).toEqual(["body", "topic"]);

    const raw = await a.call("render_template", { content: { text: "{{missing}}!" } });
    expect(raw.body).toMatchObject({ rendered: { text: "!" }, unresolvedVariables: ["missing"] });
    expect((await a.call("preview_template", {})).isError).toBe(true);
    await a.close();
  });

  it("manages templates", async () => {
    const a = await projectAgent();
    await a.call("upsert_template", {
      id: "t1",
      channel: "email",
      topic: "news",
      content: { subject: "s" },
    });
    await a.call("upsert_template", { id: "t2", channel: "sms", content: { text: "x" } });
    expect(
      (await a.call("list_templates", { channel: "sms" })).body.templates.map((t: any) => t.id),
    ).toEqual(["t2"]);
    expect(
      (await a.call("list_templates", { topic: "news" })).body.templates.map((t: any) => t.id),
    ).toEqual(["t1"]);
    expect((await a.call("get_template", { id: "t1" })).body.topics).toEqual(["news"]);
    expect((await a.call("delete_template", { id: "t1" })).isError).toBe(false);
    const gone = await a.call("get_template", { id: "t1" });
    expect(gone.isError).toBe(true);
    expect(gone.text).toContain("HTTP 404");
    await a.close();
  });

  it("manages users, contacts and preferences", async () => {
    const a = await projectAgent();
    await a.call("upsert_user", {
      id: "u",
      email: "u@x.com",
      language: "de",
      segments: ["vip"],
      preferences: { topics: { news: true } },
    });
    await a.call("update_user", { id: "u", timezone: "Asia/Tokyo" });
    await a.call("add_user_contact", { userId: "u", channel: "sms", target: "+15550000555" });

    const user = (await a.call("get_user", { id: "u" })).body;
    expect(user).toMatchObject({
      userId: "u",
      language: "de",
      timezone: "Asia/Tokyo",
      segments: ["vip"],
    });
    expect(
      (await a.call("get_user_contacts", { userId: "u" })).body.contacts
        .map((c: any) => c.target)
        .sort(),
    ).toEqual(["+15550000555", "u@x.com"]);
    expect(
      (await a.call("list_users", { segment: "vip" })).body.users.map((u: any) => u.userId),
    ).toEqual(["u"]);
    expect((await a.call("list_segments")).body.segments).toEqual(["vip"]);

    await a.call("update_user_preferences", {
      userId: "u",
      topics: { news: false },
      quietHours: [{ start: "22:00", end: "06:00" }],
    });
    expect((await a.call("get_user_preferences", { userId: "u" })).body).toMatchObject({
      topics: { news: false },
      quietHours: [{ start: "22:00", end: "06:00" }],
    });

    await a.call("delete_user_contact", { userId: "u", channel: "sms", target: "+15550000555" });
    expect((await a.call("get_user_contacts", { userId: "u" })).body.contacts).toHaveLength(1);
    await a.call("delete_user", { id: "u" });
    expect((await a.call("get_user", { id: "u" })).isError).toBe(true);
    await a.close();
  });

  it("manages suppressions", async () => {
    const a = await projectAgent();
    await a.call("suppress_address", {
      channel: "email",
      target: "Stop@X.com",
      reason: "complained",
    });
    expect(
      (await a.call("list_suppressions", { channel: "email" })).body.suppressions.map(
        (s: any) => s.target,
      ),
    ).toEqual(["stop@x.com"]);
    await a.call("unsuppress_address", { channel: "email", target: "stop@x.com" });
    expect((await a.call("list_suppressions", {})).body.suppressions).toEqual([]);
    await a.close();
  });

  it("lists, inspects and cancels scheduled sends, and reads delivery logs", async () => {
    const a = await projectAgent();
    await a.call("upsert_template", { id: "t", channel: "email", content: { subject: "s" } });
    await a.call("upsert_user", { id: "u", email: "u@x.com" });
    await a.call("send_notification", {
      template: "t",
      user: "u",
      sendAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await a.call("send_notification", { template: "t", user: "u" });

    let scheduled: any[] = [];
    await waitFor("parked", async () => {
      scheduled = (await a.call("list_scheduled", {})).body.scheduled ?? [];
      return scheduled.length === 1;
    });
    expect((await a.call("cancel_notification", { taskId: scheduled[0].taskId })).isError).toBe(
      false,
    );
    expect((await a.call("list_scheduled", {})).body.scheduled).toEqual([]);

    await waitFor(
      "logged",
      async () =>
        (await a.call("get_delivery_logs", { status: "delivered" })).body.logs?.length === 1,
    );
    const log = (await a.call("get_delivery_logs", { status: "delivered" })).body.logs[0];
    expect((await a.call("get_notification", { taskId: log.taskId })).body.status).toBe(
      "delivered",
    );
    await a.close();
  });

  it("defines, runs, inspects and cancels workflows, and ingests events", async () => {
    const a = await projectAgent();
    await a.call("upsert_template", { id: "t", channel: "email", content: { subject: "s" } });
    await a.call("upsert_user", { id: "u", email: "u@x.com" });
    await a.call("create_workflow", {
      name: "drip",
      steps: [
        { action: "notify", payload: { template: "t" } },
        { action: "waitForEvent", event: "clicked", options: { timeout: "1h" } },
      ],
    });
    expect(
      (await a.call("list_workflows", { search: "dri" })).body.workflows.map((w: any) => w.name),
    ).toEqual(["drip"]);

    const run = (await a.call("trigger_workflow", { name: "drip", user: "u" })).body;
    await waitFor(
      "waiting",
      async () =>
        (await a.call("get_workflow_run", { instanceId: run.instanceId })).body.status ===
        "pending",
    );
    await waitFor("first step sent", () => email.for(a.id).length === 1);

    expect((await a.call("ingest_event", { name: "unrelated", properties: {} })).isError).toBe(
      false,
    );
    expect((await a.call("cancel_workflow_run", { instanceId: run.instanceId })).isError).toBe(
      false,
    );
    expect((await a.call("get_workflow_run", { instanceId: run.instanceId })).body.status).toBe(
      "canceled",
    );
    await a.close();
  });

  it("reports system health, metrics and dead letters", async () => {
    const a = await projectAgent();
    expect((await a.call("get_system_health")).body.status).toBe("healthy");
    expect((await a.call("get_system_metrics")).body.deliveryStats).toBeDefined();

    const ev = {
      id: randomUUID(),
      type: "notification.dispatched",
      timestamp: new Date().toISOString(),
      payload: { projectId: a.id },
      metadata: { traceId: "t", source: "s", retryCount: 0 },
      dlq: {
        originalStream: STREAMS.OUTBOUND_NORMAL,
        ackedAt: new Date().toISOString(),
        reason: "x",
      },
    };
    const id1 = await infra.redis.xadd(STREAMS.DEAD_LETTER, "*", "data", JSON.stringify(ev));
    const id2 = await infra.redis.xadd(
      STREAMS.DEAD_LETTER,
      "*",
      "data",
      JSON.stringify({ ...ev, id: randomUUID() }),
    );
    const dead = (await a.call("get_dead_letters")).body.messages.map((m: any) => m.id);
    expect(dead).toEqual(expect.arrayContaining([id1, id2]));

    expect((await a.call("delete_dead_letter", { id: id1 })).isError).toBe(false);
    expect((await a.call("replay_dead_letter", { id: id2 })).body).toMatchObject({
      success: true,
      stream: STREAMS.OUTBOUND_NORMAL,
    });
    await a.close();
  });

  it("administers projects and keys with the admin key", async () => {
    const admin = await agent(ADMIN_KEY);
    const created = (await admin.call("create_project", { name: "Via MCP" })).body;
    expect(created.apiKey).toMatch(/^nk_live_/);
    expect((await admin.call("list_projects")).body.projects.map((p: any) => p.id)).toContain(
      created.id,
    );
    await admin.call("update_project", { id: created.id, throttleLimit: 3 });

    const key = (
      await admin.call("create_project_key", { projectId: created.id, role: "read_only" })
    ).body;
    expect(
      (await admin.call("list_project_keys", { projectId: created.id })).body.keys,
    ).toHaveLength(2);
    expect(
      (await admin.call("delete_project_key", { projectId: created.id, keyId: key.id })).isError,
    ).toBe(false);
    expect((await admin.call("delete_project", { id: created.id })).isError).toBe(false);
    expect((await admin.call("list_projects")).body.projects.map((p: any) => p.id)).not.toContain(
      created.id,
    );
    await admin.close();
  });

  it("reports an API failure to the model instead of crashing", async () => {
    const bad = await agent("nk_live_not_a_key");
    const res = await bad.call("list_templates", {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("HTTP 401");
    await bad.close();
  });
});

describe("NotifkitApi (the MCP server's HTTP client)", () => {
  it("talks to a real server: query strings, bodies, 204s and errors", async () => {
    const p = await app.project();
    const api = new NotifkitApi({ baseUrl: `${app.baseUrl}/`, apiKey: p.apiKey });
    await api.put("/v1/templates", {
      templates: [
        { id: "a", channel: "email", content: {} },
        { id: "b", channel: "sms", content: {} },
      ],
    });
    expect(
      (
        await api.get<any>("/v1/templates", { channel: "sms", limit: 5, topic: undefined })
      ).templates.map((t: any) => t.id),
    ).toEqual(["b"]);
    await api.post("/v1/users", { id: "u" });
    await api.patch("/v1/users/u", { language: "fr" });
    expect(await api.delete("/v1/templates/a")).toBeUndefined();

    const err: any = await api.get("/v1/templates/a").catch((e) => e);
    expect(err).toBeInstanceOf(NotifkitApiError);
    expect(err.status).toBe(404);
    expect(err.body).toMatchObject({ error: "template_not_found" });

    const admin = new NotifkitApi({ baseUrl: app.baseUrl, apiKey: ADMIN_KEY, projectId: p.id });
    expect((await admin.get<any>("/v1/users/u")).language).toBe("fr");
  });
});
