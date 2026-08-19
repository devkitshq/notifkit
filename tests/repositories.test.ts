import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createDatabase, runMigrations } from "@/db/index.js";
import { UserRepository, ContactRepository, TemplateRepository } from "@/repositories/index.js";
import { projects } from "@/db/schema.js";

// Integration tests use testcontainers for a real postgres instance.
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";

describe("Repositories (Integration)", () => {
  let container: any;
  let sql: any;
  let db: any;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const result = createDatabase({ url: container.getConnectionUri() });
    sql = result.sql;
    db = result.db;

    await runMigrations(db);

    await db.insert(projects).values([
      { id: PROJECT_ID, name: "Test Project", apiKeyHash: "hash-a" },
      { id: OTHER_PROJECT_ID, name: "Other Project", apiKeyHash: "hash-b" },
    ]);
  }, 120000); // Allow 2 minutes for container download

  afterAll(async () => {
    if (sql) await sql.end();
    if (container) await container.stop();
  });

  it("inserts and retrieves a user using UserRepository", async () => {
    const userRepo = new UserRepository(db);

    await userRepo.upsertFull(PROJECT_ID, {
      userId: "u1",
      email: "test@example.com",
      segments: ["seg1", "seg2"],
      preferences: { channels: { email: true } },
    });

    const user = await userRepo.findRecordById(PROJECT_ID, "u1");
    expect(user).toBeDefined();
    expect(user?.userId).toBe("u1");
    expect(user?.email).toBe("test@example.com");
    expect(user?.segments).toEqual(expect.arrayContaining(["seg1", "seg2"]));
  });

  it("updates partial preferences using UserRepository", async () => {
    const userRepo = new UserRepository(db);

    await userRepo.updatePartial(PROJECT_ID, "u1", {
      preferences: { topics: { marketing: false } },
    });

    const user = await userRepo.findRecordById(PROJECT_ID, "u1");
    expect(user?.preferences.topics?.marketing).toBe(false);
  });

  it("scopes user lookups to the owning project", async () => {
    const userRepo = new UserRepository(db);

    expect(await userRepo.findRecordById(OTHER_PROJECT_ID, "u1")).toBeNull();
    expect(await userRepo.findById(OTHER_PROJECT_ID, "u1")).toBeNull();
    expect(await userRepo.delete(OTHER_PROJECT_ID, "u1")).toBe(false);
    // Still present for its real owner.
    expect(await userRepo.findById(PROJECT_ID, "u1")).not.toBeNull();
  });

  it("inserts and deletes a contact using ContactRepository", async () => {
    const contactRepo = new ContactRepository(db);

    await contactRepo.upsert(PROJECT_ID, "u1", "email", "test@example.com");

    const contacts = await contactRepo.findByUserId(PROJECT_ID, "u1");
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.target).toBe("test@example.com");

    // A different tenant can neither see nor delete it.
    expect(await contactRepo.findByUserId(OTHER_PROJECT_ID, "u1")).toEqual([]);
    expect(await contactRepo.delete(OTHER_PROJECT_ID, "u1", "email", "test@example.com")).toBe(
      false,
    );
  });

  it("upserts and retrieves templates using TemplateRepository", async () => {
    const templateRepo = new TemplateRepository(db);

    const insertedCount = await templateRepo.upsertMany(PROJECT_ID, [
      {
        id: "welcome-email",
        channel: "email",
        topics: ["marketing"],
        content: { subject: "Welcome!", text: "Hi {{name}}" },
        aiPrompts: { summary: "Summarize this email" },
      },
      {
        id: "alert-sms",
        channel: "sms",
        topics: ["alerts"],
        content: { text: "Alert!" },
        aiPrompts: null,
      },
    ]);

    expect(insertedCount).toBe(2);

    const templates = await templateRepo.list(PROJECT_ID);
    expect(templates).toHaveLength(2);

    const emailTemplate = await templateRepo.findById(PROJECT_ID, "welcome-email");
    expect(emailTemplate).toBeDefined();
    expect(emailTemplate?.channel).toBe("email");
    expect(emailTemplate?.aiPrompts?.summary).toBe("Summarize this email");

    // Other project shouldn't see it
    const otherTemplates = await templateRepo.list(OTHER_PROJECT_ID);
    expect(otherTemplates).toHaveLength(0);
    expect(await templateRepo.findById(OTHER_PROJECT_ID, "welcome-email")).toBeNull();
  });
});
