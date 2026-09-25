import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHandlers, type Deps } from "@/services/api/handlers.js";

function createMockReq(body: any) {
  return {
    on: vi.fn((event: string, cb: any) => {
      if (event === "data") {
        cb(Buffer.from(JSON.stringify(body)));
      }
      if (event === "end") {
        cb();
      }
    }),
    headers: {},
  } as any;
}

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    setHeader: vi.fn((k, v) => {
      res.headers[k] = v;
    }),
    writeHead: vi.fn((code, headers) => {
      res.statusCode = code;
      Object.assign(res.headers, headers || {});
      return res;
    }),
    end: vi.fn((data) => {
      if (data) res.body = data;
    }),
  } as any;
  return res;
}

import {
  extractAuthToken,
  getClientIp,
  calculateSlidingWindow,
  LUA_SLIDING_WINDOW_COUNTER,
  API_RATE_LIMIT_WINDOW_MS,
} from "@/services/api/main.js";

describe("extractAuthToken", () => {
  it("extracts Bearer token from authorization header", () => {
    const req = { headers: { authorization: "Bearer my-secret-token" } };
    expect(extractAuthToken(req as any)).toBe("my-secret-token");
  });

  it("extracts from x-api-key header if authorization is missing", () => {
    const req = { headers: { "x-api-key": "my-api-key" } };
    expect(extractAuthToken(req as any)).toBe("my-api-key");
  });

  it("returns undefined if no matching headers exist", () => {
    const req = { headers: {} };
    expect(extractAuthToken(req as any)).toBeUndefined();
  });

  it("handles mixed case and whitespace in Bearer authorization header", () => {
    const req = { headers: { authorization: "bearer   my-token-with-spaces  " } };
    expect(extractAuthToken(req as any)).toBe("my-token-with-spaces");
  });

  // `set ADMIN_API_KEY=key && cmd` on Windows puts a trailing space in the
  // variable. The token side is trimmed, so if the configured side were not,
  // the two could never match and every admin request would 401.
  it("matches a configured key that carries the whitespace a shell added", async () => {
    const { readBaseConfig } = await import("@/config/index.js");

    const config = readBaseConfig({ ADMIN_API_KEY: "supersecretkey " } as NodeJS.ProcessEnv);
    const token = extractAuthToken({ headers: { authorization: "Bearer supersecretkey" } } as any);

    expect(config.ADMIN_API_KEY).toBe("supersecretkey");
    expect(token).toBe(config.ADMIN_API_KEY);
  });

  it("prioritizes Bearer authorization header over x-api-key if both are present", () => {
    const req = {
      headers: {
        authorization: "Bearer bearer-key",
        "x-api-key": "header-key",
      },
    };
    expect(extractAuthToken(req as any)).toBe("bearer-key");
  });
});

describe("getClientIp", () => {
  it("ignores X-Forwarded-For when trustProxy is false", () => {
    const req = {
      headers: { "x-forwarded-for": "198.51.100.1" },
      socket: { remoteAddress: "203.0.113.195" },
    };
    expect(getClientIp(req as any, false)).toBe("203.0.113.195");
  });

  it("respects X-Forwarded-For when trustProxy is true", () => {
    const req = {
      headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.1" },
      socket: { remoteAddress: "10.0.0.1" },
    };
    expect(getClientIp(req as any, true)).toBe("198.51.100.1");
  });

  it("falls back to remoteAddress if X-Forwarded-For is missing even when trustProxy is true", () => {
    const req = {
      headers: {},
      socket: { remoteAddress: "203.0.113.195" },
    };
    expect(getClientIp(req as any, true)).toBe("203.0.113.195");
  });

  it("returns unknown when no remoteAddress or forwarded header exists", () => {
    const req = { headers: {}, socket: {} };
    expect(getClientIp(req as any, false)).toBe("unknown");
  });
});

