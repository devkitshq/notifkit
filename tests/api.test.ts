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

import { extractAuthToken } from "@/services/api/main.js";

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
      expect(deps.userRepo.list).toHaveBeenCalledWith("proj_1", 10, undefined);
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
});
