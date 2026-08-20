import { describe, it, expect, vi, afterEach } from "vitest";
import { NotifkitApi, NotifkitApiError } from "../packages/mcp/src/client.js";
import { createServer } from "../packages/mcp/src/index.js";
import { registerTools } from "../packages/mcp/src/tools.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function stubFetch(body: unknown, status = 200) {
  const fn = vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function callArgs(fn: ReturnType<typeof stubFetch>, n = 0) {
  const [url, init] = fn.mock.calls[n]!;
  return { url: url as string, init: init as RequestInit };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NotifkitApi (MCP Client)", () => {
  const api = new NotifkitApi({
    baseUrl: "https://api.test",
    apiKey: "nk_test_123",
    projectId: "proj_1",
  });

  it("handles GET requests with query params", async () => {
    const fetchMock = stubFetch({ templates: [] });
    const res = await api.get("/v1/templates", { channel: "email", limit: 10 });

    expect(res).toEqual({ templates: [] });
    const args = callArgs(fetchMock);
    expect(args.url).toBe("https://api.test/v1/templates?channel=email&limit=10");
    expect(args.init.method).toBe("GET");
    expect(args.init.headers).toMatchObject({
      Authorization: "Bearer nk_test_123",
      "x-project-id": "proj_1",
    });
  });

  it("handles POST requests with JSON payload", async () => {
    const fetchMock = stubFetch({ id: "proj_new" });
    const res = await api.post("/v1/projects", { name: "Test Project" });

    expect(res).toEqual({ id: "proj_new" });
    const args = callArgs(fetchMock);
    expect(args.url).toBe("https://api.test/v1/projects");
    expect(args.init.method).toBe("POST");
    expect(args.init.body).toBe(JSON.stringify({ name: "Test Project" }));
  });

  it("handles PATCH requests", async () => {
    const fetchMock = stubFetch({ id: "usr_1" });
    const res = await api.patch("/v1/users/usr_1", { timezone: "Europe/London" });

    expect(res).toEqual({ id: "usr_1" });
    const args = callArgs(fetchMock);
    expect(args.url).toBe("https://api.test/v1/users/usr_1");
    expect(args.init.method).toBe("PATCH");
    expect(args.init.body).toBe(JSON.stringify({ timezone: "Europe/London" }));
  });

  it("handles DELETE requests (204 No Content)", async () => {
    const fetchMock = stubFetch("", 204);
    const res = await api.delete("/v1/templates/t_1");

    expect(res).toBeUndefined();
    const args = callArgs(fetchMock);
    expect(args.url).toBe("https://api.test/v1/templates/t_1");
    expect(args.init.method).toBe("DELETE");
  });

  it("throws NotifkitApiError on HTTP failure", async () => {
    stubFetch({ error: "not_found", message: "Template not found" }, 404);

    await expect(api.get("/v1/templates/t_missing")).rejects.toThrow(NotifkitApiError);
  });
});