describe("API Handlers", () => {
  let deps: Deps;
  let handlers: ReturnType<typeof createHandlers>;

  beforeEach(() => {
    const mockPublishBatch = vi.fn().mockImplementation((events) =>
      Promise.resolve({
        messageIds: events.map((_: any, i: number) => `msg-${i}`),
        eventIds: events.map((_: any, i: number) => `evt-${i}`),
      }),
    );
    deps = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      producers: {
        normal: {
          publish: vi.fn().mockResolvedValue("msg-123"),
          publishBatch: mockPublishBatch,
        } as any,
        critical: {
          publish: vi.fn().mockResolvedValue("msg-123"),
          publishBatch: mockPublishBatch,
        } as any,
        low: {
          publish: vi.fn().mockResolvedValue("msg-123"),
          publishBatch: mockPublishBatch,
        } as any,
        workflow: {
          publish: vi.fn().mockResolvedValue("msg-wf-123"),
          publishBatch: mockPublishBatch,
        } as any,
        events: {
          publish: vi.fn().mockResolvedValue("msg-evt-123"),
          publishBatch: mockPublishBatch,
        } as any,
      },
      userRepo: {
        upsertFull: vi.fn().mockResolvedValue(undefined),
        upsertManyFull: vi.fn().mockResolvedValue(undefined),
        updatePartial: vi.fn().mockResolvedValue(true),
        findById: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue(true),
      } as any,
      contactRepo: {
        upsert: vi.fn().mockResolvedValue(undefined),
        upsertMany: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(true),
      } as any,
      templateRepo: {
        upsertMany: vi.fn().mockResolvedValue(2),
        findById: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockResolvedValue(true),
      } as any,
      projectRepo: {
        list: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockResolvedValue(true),
        updateSettings: vi.fn().mockResolvedValue(true),
        createApiKey: vi.fn().mockResolvedValue({ id: "key_1" }),
        listApiKeys: vi.fn().mockResolvedValue([]),
        deleteApiKey: vi.fn().mockResolvedValue(true),
        updateApiKeyHash: vi.fn().mockResolvedValue(true),
      } as any,
      workflowRepo: {
        listDefinitions: vi.fn().mockResolvedValue([]),
        getInstance: vi.fn().mockResolvedValue(null),
        cancelInstance: vi.fn().mockResolvedValue(true),
      } as any,
      segmentRepo: {
        listSegments: vi.fn().mockResolvedValue([{ segment: "segment-1" }]),
      } as any,
      db: {
        transaction: vi.fn(async (cb) => cb({})),
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockResolvedValue([]),
            onConflictDoUpdate: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any,
      redis: { native: { publish: vi.fn() } } as any,
    };
    handlers = createHandlers(deps);
  });

  it("syncTemplates (initializeApp)", async () => {
    const req = createMockReq({
      templates: [
        {
          id: "order-shipped",
          channel: "email",
          topic: ["transactional"],
          content: {
            subject: "Your order {{tracking}} has shipped!",
            html: "<h1>Hello {{name}}</h1>",
          },
        },
      ],
    });
    const res = createMockRes();

    await handlers.syncTemplates(req, res, {
      projectId: "test_project_id",
      params: {},
      query: new URLSearchParams(),
    } as any);

    expect(res.statusCode).toBe(200);
    expect(deps.templateRepo.upsertMany).toHaveBeenCalledWith("test_project_id", [
      {
        id: "order-shipped",
        channel: "email",
        topics: ["transactional"],
        content: {
          subject: "Your order {{tracking}} has shipped!",
          html: "<h1>Hello {{name}}</h1>",
        },
      },
    ]);
  });

  it("addUser", async () => {
    const req = createMockReq({
      id: "usr_456",
      email: ["bob@example.com", "bob.work@example.com"],
      phone: ["+1987654321", "+1123456789"],
      segments: ["beta-testers", "premium-tier"],
      preferences: {
        channels: { sms: false },
        topics: { marketing: false, transactional: true },
        quietHours: [{ start: "22:00", end: "08:00" }],
      },
    });
    const res = createMockRes();

    await handlers.addUser(req, res, {
      projectId: "test_project_id",
      params: {},
      query: new URLSearchParams(),
    } as any);

    expect(res.statusCode).toBe(201);
    expect(deps.userRepo.upsertManyFull).toHaveBeenCalledWith("test_project_id", [
      expect.objectContaining({
        userId: "usr_456",
        email: "bob@example.com", // saves the first email on the main record
        segments: ["beta-testers", "premium-tier"],
      }),
    ]);
    // Verifies all contacts are added separately
    expect(deps.contactRepo.upsertMany).toHaveBeenCalledWith("test_project_id", [
      expect.objectContaining({ userId: "usr_456", channel: "email", target: "bob@example.com" }),
      expect.objectContaining({
        userId: "usr_456",
        channel: "email",
        target: "bob.work@example.com",
      }),
      expect.objectContaining({ userId: "usr_456", channel: "sms", target: "+1987654321" }),
      expect.objectContaining({ userId: "usr_456", channel: "sms", target: "+1123456789" }),
    ]);
  });

  it("updateUser", async () => {
    const req = createMockReq({
      phone: "+1112223333",
      preferences: { channels: { push: true } },
    });
    const res = createMockRes();
    const ctx = { params: { id: "usr_456" }, query: new URLSearchParams() };

    await handlers.updateUser(req, res, { ...ctx, projectId: "test_project_id" } as any);

    expect(res.statusCode).toBe(200);
    expect(deps.userRepo.updatePartial).toHaveBeenCalledWith(
      "test_project_id",
      "usr_456",
      expect.objectContaining({
        preferences: { channels: { push: true } },
      }),
    );
    expect(deps.contactRepo.upsert).toHaveBeenCalledWith(
      "test_project_id",
      "usr_456",
      "sms",
      "+1112223333",
    );
  });

  it("addContact (addUserContact)", async () => {
    const req = createMockReq({
      channel: "email",
      target: "bob.personal@example.com",
      preferences: {
        topics: { marketing: true, transactional: false },
        quietHours: [{ start: "18:00", end: "09:00" }],
      },
    });
    const res = createMockRes();
    const ctx = { params: { id: "usr_456" }, query: new URLSearchParams() };

    await handlers.addContact(req, res, { ...ctx, projectId: "test_project_id" } as any);

    expect(res.statusCode).toBe(201);
    expect(deps.contactRepo.upsert).toHaveBeenCalledWith(
      "test_project_id",
      "usr_456",
      "email",
      "bob.personal@example.com",
      expect.any(Object), // the preferences object
    );
  });

  it("addUser with dynamic contacts array", async () => {
    const req = createMockReq({
      id: "usr_dynamic",
      contacts: [
        { channel: "slack", target: "U999", label: "Work Slack" },
        { channel: "discord", target: "888" },
        { channel: "email", target: "slackuser@example.com" },
      ],
      segments: ["power-users"],
    });
    const res = createMockRes();

    await handlers.addUser(req, res, {
      projectId: "test_project_id",
      params: {},
      query: new URLSearchParams(),
    } as any);

    expect(res.statusCode).toBe(201);
    expect(deps.userRepo.upsertManyFull).toHaveBeenCalledWith("test_project_id", [
      expect.objectContaining({
        userId: "usr_dynamic",
        email: "slackuser@example.com", // falls back to email in contacts array
        segments: ["power-users"],
      }),
    ]);
    expect(deps.contactRepo.upsertMany).toHaveBeenCalledWith("test_project_id", [
      expect.objectContaining({ userId: "usr_dynamic", channel: "slack", target: "U999" }),
      expect.objectContaining({ userId: "usr_dynamic", channel: "discord", target: "888" }),
      expect.objectContaining({
        userId: "usr_dynamic",
        channel: "email",
        target: "slackuser@example.com",
      }),
    ]);
  });

  it("addContact batch support", async () => {
    const req = createMockReq([
      { channel: "webhook", target: "https://example.com/webhook" },
      { channel: "telegram", target: "12345678" },
    ]);
    const res = createMockRes();
    const ctx = { params: { id: "usr_456" }, query: new URLSearchParams() };

    await handlers.addContact(req, res, { ...ctx, projectId: "test_project_id" } as any);

    expect(res.statusCode).toBe(201);
    expect(deps.contactRepo.upsertMany).toHaveBeenCalledWith("test_project_id", [
      expect.objectContaining({
        userId: "usr_456",
        channel: "webhook",
        target: "https://example.com/webhook",
      }),
      expect.objectContaining({
        userId: "usr_456",
        channel: "telegram",
        target: "12345678",
      }),
    ]);
  });

  it("deleteContact (deleteUserContact)", async () => {
    const req = createMockReq({});
    const res = createMockRes();
    const ctx = {
      params: { id: "usr_456", channel: "sms", target: "+1987654321" },
      query: new URLSearchParams(),
    };

    await handlers.deleteContact(req, res, { ...ctx, projectId: "test_project_id" } as any);

    expect(res.statusCode).toBe(204);
    expect(deps.contactRepo.delete).toHaveBeenCalledWith(
      "test_project_id",
      "usr_456",
      "sms",
      "+1987654321",
    );
  });

  it("notify (inline user with schedule)", async () => {
    const req = createMockReq({
      user: {
        id: "usr_123",
        email: "aanya@example.com",
        pushToken: "ExponentPushToken[123]",
        segments: ["churn-risk"],
      },
      template: "order-shipped",
      data: { name: "Aanya", tracking: "1Z999AA" },
      channels: ["email", "push"],
      fallback: true,
      sendAt: "2026-12-31T23:59:59Z",
    });
    const res = createMockRes();

    await handlers.notify(req, res, {
      projectId: "test_project_id",
      params: {},
      query: new URLSearchParams(),
    } as any);

    expect(res.statusCode).toBe(202);
    // User should be upserted inline
    expect(deps.userRepo.upsertManyFull).toHaveBeenCalledWith("test_project_id", [
      expect.objectContaining({ userId: "usr_123" }),
    ]);
    expect(deps.producers.normal!.publishBatch).toHaveBeenCalled();
  });

  it("notify (segment)", async () => {
    const req = createMockReq({
      segment: "premium-tier",
      template: "weekly-digest",
      channels: ["email"],
    });
    const res = createMockRes();

    await handlers.notify(req, res, {
      projectId: "test_project_id",
      params: {},
      query: new URLSearchParams(),
    } as any);

    expect(res.statusCode).toBe(202);
    expect(deps.producers.normal!.publishBatch).toHaveBeenCalled();
    const publishedPayload = JSON.parse(res.body);
    expect(publishedPayload.target.type).toBe("segment");
    expect(publishedPayload.target.segment).toBe("premium-tier");
  });

  it("notify (topic)", async () => {
    const req = createMockReq({
      topic: "marketing",
      template: "weekly-digest",
      channels: ["email"],
    });
    const res = createMockRes();

    await handlers.notify(req, res, {
      projectId: "test_project_id",
      params: {},
      query: new URLSearchParams(),
    } as any);

    expect(res.statusCode).toBe(202);
    expect(deps.producers.normal!.publishBatch).toHaveBeenCalled();
    const publishedPayload = JSON.parse(res.body);
    expect(publishedPayload.target.type).toBe("topic");
    expect(publishedPayload.target.topic).toBe("marketing");
  });

  it("notify (batch/campaign array of users)", async () => {
    const req = createMockReq({
      user: ["usr_1", "usr_2", "usr_3"],
      template: "black-friday-sale",
      channels: ["email"],
    });
    const res = createMockRes();

    await handlers.notify(req, res, {
      projectId: "test_project_id",
      params: {},
      query: new URLSearchParams(),
    } as any);

    expect(res.statusCode).toBe(202);
    expect(deps.producers.normal!.publishBatch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(res.body);
    expect(body.batchSize).toBe(3);
    expect(body.messageIds).toHaveLength(3);
    expect(body.notificationIdsBase).toBeDefined();
  });

  it("dispatches directly to outboundProducers when priority is critical and recipient is inline (Approach B transactional fast-path)", async () => {
    const mockOutboundProducers = {
      critical: {
        publishBatch: vi.fn().mockResolvedValue({ messageIds: ["fast-msg-1"] }),
      },
    };

    const fastDeps: any = {
      ...deps,
      outboundProducers: mockOutboundProducers,
      templateCache: {
        getCachedTemplate: vi.fn().mockResolvedValue({
          id: "urgent-alert",
          content: { subject: "Security Alert: {{code}}" },
        }),
      },
    };
    const fastHandlers = createHandlers(fastDeps);

    const req = createMockReq({
      user: {
        id: "usr_fast_1",
        email: "security@example.com",
      },
      template: "urgent-alert",
      priority: "critical",
      channels: ["email"],
      data: { code: "123456" },
    });
    const res = createMockRes();

    await fastHandlers.notify(req, res, {
      projectId: "test_project_id",
      params: {},
      query: new URLSearchParams(),
    } as any);

    expect(res.statusCode).toBe(202);
    // Bypasses standard inbound producers
    expect(deps.producers.critical!.publishBatch).not.toHaveBeenCalled();
    // Directly hits outbound critical producer
    expect(mockOutboundProducers.critical.publishBatch).toHaveBeenCalledTimes(1);

    const publishedArg = (mockOutboundProducers.critical.publishBatch as any).mock.calls[0][0][0];
    expect(publishedArg.type).toBe("notification.dispatched");
    expect(publishedArg.payload.destination).toBe("security@example.com");
    expect(publishedArg.payload.channel).toBe("email");
    expect(publishedArg.payload.renderedContent.content.subject).toBe("Security Alert: 123456");
  });

  describe("New CRUD Endpoints", () => {
    it("listWorkflows", async () => {
      const res = createMockRes();
      await handlers.listWorkflows({} as any, res, {
        projectId: "proj_1",
        params: {},
        query: new URLSearchParams(),
      } as any);
      expect(res.statusCode).toBe(200);
      expect(deps.workflowRepo.listDefinitions).toHaveBeenCalledWith("proj_1");
    });

    it("getWorkflow", async () => {
      deps.workflowRepo.getInstance = vi.fn().mockResolvedValue({ id: "wf_1" });
      const res = createMockRes();
      await handlers.getWorkflow({} as any, res, {
        projectId: "proj_1",
        params: { id: "wf_1" },
        query: new URLSearchParams(),
      } as any);
      expect(res.statusCode).toBe(200);
      expect(deps.workflowRepo.getInstance).toHaveBeenCalledWith("proj_1", "wf_1");
    });

    it("listUsers", async () => {
      deps.userRepo.list = vi.fn().mockResolvedValue({ users: [{ id: "u_1" }], nextCursor: null });
      const res = createMockRes();
      await handlers.listUsers({} as any, res, {
        projectId: "proj_1",
        params: {},
        query: new URLSearchParams("limit=10"),
      } as any);
      expect(res.statusCode).toBe(200);
      expect(deps.userRepo.list).toHaveBeenCalledWith("proj_1", 10, undefined, undefined);
    });

    it("listProjects", async () => {
      const res = createMockRes();
      await handlers.listProjects({} as any, res, {
        projectId: "proj_1",
        params: {},
        query: new URLSearchParams(),
      } as any);
      expect(res.statusCode).toBe(200);
      expect(deps.projectRepo.list).toHaveBeenCalled();
    });

    it("updateProject", async () => {
      const req = createMockReq({ rateLimitRpm: 1000 });
      const res = createMockRes();
      await handlers.updateProject(req, res, {
        projectId: "proj_1",
        params: { id: "proj_1" },
        query: new URLSearchParams(),
      } as any);
      expect(res.statusCode).toBe(200);
      expect(deps.projectRepo.updateSettings).toHaveBeenCalledWith("proj_1", {
        rateLimitRpm: 1000,
      });
    });

    it("deleteProject", async () => {
      const res = createMockRes();
      await handlers.deleteProject({} as any, res, {
        projectId: "proj_1",
        params: { id: "proj_1" },
        query: new URLSearchParams(),
      } as any);
      expect(res.statusCode).toBe(204);
      expect(deps.projectRepo.delete).toHaveBeenCalledWith("proj_1");
    });

    it("createProjectKey", async () => {
      const req = createMockReq({});
      const res = createMockRes();
      (deps.projectRepo.createApiKey as any).mockResolvedValue({ id: "key_1" });
      await handlers.createProjectKey(req, res, {
        projectId: "proj_1",
        params: { id: "proj_1" },
        query: new URLSearchParams(),
      } as any);
      expect(res.statusCode).toBe(201);
      expect(deps.projectRepo.createApiKey).toHaveBeenCalled();
      const body = JSON.parse(res.body);
      expect(body.apiKey).toMatch(/^nk_live_/);
    });

    it("listProjectKeys", async () => {
      const res = createMockRes();
      (deps.projectRepo.listApiKeys as any).mockResolvedValue([{ id: "key_1", role: "admin" }]);
      await handlers.listProjectKeys({ method: "GET" } as any, res, {
        projectId: "proj_1",
        params: { id: "proj_1" },
        query: new URLSearchParams(),
      } as any);
      expect(res.statusCode).toBe(200);
      expect(deps.projectRepo.listApiKeys).toHaveBeenCalledWith("proj_1");
    });

    it("deleteProjectKey", async () => {
      const res = createMockRes();
      (deps.projectRepo.deleteApiKey as any).mockResolvedValue(true);
      await handlers.deleteProjectKey({ method: "DELETE" } as any, res, {
        projectId: "proj_1",
        params: { id: "proj_1", keyId: "key_1" },
        query: new URLSearchParams(),
      } as any);
      expect(res.statusCode).toBe(204);
      expect(deps.projectRepo.deleteApiKey).toHaveBeenCalledWith("proj_1", "key_1");
    });

    it("deleteProjectKey returns 404 if key does not exist", async () => {
      const res = createMockRes();
      (deps.projectRepo.deleteApiKey as any).mockResolvedValue(false);
      await handlers.deleteProjectKey({ method: "DELETE" } as any, res, {
        projectId: "proj_1",
        params: { id: "proj_1", keyId: "key_ghost" },
        query: new URLSearchParams(),
      } as any);
      expect(res.statusCode).toBe(404);
    });

    it("listSegments", async () => {
      const res = createMockRes();
      await handlers.listSegments({} as any, res, {
        projectId: "proj_1",
        params: {},
        query: new URLSearchParams(),
      } as any);
      expect(res.statusCode).toBe(200);
      expect(deps.segmentRepo.listSegments).toHaveBeenCalledWith("proj_1");
    });

    it("getTemplate returns 200 with template data", async () => {
      deps.templateRepo.findById = vi.fn().mockResolvedValue({ id: "tpl_1", channel: "email" });
      const res = createMockRes();
      await handlers.getTemplate({} as any, res, {
        projectId: "proj_1",
        params: { id: "tpl_1" },
        query: new URLSearchParams(),
      } as any);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ id: "tpl_1", channel: "email" });
    });

    it("getTemplate returns 404 if template not found", async () => {
      deps.templateRepo.findById = vi.fn().mockResolvedValue(null);
      const res = createMockRes();
      await handlers.getTemplate({} as any, res, {
        projectId: "proj_1",
        params: { id: "tpl_ghost" },
        query: new URLSearchParams(),
      } as any);
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({ error: "template_not_found" });
    });

    it("deleteTemplate returns 204 when deleted", async () => {
      deps.templateRepo.delete = vi.fn().mockResolvedValue(true);
      const res = createMockRes();
      await handlers.deleteTemplate({} as any, res, {
        projectId: "proj_1",
        params: { id: "tpl_1" },
        query: new URLSearchParams(),
      } as any);
      expect(res.statusCode).toBe(204);
      expect(deps.templateRepo.delete).toHaveBeenCalledWith("proj_1", "tpl_1");
    });

    it("deleteTemplate returns 404 when template not found", async () => {
      deps.templateRepo.delete = vi.fn().mockResolvedValue(false);
      const res = createMockRes();
      await handlers.deleteTemplate({} as any, res, {
        projectId: "proj_1",
        params: { id: "tpl_ghost" },
        query: new URLSearchParams(),
      } as any);
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({ error: "template_not_found" });
    });

    it("getUserContacts", async () => {
      deps.contactRepo.findByUserId = vi
        .fn()
        .mockResolvedValue([{ channel: "email", target: "foo@bar.com" }]);
      const res = createMockRes();
      await handlers.getUserContacts({} as any, res, {
        projectId: "proj_1",
        params: { id: "u_1" },
        query: new URLSearchParams(),
      } as any);
      expect(res.statusCode).toBe(200);
      expect(deps.contactRepo.findByUserId).toHaveBeenCalledWith("proj_1", "u_1");
    });

    it("getNotificationLogs with filters", async () => {
      (deps.db as any).query = vi.fn().mockResolvedValue({
        rows: [],
      });
      const res = createMockRes();
      await handlers.getNotificationLogs({} as any, res, {
        projectId: "proj_1",
        params: {},
        query: new URLSearchParams("cursor=1710000000000&templateId=tpl-1"),
      } as any);
      expect(res.statusCode).toBe(200);
    });

    it("getEventsStream", async () => {
      const res = createMockRes();
      res.writeHead = vi.fn();
      res.write = vi.fn();

      const req = {
        on: vi.fn(),
      } as any;

      await handlers.getEventsStream(req, res, {
        projectId: "proj_1",
        params: {},
        query: new URLSearchParams(),
      } as any);

      expect(res.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "Content-Type": "text/event-stream",
        }),
      );
      expect(req.on).toHaveBeenCalledWith("close", expect.any(Function));
    });

    describe("cancelNotification", () => {
      it("returns 400 when taskId param is missing", async () => {
        const res = createMockRes();
        await handlers.cancelNotification({} as any, res, {
          projectId: "proj_1",
          params: {},
          query: new URLSearchParams(),
        } as any);
        expect(res.statusCode).toBe(400);
      });

      it("returns 404 when task is not found in scheduled payloads", async () => {
        const res = createMockRes();
        deps.db.select = vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        });

        await handlers.cancelNotification({} as any, res, {
          projectId: "proj_1",
          params: { taskId: "task_1" },
          query: new URLSearchParams(),
        } as any);

        expect(res.statusCode).toBe(404);
      });

      it("enforces cross-tenant isolation by returning 404 if task belongs to another project", async () => {
        const res = createMockRes();
        deps.db.select = vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ payload: { projectId: "other_project" } }]),
            }),
          }),
        });

        await handlers.cancelNotification({} as any, res, {
          projectId: "proj_1",
          params: { taskId: "task_other" },
          query: new URLSearchParams(),
        } as any);

        expect(res.statusCode).toBe(404);
        expect(deps.db.delete).not.toHaveBeenCalled();
      });

      it("successfully deletes scheduled payload and emits cancellation event for own project", async () => {
        const res = createMockRes();
        deps.db.select = vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ payload: { projectId: "proj_1" } }]),
            }),
          }),
        });
        deps.db.delete = vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ taskId: "task_1" }]),
          }),
        });

        await handlers.cancelNotification({} as any, res, {
          projectId: "proj_1",
          params: { taskId: "task_1" },
          query: new URLSearchParams(),
        } as any);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ success: true });
      });
    });

    describe("ingestEvent", () => {
      it("rejects expired webhook events based on x-timestamp and x-expiry headers", async () => {
        const oldTimestamp = new Date(Date.now() - 60_000).toISOString(); // 60s ago
        const req = {
          headers: {
            "x-timestamp": oldTimestamp,
            "x-expiry": "10", // 10s expiry
          },
          on: vi.fn((event: string, cb: any) => {
            if (event === "data")
              cb(Buffer.from(JSON.stringify({ name: "order.paid", properties: {} })));
            if (event === "end") cb();
          }),
        } as any;
        const res = createMockRes();

        await handlers.ingestEvent(req, res, {
          projectId: "proj_1",
          params: {},
          query: new URLSearchParams(),
        } as any);

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body)).toEqual({
          error: "event_expired",
          message: "Webhook event is expired",
        });
      });

      it("publishes valid event to events producer", async () => {
        const req = createMockReq({ name: "order.paid", properties: { orderId: "123" } });
        const res = createMockRes();
        deps.producers.events = {
          publish: vi.fn().mockResolvedValue("msg_evt_1"),
        } as any;

        await handlers.ingestEvent(req, res, {
          projectId: "proj_1",
          params: {},
          query: new URLSearchParams(),
        } as any);

        expect(res.statusCode).toBe(202);
        expect(deps.producers.events!.publish).toHaveBeenCalled();
        const body = JSON.parse(res.body);
        expect(body.messageId).toBe("msg_evt_1");
        expect(body.eventId).toBeDefined();
      });
    });

    describe("triggerWorkflow", () => {
      it("publishes workflow.triggered and returns 202 with instanceId", async () => {
        const req = createMockReq({ name: "onboarding", input: { userId: "usr_1" } });
        const res = createMockRes();
        deps.producers.workflow = {
          publish: vi.fn().mockResolvedValue("msg_wf_1"),
        } as any;

        await handlers.triggerWorkflow(req, res, {
          projectId: "proj_1",
          params: {},
          query: new URLSearchParams(),
        } as any);

        expect(res.statusCode).toBe(202);
        expect(deps.producers.workflow!.publish).toHaveBeenCalled();
        const body = JSON.parse(res.body);
        expect(body.messageId).toBe("msg_wf_1");
        expect(body.instanceId).toBeDefined();
      });
    });

    describe("getNotificationStatus", () => {
      it("returns 404 when no logs are found", async () => {
        const res = createMockRes();
        deps.db.select = vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        });

        await handlers.getNotificationStatus({} as any, res, {
          projectId: "proj_1",
          params: { taskId: "unknown_task" },
          query: new URLSearchParams(),
        } as any);

        expect(res.statusCode).toBe(404);
      });

      it("returns latest status and full log history when found", async () => {
        const res = createMockRes();
        deps.db.select = vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([
                { status: "delivered", timestamp: new Date() },
                { status: "dispatched", timestamp: new Date(Date.now() - 1000) },
              ]),
            }),
          }),
        });

        await handlers.getNotificationStatus({} as any, res, {
          projectId: "proj_1",
          params: { taskId: "task_1" },
          query: new URLSearchParams(),
        } as any);

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.status).toBe("delivered");
        expect(body.logs).toHaveLength(2);
      });
    });

    describe("listTemplates and listWorkflows filtering/limits", () => {
      it("filters templates by channel and applies limit", async () => {
        const res = createMockRes();
        deps.templateRepo.list = vi.fn().mockResolvedValue([
          { id: "t1", channel: "email", topics: ["marketing"] },
          { id: "t2", channel: "sms", topics: ["alerts"] },
          { id: "t3", channel: "email", topics: ["transactional"] },
        ]);

        await handlers.listTemplates({} as any, res, {
          projectId: "proj_1",
          params: {},
          query: { channel: "email", limit: "1" },
        } as any);

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.templates).toHaveLength(1);
        expect(body.templates[0].id).toBe("t1");
      });

      it("applies limit to listWorkflows", async () => {
        const res = createMockRes();
        deps.workflowRepo.listDefinitions = vi
          .fn()
          .mockResolvedValue([{ name: "wf1" }, { name: "wf2" }, { name: "wf3" }]);

        await handlers.listWorkflows({} as any, res, {
          projectId: "proj_1",
          params: {},
          query: { limit: "2" },
        } as any);

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.workflows).toHaveLength(2);
      });

      it("paginates scheduled messages with nextCursor", async () => {
        const res = createMockRes();
        deps.db.select = vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  { taskId: "task_1", payload: { channel: "email" } },
                  { taskId: "task_2", payload: { channel: "email" } },
                  { taskId: "task_3", payload: { channel: "email" } }, // limit+1 item
                ]),
              }),
            }),
          }),
        });

        await handlers.getScheduledMessages({} as any, res, {
          projectId: "proj_1",
          params: {},
          query: { limit: "2" },
        } as any);

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.scheduled).toHaveLength(2);
        expect(body.nextCursor).toBe("task_2");
      });
    });

    describe("triggerWorkflow", () => {
      it("triggers a workflow with string user id", async () => {
        const req = createMockReq({
          name: "onboarding",
          user: "usr_123",
          input: { plan: "enterprise" },
        });
        const res = createMockRes();

        await handlers.triggerWorkflow(req, res, {
          projectId: "proj_1",
          params: {},
          query: new URLSearchParams(),
        } as any);

        expect(res.statusCode).toBe(202);
        const body = JSON.parse(res.body);
        expect(body.instanceId).toBeDefined();
        expect(body.messageId).toBe("msg-wf-123");
        expect(deps.producers.workflow!.publish).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "workflow.triggered",
            payload: expect.objectContaining({
              name: "onboarding",
              projectId: "proj_1",
              input: expect.objectContaining({ user: { id: "usr_123" }, plan: "enterprise" }),
            }),
          }),
        );
      });

      it("triggers a workflow with inline user profile and syncs user record", async () => {
        const req = createMockReq({
          name: "onboarding",
          user: {
            id: "usr_inline",
            email: "inline@example.com",
            phone: "+15551234567",
            timezone: "America/New_York",
          },
          input: { welcomeBonus: true },
        });
        const res = createMockRes();

        await handlers.triggerWorkflow(req, res, {
          projectId: "proj_1",
          params: {},
          query: new URLSearchParams(),
        } as any);

        expect(res.statusCode).toBe(202);
        expect(deps.userRepo.upsertManyFull).toHaveBeenCalledWith(
          "proj_1",
          expect.arrayContaining([
            expect.objectContaining({
              userId: "usr_inline",
              timezone: "America/New_York",
            }),
          ]),
        );
      });

      it("returns 400 validation error when name is missing", async () => {
        const req = createMockReq({
          user: "usr_123",
        });
        const res = createMockRes();

        await handlers.triggerWorkflow(req, res, {
          projectId: "proj_1",
          params: {},
          query: new URLSearchParams(),
        } as any);

        expect(res.statusCode).toBe(400);
        expect(deps.producers.workflow!.publish).not.toHaveBeenCalled();
      });
    });
  });
});

