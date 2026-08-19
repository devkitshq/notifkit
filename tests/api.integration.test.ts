import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { NotifkitServer } from "@/server.js";
import { createDatabase, runMigrations } from "@/db/index.js";
import supertest from "supertest";

describe("API Integration Tests", () => {
  let pgContainer: any;
  let redisContainer: any;
  let server: NotifkitServer;
  let dbUrl: string;
  let redisUrl: string;
  let sql: any;
  let adminApiKey: string;
  let projectApiKey: string;
  let _projectId: string;

  const PORT = 34567;
  const baseUrl = `http://localhost:${PORT}`;

  beforeAll(async () => {
    adminApiKey = "test-admin-key";
    process.env.ADMIN_API_KEY = adminApiKey;

    pgContainer = await new PostgreSqlContainer("postgres:15-alpine").start();
    redisContainer = await new RedisContainer("redis:alpine").start();

    dbUrl = pgContainer.getConnectionUri();
    redisUrl = redisContainer.getConnectionUrl();

    const dbData = createDatabase({ url: dbUrl });
    sql = dbData.sql;
    await runMigrations(dbData.db);

    server = new NotifkitServer({
      services: ["api"],
      redisUrl,
      databaseUrl: dbUrl,
      logLevel: "silent",
      autoMigrate: false,
      port: PORT,
    });

    await server.start();
  }, 60_000);

  afterAll(async () => {
    try {
      await server?.stop();
    } catch (_e) {}
    try {
      await sql?.end();
    } catch (_e) {}
    try {
      await pgContainer?.stop();
    } catch (_e) {}
    try {
      await redisContainer?.stop();
    } catch (_e) {}
  }, 30_000);

  it("should return health status", async () => {
    const res = await supertest(baseUrl).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("api");
  });

  it("should create a project via admin API", async () => {
    const res = await supertest(baseUrl)
      .post("/v1/projects")
      .set("Authorization", `Bearer ${adminApiKey}`)
      .send({ name: "Integration Test Project" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.apiKey).toBeDefined();
    expect(res.body.apiKey).toMatch(/^nk_live_/);

    _projectId = res.body.id;
    projectApiKey = res.body.apiKey;
  });

  it("should fail to create project without admin key", async () => {
    const res = await supertest(baseUrl).post("/v1/projects").send({ name: "Hacked Project" });

    expect(res.status).toBe(401);
  });

  it("should fail to create project with invalid admin key length", async () => {
    const res = await supertest(baseUrl)
      .post("/v1/projects")
      .set("Authorization", `Bearer short-key`)
      .send({ name: "Hacked Project" });

    expect(res.status).toBe(401);
  });

  it("should fail validation on create project with bad payload", async () => {
    const res = await supertest(baseUrl)
      .post("/v1/projects")
      .set("Authorization", `Bearer ${adminApiKey}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  it("should sync templates using project API key", async () => {
    const res = await supertest(baseUrl)
      .put("/v1/templates")
      .set("Authorization", `Bearer ${projectApiKey}`)
      .send({
        templates: [
          {
            id: "welcome-email",
            channel: "email",
            topic: ["transactional"],
            content: {
              subject: "Welcome to Notifkit!",
              html: "<h1>Welcome!</h1>",
            },
          },
        ],
      });

    expect(res.status).toBe(200);
  });

  it("should fail API requests with invalid API key", async () => {
    const res = await supertest(baseUrl)
      .put("/v1/templates")
      .set("Authorization", `Bearer nk_live_invalidkey`)
      .send({ templates: [] });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("should create a user and contact", async () => {
    const res = await supertest(baseUrl)
      .post("/v1/users")
      .set("Authorization", `Bearer ${projectApiKey}`)
      .send({
        id: "user-123",
        email: ["alice@example.com"],
        segments: ["premium"],
      });

    expect(res.status).toBe(201);
  });

  it("should trigger a notification successfully", async () => {
    const res = await supertest(baseUrl)
      .post("/v1/notify")
      .set("Authorization", `Bearer ${projectApiKey}`)
      .send({
        user: "user-123",
        template: "welcome-email",
        channels: ["email"],
        data: { name: "Alice" },
      });

    expect(res.status).toBe(202);
    expect(res.body.messageId).toBeDefined();
    expect(res.body.notificationId).toBeDefined();
  });

  it("should fail validation on malformed notify payload", async () => {
    const res = await supertest(baseUrl)
      .post("/v1/notify")
      .set("Authorization", `Bearer ${projectApiKey}`)
      .send({
        user: "user-123",
        // missing 'template' which is required
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  // --- 1. Template Management ---
  it("should retrieve all templates", async () => {
    const res = await supertest(baseUrl)
      .get("/v1/templates")
      .set("Authorization", `Bearer ${projectApiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.templates).toBeDefined();
    expect(Array.isArray(res.body.templates)).toBe(true);
    expect(res.body.templates.length).toBeGreaterThan(0);
  });

  it("should retrieve a specific template", async () => {
    const res = await supertest(baseUrl)
      .get("/v1/templates/welcome-email")
      .set("Authorization", `Bearer ${projectApiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("welcome-email");
    expect(res.body.content.subject).toBe("Welcome to Notifkit!");
  });

  // --- 2. User & Contact Management (CRUD) ---
  it("should retrieve a user and their contacts", async () => {
    const res = await supertest(baseUrl)
      .get("/v1/users/user-123")
      .set("Authorization", `Bearer ${projectApiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe("user-123");
    expect(res.body.email).toBe("alice@example.com");
    expect(res.body.contacts).toBeDefined();
  });

  it("should partially update a user", async () => {
    const res = await supertest(baseUrl)
      .patch("/v1/users/user-123")
      .set("Authorization", `Bearer ${projectApiKey}`)
      .send({ language: "fr", timezone: "Europe/Paris" });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("user-123");
  });

  it("should add a new contact channel to a user", async () => {
    const res = await supertest(baseUrl)
      .post("/v1/users/user-123/contacts")
      .set("Authorization", `Bearer ${projectApiKey}`)
      .send({ channel: "sms", target: "+1234567890" });
    expect(res.status).toBe(201);
    expect(res.body.channel).toBe("sms");
  });

  it("should delete a specific contact channel", async () => {
    const res = await supertest(baseUrl)
      .delete("/v1/users/user-123/contacts/sms/+1234567890")
      .set("Authorization", `Bearer ${projectApiKey}`);
    expect(res.status).toBe(204);
  });

  // --- 3. User Preferences ---
  it("should retrieve user preferences", async () => {
    const res = await supertest(baseUrl)
      .get("/v1/users/user-123/preferences")
      .set("Authorization", `Bearer ${projectApiKey}`);
    expect(res.status).toBe(200);
  });

  it("should update user preferences", async () => {
    const res = await supertest(baseUrl)
      .patch("/v1/users/user-123/preferences")
      .set("Authorization", `Bearer ${projectApiKey}`)
      .send({ quietHours: [{ start: "22:00", end: "08:00" }] });
    expect(res.status).toBe(200);
    expect(res.body.preferences.quietHours).toBeDefined();
  });

  it("should delete a user", async () => {
    const res = await supertest(baseUrl)
      .delete("/v1/users/user-123")
      .set("Authorization", `Bearer ${projectApiKey}`);
    expect(res.status).toBe(204);

    const getRes = await supertest(baseUrl)
      .get("/v1/users/user-123")
      .set("Authorization", `Bearer ${projectApiKey}`);
    expect(getRes.status).toBe(404);
  });

  // --- 4. Notification Observability & Lifecycle ---
  let _taskIdForCancel = "";

  it("should fetch notification logs for project", async () => {
    const res = await supertest(baseUrl)
      .get("/v1/notifications/logs?limit=5")
      .set("Authorization", `Bearer ${projectApiKey}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.logs)).toBe(true);
  });

  it("should fail to get notification status for unknown task", async () => {
    const res = await supertest(baseUrl)
      .get("/v1/notifications/unknown-task-id")
      .set("Authorization", `Bearer ${projectApiKey}`);
    expect(res.status).toBe(404);
  });

  it("should fail to cancel an unknown scheduled notification", async () => {
    const res = await supertest(baseUrl)
      .delete("/v1/notifications/unknown-task-id")
      .set("Authorization", `Bearer ${projectApiKey}`);
    expect(res.status).toBe(404);
  });

  // --- 5. Advanced Triggers ---
  it("should trigger a workflow", async () => {
    const res = await supertest(baseUrl)
      .post("/v1/workflows/trigger")
      .set("Authorization", `Bearer ${projectApiKey}`)
      .send({ name: "onboarding", input: { step: 1 } });
    expect(res.status).toBe(202);
    expect(res.body.instanceId).toBeDefined();
  });

  it("should ingest an analytics event", async () => {
    const res = await supertest(baseUrl)
      .post("/v1/events")
      .set("Authorization", `Bearer ${projectApiKey}`)
      .send({ name: "page_view", properties: { url: "/home" } });
    expect(res.status).toBe(202);
    expect(res.body.eventId).toBeDefined();
  });

  // --- 6. Diagnostics ---
  it("should return metrics", async () => {
    const res = await supertest(baseUrl).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.text).toContain("notifkit_messages_published_total");
  });

  it("should return live probe", async () => {
    const res = await supertest(baseUrl).get("/live");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("should return ready probe", async () => {
    const res = await supertest(baseUrl).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
  });
});