describe("MCP Server Tool Registration", () => {
  it("registers all existing and newly implemented tools", () => {
    const server = new McpServer({ name: "notifkit-test", version: "0.1.0" });
    const api = new NotifkitApi({ baseUrl: "https://api.test", apiKey: "nk_key" });
    registerTools(server, api);

    // Access registered tool names from the server instance
    const registeredTools = Object.keys((server as any)._registeredTools || {});

    // Core existing tools
    expect(registeredTools).toContain("send_notification");
    expect(registeredTools).toContain("send_campaign");
    expect(registeredTools).toContain("list_campaigns");
    expect(registeredTools).toContain("get_campaign_stats");
    expect(registeredTools).toContain("list_templates");
    expect(registeredTools).toContain("get_template");
    expect(registeredTools).toContain("upsert_template");
    expect(registeredTools).toContain("list_users");
    expect(registeredTools).toContain("get_user");
    expect(registeredTools).toContain("upsert_user");

    expect(registeredTools).toContain("preview_template");
    expect(registeredTools).toContain("render_template");
    expect(registeredTools).toContain("delete_template");
    expect(registeredTools).toContain("update_user");
    expect(registeredTools).toContain("delete_user");
    expect(registeredTools).toContain("get_user_contacts");
    expect(registeredTools).toContain("delete_user_contact");
    expect(registeredTools).toContain("get_user_preferences");
    expect(registeredTools).toContain("update_user_preferences");
    expect(registeredTools).toContain("delete_dead_letter");
    expect(registeredTools).toContain("get_system_metrics");
    expect(registeredTools).toContain("list_projects");
    expect(registeredTools).toContain("create_project");
    expect(registeredTools).toContain("update_project");
    expect(registeredTools).toContain("delete_project");
    expect(registeredTools).toContain("list_project_keys");
    expect(registeredTools).toContain("create_project_key");
    expect(registeredTools).toContain("delete_project_key");
  });

  it("executes preview_template and render_template tool handlers", async () => {
    stubFetch({
      id: "tmpl_welcome",
      channel: "email",
      content: {
        subject: "Welcome, {{name}}!",
        body: "Hello {{name}}, your plan is {{{plan}}}.",
      },
    });
    const server = createServer({ baseUrl: "https://api.test", apiKey: "nk_key" });
    const tools = (server as any)._registeredTools;

    // preview by id
    const previewRes = await tools["preview_template"].handler({
      id: "tmpl_welcome",
      data: { name: "Alice", plan: "Pro" },
    });
    expect(previewRes.isError).toBeFalsy();
    const previewData = JSON.parse(previewRes.content[0].text);
    expect(previewData.rendered.subject).toBe("Welcome, Alice!");
    expect(previewData.rendered.body).toBe("Hello Alice, your plan is Pro.");
    expect(previewData.resolvedVariables).toEqual(["name", "plan"]);

    // render with raw content
    const renderRes = await tools["render_template"].handler({
      content: { subject: "Order #{{orderId}}", text: "Total: {{total}}" },
      data: { orderId: "123", total: "$50" },
    });
    expect(renderRes.isError).toBeFalsy();
    const renderData = JSON.parse(renderRes.content[0].text);
    expect(renderData.rendered.subject).toBe("Order #123");
    expect(renderData.rendered.text).toBe("Total: $50");
  });

  it("executes send_campaign with multichannel support", async () => {
    const fetchMock = stubFetch({ messageId: "msg_1" }, 202);
    const server = createServer({ baseUrl: "https://api.test", apiKey: "nk_key" });
    const tools = (server as any)._registeredTools;

    // SMS campaign with recipients
    const smsRes = await tools["send_campaign"].handler({
      campaign: "sms-promo",
      template: "tmpl_sms",
      channel: "sms",
      recipients: ["+15551234567", "+15557654321"],
    });
    expect(smsRes.isError).toBeFalsy();
    const smsData = JSON.parse(smsRes.content[0].text);
    expect(smsData.channel).toBe("sms");
    expect(smsData.queued).toBe(2);

    const call = callArgs(fetchMock);
    expect(call.url).toBe("https://api.test/v1/notify");
    const body = JSON.parse(call.init.body as string);
    expect(body.channels).toEqual(["sms"]);
    expect(body.user).toEqual([
      { id: "phone:+15551234567", phone: "+15551234567" },
      { id: "phone:+15557654321", phone: "+15557654321" },
    ]);
  });

  it("executes delete_template tool handler", async () => {
    const fetchMock = stubFetch("", 204);
    const server = createServer({ baseUrl: "https://api.test", apiKey: "nk_key" });
    const tools = (server as any)._registeredTools;

    const result = await tools["delete_template"].handler({ id: "tmpl_abc" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Deleted template tmpl_abc");
    expect(callArgs(fetchMock).url).toBe("https://api.test/v1/templates/tmpl_abc");
    expect(callArgs(fetchMock).init.method).toBe("DELETE");
  });

  it("executes update_user tool handler", async () => {
    const fetchMock = stubFetch({ id: "usr_1" });
    const server = createServer({ baseUrl: "https://api.test", apiKey: "nk_key" });
    const tools = (server as any)._registeredTools;

    const result = await tools["update_user"].handler({
      id: "usr_1",
      timezone: "America/New_York",
    });
    expect(result.isError).toBeFalsy();
    expect(callArgs(fetchMock).url).toBe("https://api.test/v1/users/usr_1");
    expect(callArgs(fetchMock).init.method).toBe("PATCH");
  });

  it("executes delete_user tool handler", async () => {
    const fetchMock = stubFetch("", 204);
    const server = createServer({ baseUrl: "https://api.test", apiKey: "nk_key" });
    const tools = (server as any)._registeredTools;

    const result = await tools["delete_user"].handler({ id: "usr_1" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Deleted user usr_1");
    expect(callArgs(fetchMock).url).toBe("https://api.test/v1/users/usr_1");
    expect(callArgs(fetchMock).init.method).toBe("DELETE");
  });

  it("executes delete_user_contact tool handler", async () => {
    const fetchMock = stubFetch("", 204);
    const server = createServer({ baseUrl: "https://api.test", apiKey: "nk_key" });
    const tools = (server as any)._registeredTools;

    const result = await tools["delete_user_contact"].handler({
      userId: "usr_1",
      channel: "email",
      target: "old@example.com",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain(
      "Deleted email contact 'old@example.com' for user usr_1",
    );
    expect(callArgs(fetchMock).url).toBe(
      "https://api.test/v1/users/usr_1/contacts/email/old%40example.com",
    );
    expect(callArgs(fetchMock).init.method).toBe("DELETE");
  });

  it("executes project tools handlers", async () => {
    stubFetch({ projects: [{ id: "proj_1", name: "Main" }] });
    const server = createServer({ baseUrl: "https://api.test", apiKey: "nk_key" });
    const tools = (server as any)._registeredTools;

    // list_projects
    const listRes = await tools["list_projects"].handler({});
    expect(listRes.isError).toBeFalsy();
    expect(JSON.parse(listRes.content[0].text)).toEqual({
      projects: [{ id: "proj_1", name: "Main" }],
    });

    // create_project
    stubFetch({ id: "proj_2", apiKey: "nk_live_123" });
    const createRes = await tools["create_project"].handler({ name: "Staging" });
    expect(createRes.isError).toBeFalsy();
    expect(JSON.parse(createRes.content[0].text)).toEqual({ id: "proj_2", apiKey: "nk_live_123" });

    // delete_project
    stubFetch("", 204);
    const deleteRes = await tools["delete_project"].handler({ id: "proj_2" });
    expect(deleteRes.isError).toBeFalsy();
    expect(deleteRes.content[0].text).toContain("Deleted project proj_2");
  });

  it("executes dead-letter delete and metrics handlers", async () => {
    const server = createServer({ baseUrl: "https://api.test", apiKey: "nk_key" });
    const tools = (server as any)._registeredTools;

    // delete_dead_letter
    const fetchMock = stubFetch("", 204);
    const delRes = await tools["delete_dead_letter"].handler({ id: "dlq_msg_123" });
    expect(delRes.isError).toBeFalsy();
    expect(delRes.content[0].text).toContain("Deleted dead letter message dlq_msg_123");
    expect(callArgs(fetchMock).url).toBe("https://api.test/v1/dlq/dlq_msg_123");

    // get_system_metrics
    stubFetch({ streams: { DEAD_LETTER: 0 }, deliveryStats: { total: 10, delivered: 10 } });
    const metricsRes = await tools["get_system_metrics"].handler({});
    expect(metricsRes.isError).toBeFalsy();
    expect(JSON.parse(metricsRes.content[0].text).deliveryStats.delivered).toBe(10);
  });

  it("passes query filters correctly for list_templates, list_scheduled, list_workflows, and list_users", async () => {
    const server = createServer({ baseUrl: "https://api.test", apiKey: "nk_key" });
    const tools = (server as any)._registeredTools;

    // list_templates with channel, topic, limit
    const fetchTemplates = stubFetch({ templates: [{ id: "tmpl_1" }] });
    await tools["list_templates"].handler({ channel: "email", topic: "marketing", limit: 25 });
    expect(callArgs(fetchTemplates).url).toBe(
      "https://api.test/v1/templates?channel=email&topic=marketing&limit=25",
    );

    // list_scheduled with channel, cursor, limit
    const fetchScheduled = stubFetch({ scheduled: [] });
    await tools["list_scheduled"].handler({ channel: "sms", cursor: "task_99", limit: 10 });
    expect(callArgs(fetchScheduled).url).toBe(
      "https://api.test/v1/notifications/scheduled?channel=sms&cursor=task_99&limit=10",
    );

    // list_workflows with search and limit
    const fetchWorkflows = stubFetch({ workflows: [] });
    await tools["list_workflows"].handler({ search: "onboarding", limit: 5 });
    expect(callArgs(fetchWorkflows).url).toBe(
      "https://api.test/v1/workflows?search=onboarding&limit=5",
    );

    // list_users with search, segment, language, timezone, channel
    const fetchUsers = stubFetch({ users: [] });
    await tools["list_users"].handler({
      search: "alice",
      segment: "vip",
      language: "en",
      timezone: "Europe/London",
      channel: "sms",
      limit: 50,
    });
    expect(callArgs(fetchUsers).url).toBe(
      "https://api.test/v1/users?search=alice&segment=vip&language=en&timezone=Europe%2FLondon&channel=sms&limit=50",
    );
  });
});