import { Router } from "@/services/api/router.js";

describe("Router param decoding", () => {
  it("extracts URL parameters into ctx.params and decodes them", () => {
    const router = new Router();
    const handler = vi.fn();
    router.get("/v1/users/:userId/contacts/:channel/:target", handler);

    // Using encoded spaces and special characters
    const result = router.match("GET", "/v1/users/user%201/contacts/email/test%40example.com");
    expect(result).not.toBeNull();
    expect(result?.params).toEqual({
      userId: "user 1",
      channel: "email",
      target: "test@example.com",
    });
  });

  it("supports POST, PATCH, PUT, and DELETE route registrations", () => {
    const router = new Router();
    const postH = vi.fn();
    const patchH = vi.fn();
    const putH = vi.fn();
    const deleteH = vi.fn();

    router.post("/v1/items", postH);
    router.patch("/v1/items/:id", patchH);
    router.put("/v1/items/:id", putH);
    router.delete("/v1/items/:id", deleteH);

    expect(router.match("POST", "/v1/items")?.handler).toBe(postH);
    expect(router.match("PATCH", "/v1/items/1")?.handler).toBe(patchH);
    expect(router.match("PUT", "/v1/items/2")?.handler).toBe(putH);
    expect(router.match("DELETE", "/v1/items/3")?.handler).toBe(deleteH);
  });

  it("follows first-match-wins precedence for overlapping routes", () => {
    const router = new Router();
    const specificHandler = vi.fn();
    const paramHandler = vi.fn();

    router.get("/v1/users/me", specificHandler);
    router.get("/v1/users/:userId", paramHandler);

    const matchMe = router.match("GET", "/v1/users/me");
    expect(matchMe?.handler).toBe(specificHandler);
    expect(matchMe?.params).toEqual({});

    const matchOther = router.match("GET", "/v1/users/other");
    expect(matchOther?.handler).toBe(paramHandler);
    expect(matchOther?.params).toEqual({ userId: "other" });
  });

  it("handles multiple sequential and leading/trailing slashes correctly", () => {
    const router = new Router();
    const handler = vi.fn();
    router.get("/v1/projects/:projectId", handler);

    const match = router.match("GET", "///v1///projects///prj-123///");
    expect(match).not.toBeNull();
    expect(match?.handler).toBe(handler);
    expect(match?.params).toEqual({ projectId: "prj-123" });
  });

  it("returns null if route segments mismatch", () => {
    const router = new Router();
    const handler = vi.fn();
    router.get("/v1/users/:id", handler);

    expect(router.match("GET", "/v1/users")).toBeNull();
    expect(router.match("GET", "/v1/users/123/extra")).toBeNull();
    expect(router.match("POST", "/v1/users/123")).toBeNull();
  });

  it("handles malformed URI parameters gracefully without throwing", () => {
    const router = new Router();
    const handler = vi.fn();
    router.get("/v1/users/:id", handler);

    expect(router.match("GET", "/v1/users/%FF")).toBeNull();
    expect(router.match("GET", "/v1/users/%c0%af")).toBeNull();
  });
});

