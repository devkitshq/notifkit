import { describe, it, expect, vi, afterEach } from "vitest";
import { NotifkitClient } from "@/client.js";

/**
 * Stubs `fetch` with a minimal Response double. `status` drives `ok` unless it
 * is given explicitly, which lets the error-path tests cover a 4xx that still
 * carries a JSON body.
 */
function stubFetch(body: unknown, status = 200) {
  const fn = vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The [url, init] pair the client passed to `fetch` on its Nth call. */
function callArgs(fn: ReturnType<typeof stubFetch>, n = 0) {
  const [url, init] = fn.mock.calls[n]!;
  return { url: url as string, init: init as RequestInit };
}

const client = () => new NotifkitClient({ baseUrl: "https://api.test", apiKey: "key_123" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NotifkitClient", () => {
  describe("construction", () => {
    it("strips a trailing slash from baseUrl so paths do not double up", async () => {
      const fetchMock = stubFetch({ segments: [] });
      await new NotifkitClient({ baseUrl: "https://api.test/" }).listSegments();

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/segments");
    });

    it("sends a bearer header when an apiKey is given", async () => {
      const fetchMock = stubFetch({ segments: [] });
      await client().listSegments();

      expect(callArgs(fetchMock).init.headers).toMatchObject({
        "Content-Type": "application/json",
        Authorization: "Bearer key_123",
      });
    });

    it("omits the bearer header when no apiKey is given", async () => {
      const fetchMock = stubFetch({ segments: [] });
      await new NotifkitClient({ baseUrl: "https://api.test" }).listSegments();

      expect(callArgs(fetchMock).init.headers).not.toHaveProperty("Authorization");
    });

    it("lets explicit headers override the defaults", async () => {
      const fetchMock = stubFetch({ segments: [] });
      await new NotifkitClient({
        baseUrl: "https://api.test",
        apiKey: "key_123",
        headers: { Authorization: "Basic other", "X-Trace": "abc" },
      }).listSegments();

      expect(callArgs(fetchMock).init.headers).toMatchObject({
        Authorization: "Basic other",
        "X-Trace": "abc",
      });
    });
  });

  describe("request handling", () => {
    it("returns the parsed body on success", async () => {
      stubFetch({ id: "usr_1" });
      await expect(client().addUser({ id: "usr_1" })).resolves.toEqual({ id: "usr_1" });
    });

    it("returns undefined on 204 without parsing a body", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        status: 204,
        ok: true,
        json: async () => {
          throw new Error("204 responses have no body to parse");
        },
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(client().deleteUser("usr_1")).resolves.toBeUndefined();
    });

    it("sends no body when none is supplied", async () => {
      const fetchMock = stubFetch({ workflows: [] });
      await client().listWorkflows();

      expect(callArgs(fetchMock).init.body).toBeUndefined();
    });

    it("serialises the body as JSON", async () => {
      const fetchMock = stubFetch({ id: "usr_1" });
      await client().addUser({ id: "usr_1", email: "a@b.co" });

      expect(callArgs(fetchMock).init.body).toBe(JSON.stringify({ id: "usr_1", email: "a@b.co" }));
    });

    it("throws the server's `message` when the response is not ok", async () => {
      stubFetch({ message: "user already exists" }, 409);
      await expect(client().addUser({ id: "usr_1" })).rejects.toThrow("user already exists");
    });

    it("falls back to the server's `error` field", async () => {
      stubFetch({ error: "validation_error" }, 400);
      await expect(client().addUser({ id: "usr_1" })).rejects.toThrow("validation_error");
    });

    it("falls back to the status code when the body explains nothing", async () => {
      stubFetch({}, 500);
      await expect(client().addUser({ id: "usr_1" })).rejects.toThrow(
        "Request failed with status 500",
      );
    });
  });

  describe("users", () => {
    it("addUser POSTs to /v1/users", async () => {
      const fetchMock = stubFetch({ id: "usr_1" });
      await client().addUser({ id: "usr_1" });

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/users");
      expect(init.method).toBe("POST");
    });

    it("updateUser PATCHes the user path", async () => {
      const fetchMock = stubFetch({ id: "usr_1" });
      await client().updateUser("usr_1", { timezone: "UTC" });

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/users/usr_1");
      expect(init.method).toBe("PATCH");
    });

    it("deleteUser DELETEs the user path", async () => {
      const fetchMock = stubFetch(undefined, 204);
      await client().deleteUser("usr_1");

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/users/usr_1");
      expect(init.method).toBe("DELETE");
    });

    it("listUsers sends no query string without options", async () => {
      const fetchMock = stubFetch({ users: [], nextCursor: null });
      await client().listUsers();

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/users");
    });

    it("listUsers appends limit and cursor when given", async () => {
      const fetchMock = stubFetch({ users: [], nextCursor: null });
      await client().listUsers({ limit: 50, cursor: "c1" });

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/users?limit=50&cursor=c1");
    });

    it("getUserContacts GETs the contacts path", async () => {
      const fetchMock = stubFetch({ contacts: [] });
      await client().getUserContacts("usr_1");

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/users/usr_1/contacts");
    });

    it("addContact POSTs to the contacts path", async () => {
      const fetchMock = stubFetch({ userId: "usr_1", channel: "email", target: "a@b.co" });
      await client().addContact("usr_1", { channel: "email", target: "a@b.co" });

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/users/usr_1/contacts");
      expect(init.method).toBe("POST");
    });

    it("deleteContact targets the specific channel and address", async () => {
      const fetchMock = stubFetch(undefined, 204);
      await client().deleteContact("usr_1", "email", "a@b.co");

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/users/usr_1/contacts/email/a@b.co");
      expect(init.method).toBe("DELETE");
    });
  });

  describe("templates", () => {
    it("syncTemplates PUTs the template list", async () => {
      const fetchMock = stubFetch({ synced: 2 });
      await client().syncTemplates({ templates: [] as any });

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/templates");
      expect(init.method).toBe("PUT");
    });

    it("deleteTemplate DELETEs the template path", async () => {
      const fetchMock = stubFetch(undefined, 204);
      await client().deleteTemplate("tpl_1");

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/templates/tpl_1");
    });

    it("sync() is a no-op when no templates are configured", async () => {
      const fetchMock = stubFetch({ synced: 0 });
      await expect(client().sync()).resolves.toEqual({ synced: 0 });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sync() is a no-op when the configured template list is empty", async () => {
      const fetchMock = stubFetch({ synced: 0 });
      const c = new NotifkitClient({ baseUrl: "https://api.test", templates: [] });
      await expect(c.sync()).resolves.toEqual({ synced: 0 });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sync() pushes the templates from the client options", async () => {
      const templates = [{ id: "welcome" }] as any;
      const fetchMock = stubFetch({ synced: 1 });
      const c = new NotifkitClient({ baseUrl: "https://api.test", templates });

      await expect(c.sync()).resolves.toEqual({ synced: 1 });
      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/templates");
      expect(init.body).toBe(JSON.stringify({ templates }));
    });
  });

  describe("notify and events", () => {
    it("notify POSTs to /v1/notify", async () => {
      const fetchMock = stubFetch({ messageId: "m1", notificationId: "n1", target: {} });
      await client().notify({ user: "usr_1", template: "welcome" });

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/notify");
      expect(init.method).toBe("POST");
    });

    it("ingestEvent POSTs to /v1/events", async () => {
      const fetchMock = stubFetch({ messageId: "m1", eventId: "e1" });
      await client().ingestEvent({ name: "order.placed", user: "usr_1" } as any);

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/events");
    });
  });

  describe("workflows", () => {
    it("triggerWorkflow POSTs to the trigger path", async () => {
      const fetchMock = stubFetch({ messageId: "m1", instanceId: "i1" });
      await client().triggerWorkflow({ name: "onboarding", user: "usr_1" } as any);

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/workflows/trigger");
    });

    it("createWorkflow POSTs to /v1/workflows", async () => {
      const fetchMock = stubFetch({ name: "onboarding" });
      await client().createWorkflow({ name: "onboarding", steps: [] } as any);

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/workflows");
      expect(init.method).toBe("POST");
    });

    it("listWorkflows GETs /v1/workflows", async () => {
      const fetchMock = stubFetch({ workflows: [] });
      await client().listWorkflows();

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/workflows");
      expect(init.method).toBe("GET");
    });

    it("getWorkflow GETs the instance path", async () => {
      const fetchMock = stubFetch({ id: "i1" });
      await client().getWorkflow("i1");

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/workflows/instances/i1");
    });

    it("cancelWorkflow DELETEs the instance path", async () => {
      const fetchMock = stubFetch(undefined, 204);
      await client().cancelWorkflow("i1");

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/workflows/instances/i1");
      expect(init.method).toBe("DELETE");
    });
  });

  describe("notification logs", () => {
    it("sends no query string when called without options", async () => {
      const fetchMock = stubFetch({ logs: [], nextCursor: null });
      await client().getNotificationLogs();

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/notifications/logs");
    });

    it("sends no query string when the options object is empty", async () => {
      const fetchMock = stubFetch({ logs: [], nextCursor: null });
      await client().getNotificationLogs({});

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/notifications/logs");
    });

    it("keeps a limit of 0, which is falsy but meaningful", async () => {
      const fetchMock = stubFetch({ logs: [], nextCursor: null });
      await client().getNotificationLogs({ limit: 0 });

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/notifications/logs?limit=0");
    });

    it("appends every supported filter", async () => {
      const fetchMock = stubFetch({ logs: [], nextCursor: null });
      await client().getNotificationLogs({
        limit: 10,
        cursor: "c1",
        templateId: "tpl_1",
        workflowInstanceId: "wf_1",
        channel: "email",
        status: "delivered",
      });

      const { url } = callArgs(fetchMock);
      expect(url).toContain("limit=10");
      expect(url).toContain("cursor=c1");
      expect(url).toContain("templateId=tpl_1");
      expect(url).toContain("workflowInstanceId=wf_1");
      expect(url).toContain("channel=email");
      expect(url).toContain("status=delivered");
    });
  });

  describe("projects and keys", () => {
    it("listProjects GETs /v1/projects", async () => {
      const fetchMock = stubFetch({ projects: [] });
      await client().listProjects();

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/projects");
    });

    it("deleteProject DELETEs the project path", async () => {
      const fetchMock = stubFetch(undefined, 204);
      await client().deleteProject("prj_1");

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/projects/prj_1");
      expect(init.method).toBe("DELETE");
    });

    it("updateProject PATCHes the project path", async () => {
      const fetchMock = stubFetch({ id: "prj_1" });
      await client().updateProject("prj_1", { name: "renamed" } as any);

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/projects/prj_1");
      expect(init.method).toBe("PATCH");
    });

    it("createProjectKey sends an empty body when no role is given", async () => {
      const fetchMock = stubFetch({ id: "k1", apiKey: "secret", role: "admin" });
      await client().createProjectKey("prj_1");

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/projects/prj_1/keys");
      expect(init.body).toBe("{}");
    });

    it("createProjectKey forwards the requested role", async () => {
      const fetchMock = stubFetch({ id: "k1", apiKey: "secret", role: "read_only" });
      await client().createProjectKey("prj_1", { role: "read_only" });

      expect(callArgs(fetchMock).init.body).toBe(JSON.stringify({ role: "read_only" }));
    });

    it("listProjectKeys GETs the keys path", async () => {
      const fetchMock = stubFetch({ keys: [] });
      await client().listProjectKeys("prj_1");

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/projects/prj_1/keys");
    });

    it("deleteProjectKey DELETEs the individual key", async () => {
      const fetchMock = stubFetch(undefined, 204);
      await client().deleteProjectKey("prj_1", "k1");

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/projects/prj_1/keys/k1");
      expect(init.method).toBe("DELETE");
    });
  });

  describe("segments", () => {
    it("listSegments GETs /v1/segments", async () => {
      const fetchMock = stubFetch({ segments: ["beta"] });
      await expect(client().listSegments()).resolves.toEqual({ segments: ["beta"] });

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/segments");
    });
  });

  describe("notification status and scheduled messages", () => {
    it("getNotificationStatus GETs /v1/notifications/:taskId", async () => {
      const fetchMock = stubFetch({ status: "delivered", logs: [] });
      await client().getNotificationStatus("task_123");

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/notifications/task_123");
    });

    it("cancelNotification DELETEs /v1/notifications/:taskId", async () => {
      const fetchMock = stubFetch({ success: true });
      await client().cancelNotification("task_123");

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/notifications/task_123");
      expect(init.method).toBe("DELETE");
    });

    it("getScheduledMessages GETs /v1/notifications/scheduled", async () => {
      const fetchMock = stubFetch({ scheduled: [] });
      await client().getScheduledMessages();

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/notifications/scheduled");
    });
  });

  describe("user profile and preferences", () => {
    it("getUser GETs /v1/users/:id", async () => {
      const fetchMock = stubFetch({ id: "usr_1" });
      await client().getUser("usr_1");

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/users/usr_1");
    });

    it("getUserDetails GETs /v1/users/:id/details", async () => {
      const fetchMock = stubFetch({ id: "usr_1", contacts: [], recentLogs: [] });
      await client().getUserDetails("usr_1");

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/users/usr_1/details");
    });

    it("getUserPreferences GETs /v1/users/:id/preferences", async () => {
      const fetchMock = stubFetch({ channels: { email: true } });
      await client().getUserPreferences("usr_1");

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/users/usr_1/preferences");
    });

    it("updateUserPreferences PATCHes /v1/users/:id/preferences", async () => {
      const fetchMock = stubFetch({ id: "usr_1", preferences: { channels: { email: false } } });
      await client().updateUserPreferences("usr_1", { channels: { email: false } });

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/users/usr_1/preferences");
      expect(init.method).toBe("PATCH");
      expect(init.body).toBe(JSON.stringify({ channels: { email: false } }));
    });
  });

  describe("templates querying", () => {
    it("listTemplates GETs /v1/templates", async () => {
      const fetchMock = stubFetch({ templates: [] });
      await client().listTemplates();

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/templates");
    });

    it("getTemplate GETs /v1/templates/:id", async () => {
      const fetchMock = stubFetch({ id: "tpl_1", content: {} });
      await client().getTemplate("tpl_1");

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/templates/tpl_1");
    });
  });

  describe("system health, metrics and DLQ", () => {
    it("getSystemHealth GETs /v1/system/health", async () => {
      const fetchMock = stubFetch({ status: "healthy", workers: {} });
      await client().getSystemHealth();

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/system/health");
    });

    it("getSystemMetrics GETs /v1/system/metrics", async () => {
      const fetchMock = stubFetch({ queueSizes: {}, deliveryMetrics: {} });
      await client().getSystemMetrics();

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/system/metrics");
    });

    it("getDLQMessages GETs /v1/dlq", async () => {
      const fetchMock = stubFetch({ messages: [] });
      await client().getDLQMessages();

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/dlq");
    });

    it("replayDLQMessage POSTs /v1/dlq/replay", async () => {
      const fetchMock = stubFetch({ success: true, replayedId: "m1" });
      await client().replayDLQMessage("dlq_123");

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/dlq/replay");
      expect(init.method).toBe("POST");
      expect(init.body).toBe(JSON.stringify({ id: "dlq_123" }));
    });

    it("deleteDLQMessage DELETEs /v1/dlq/:id", async () => {
      const fetchMock = stubFetch({ success: true });
      await client().deleteDLQMessage("dlq_123");

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/dlq/dlq_123");
      expect(init.method).toBe("DELETE");
    });
  });

  describe("campaigns", () => {
    it("listCampaigns GETs /v1/campaigns without options", async () => {
      const fetchMock = stubFetch({ campaigns: [] });
      await client().listCampaigns();

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/campaigns");
    });

    it("listCampaigns appends limit query parameter when provided", async () => {
      const fetchMock = stubFetch({ campaigns: [] });
      await client().listCampaigns({ limit: 15 });

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/campaigns?limit=15");
    });

    it("getCampaignStats GETs /v1/campaigns/:campaign/stats and encodes special characters", async () => {
      const fetchMock = stubFetch({ campaign: "spring promo / sale", totals: {}, byChannel: {} });
      await client().getCampaignStats("spring promo / sale");

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/campaigns/spring%20promo%20%2F%20sale/stats");
      expect(init.method).toBe("GET");
    });
  });

  describe("suppressions", () => {
    it("listSuppressions GETs /v1/suppressions without options", async () => {
      const fetchMock = stubFetch({ suppressions: [] });
      await client().listSuppressions();

      expect(callArgs(fetchMock).url).toBe("https://api.test/v1/suppressions");
    });

    it("listSuppressions appends all query parameters when provided", async () => {
      const fetchMock = stubFetch({ suppressions: [] });
      await client().listSuppressions({ limit: 20, channel: "email", reason: "unsubscribed" });

      const { url } = callArgs(fetchMock);
      expect(url).toContain("limit=20");
      expect(url).toContain("channel=email");
      expect(url).toContain("reason=unsubscribed");
    });

    it("createSuppression POSTs to /v1/suppressions", async () => {
      const fetchMock = stubFetch({
        channel: "email",
        target: "user@example.com",
        reason: "manual",
      });
      await client().createSuppression({
        channel: "email",
        target: "user@example.com",
        reason: "manual",
      });

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/suppressions");
      expect(init.method).toBe("POST");
      expect(init.body).toBe(
        JSON.stringify({ channel: "email", target: "user@example.com", reason: "manual" }),
      );
    });

    it("deleteSuppression DELETEs /v1/suppressions/:channel/:target with URL encoding", async () => {
      const fetchMock = stubFetch(undefined, 204);
      await client().deleteSuppression("email", "alice+tag@example.com");

      const { url, init } = callArgs(fetchMock);
      expect(url).toBe("https://api.test/v1/suppressions/email/alice%2Btag%40example.com");
      expect(init.method).toBe("DELETE");
    });
  });
});