describe("API Rate Limiting - Sliding Window Counter", () => {
  it("exports valid window size and Lua script", () => {
    expect(API_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(typeof LUA_SLIDING_WINDOW_COUNTER).toBe("string");
    expect(LUA_SLIDING_WINDOW_COUNTER).toContain("INCR");
    expect(LUA_SLIDING_WINDOW_COUNTER).toContain("EXPIRE");
    expect(LUA_SLIDING_WINDOW_COUNTER).toContain("math.floor(prevCount * weight + currentCount)");
  });

  describe("calculateSlidingWindow", () => {
    it("returns only currentCount when now is at the start of a window (weight = 1.0 on previous)", () => {
      // At nowMs = 60_000 (start of window 1), weight = (60000 - 0) / 60000 = 1.0
      const count = calculateSlidingWindow(60_000, 60_000, 5, 20);
      expect(count).toBe(25); // 20 * 1.0 + 5
    });

    it("weights previous window count proportionally across window progression", () => {
      // At 30s into a 60s window, previous count weight is 50%
      const halfwayCount = calculateSlidingWindow(90_000, 60_000, 10, 100);
      expect(halfwayCount).toBe(60); // floor(100 * 0.5) + 10 = 60

      // At 45s into a 60s window, previous count weight is 25%
      const threeQuarterCount = calculateSlidingWindow(105_000, 60_000, 10, 100);
      expect(threeQuarterCount).toBe(35); // floor(100 * 0.25) + 10 = 35

      // At 59s into a 60s window, previous count weight is ~1.67%
      const endCount = calculateSlidingWindow(119_000, 60_000, 10, 100);
      expect(endCount).toBe(11); // floor(100 * (1/60)) + 10 = 1 + 10 = 11
    });

    it("handles zero previous count correctly", () => {
      const count = calculateSlidingWindow(15_000, 60_000, 8, 0);
      expect(count).toBe(8);
    });

    it("handles invalid windowMs safely", () => {
      expect(calculateSlidingWindow(15_000, 0, 8, 10)).toBe(0);
      expect(calculateSlidingWindow(15_000, -100, 8, 10)).toBe(0);
    });
  });

  describe("Lua script behavior simulation", () => {
    function simulateLua(
      store: Map<string, { value: number; ttl: number }>,
      keys: string[],
      argv: (string | number)[],
    ): number {
      const currentKey = keys[0]!;
      const prevKey = keys[1];
      const now = Number(argv[0]);
      const window = Number(argv[1]);
      const maxReqs = Number(argv[2]);
      const ttl = argv[3] ? Number(argv[3]) : Math.ceil((window * 2) / 1000) + 60;

      if (!now || !window || window <= 0 || !maxReqs || maxReqs <= 0) {
        return -1;
      }

      let cKey = currentKey;
      let pKey = prevKey;
      if (!pKey) {
        const currentBucket = Math.floor(now / window);
        const prevBucket = currentBucket - 1;
        cKey = `${keys[0]}:${currentBucket}`;
        pKey = `${keys[0]}:${prevBucket}`;
      }

      const currentCount = store.get(cKey)?.value ?? 0;
      const prevCount = store.get(pKey)?.value ?? 0;

      const timeIntoCurrent = now % window;
      const weight = (window - timeIntoCurrent) / window;
      const estimated = Math.floor(prevCount * weight + currentCount);

      if (estimated < maxReqs) {
        const item = store.get(cKey) ?? { value: 0, ttl: 0 };
        item.value += 1;
        if (item.value === 1) {
          item.ttl = ttl;
        }
        store.set(cKey, item);
        return estimated + 1;
      }

      return -1;
    }

    it("increments within limit and sets TTL on first entry", () => {
      const store = new Map<string, { value: number; ttl: number }>();
      const currentKey = "{rate-limit:api:req:proj1}:10";
      const prevKey = "{rate-limit:api:req:proj1}:9";

      const res1 = simulateLua(store, [currentKey, prevKey], [600_000, 60_000, 5]);
      expect(res1).toBe(1);
      expect(store.get(currentKey)?.value).toBe(1);
      expect(store.get(currentKey)?.ttl).toBe(180);

      const res2 = simulateLua(store, [currentKey, prevKey], [601_000, 60_000, 5]);
      expect(res2).toBe(2);
      expect(store.get(currentKey)?.value).toBe(2);
    });

    it("rejects when limit is reached", () => {
      const store = new Map<string, { value: number; ttl: number }>();
      const currentKey = "{rate-limit:api:req:proj1}:10";
      const prevKey = "{rate-limit:api:req:proj1}:9";

      for (let i = 0; i < 3; i++) {
        const res = simulateLua(store, [currentKey, prevKey], [600_000, 60_000, 3]);
        expect(res).toBe(i + 1);
      }

      const rejected = simulateLua(store, [currentKey, prevKey], [600_500, 60_000, 3]);
      expect(rejected).toBe(-1);
      expect(store.get(currentKey)?.value).toBe(3);
    });

    it("computes keys automatically if only base key is provided", () => {
      const store = new Map<string, { value: number; ttl: number }>();
      const baseKey = "rate-limit:api:req:proj1";

      const res = simulateLua(store, [baseKey], [120_000, 60_000, 5]);
      expect(res).toBe(1);
      expect(store.has("rate-limit:api:req:proj1:2")).toBe(true);
    });
  });
});
