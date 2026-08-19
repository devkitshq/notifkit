import { describe, it, expect, beforeEach } from "vitest";
import {
  ContactRepository,
  PreferenceRepository,
  ProjectRepository,
  SegmentRepository,
  TemplateRepository,
  UserRepository,
  WorkflowRepository,
} from "@/repositories/index.js";
import {
  users,
  userContacts,
  contactTopicPreferences,
  projects,
  projectApiKeys,
  templates,
  workflowInstances,
  workflowWaiters,
  suppressions,
  messageLogs,
  userSegments,
  userTopicPreferences,
  userChannelPreferences,
  quietHours,
  workflowDefinitions,
} from "@/db/schema.js";
import { createMockDb, type MockDb } from "./helpers/mock-db.js";

/**
 * Repository methods whose behaviour is more than a query: the row-to-domain
 * mapping, the early exits, and the boolean each caller branches on. Queries
 * themselves are exercised against real Postgres in repositories.test.ts.
 */

describe("Repository mapping and guards", () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  describe("PreferenceRepository", () => {
    it("treats a user with no stored preference as opted in", async () => {
      // Defaulting to opted-out would silently stop every notification for a
      // user who simply never touched their settings.
      mockDb.queueSelect([{ id: "internal-1" }]);
      mockDb.queueSelect([]);
      const repo = new PreferenceRepository(mockDb.db);

      await expect(repo.isOptedIn("proj-1", "usr-1", "digest")).resolves.toBe(true);
    });

    it("honours an explicit opt-out", async () => {
      mockDb.queueSelect([{ id: "internal-1" }]);
      mockDb.queueSelect([{ topic: "digest", enabled: false }]);
      const repo = new PreferenceRepository(mockDb.db);

      await expect(repo.isOptedIn("proj-1", "usr-1", "digest")).resolves.toBe(false);
    });

    it("ignores a preference for a different topic", async () => {
      mockDb.queueSelect([{ id: "internal-1" }]);
      mockDb.queueSelect([{ topic: "marketing", enabled: false }]);
      const repo = new PreferenceRepository(mockDb.db);

      await expect(repo.isOptedIn("proj-1", "usr-1", "digest")).resolves.toBe(true);
    });

    it("returns no preferences for a user this project does not have", async () => {
      mockDb.queueSelect([]);
      const repo = new PreferenceRepository(mockDb.db);

      await expect(repo.findByUserId("proj-1", "ghost")).resolves.toEqual([]);
      // It stopped after failing to resolve the user.
      expect(mockDb.selects).toHaveLength(1);
    });
  });

  describe("ContactRepository.findActiveByUserIds", () => {
    it("returns an empty map without querying for an empty batch", async () => {
      const repo = new ContactRepository(mockDb.db);

      const result = await repo.findActiveByUserIds("proj-1", []);

      expect(result.size).toBe(0);
      expect(mockDb.selects).toHaveLength(0);
    });

    it("keys the map by external user id, which is what the engine looks up by", async () => {
      mockDb.queueSelect([
        { userId: "usr-1", id: "c1", channel: "email", target: "a@example.com", enabled: true },
        { userId: "usr-2", id: "c2", channel: "sms", target: "+15550000000", enabled: true },
      ]);
      const repo = new ContactRepository(mockDb.db);

      const result = await repo.findActiveByUserIds("proj-1", ["usr-1", "usr-2"]);

      expect([...result.keys()]).toEqual(["usr-1", "usr-2"]);
      expect(result.get("usr-1")![0]).toMatchObject({
        id: "c1",
        channel: "email",
        target: "a@example.com",
        active: true,
      });
    });

    it("groups every contact a user has under one key", async () => {
      mockDb.queueSelect([
        { userId: "usr-1", id: "c1", channel: "email", target: "a@example.com", enabled: true },
        { userId: "usr-1", id: "c2", channel: "sms", target: "+15550000000", enabled: true },
      ]);
      const repo = new ContactRepository(mockDb.db);

      const result = await repo.findActiveByUserIds("proj-1", ["usr-1"]);

      expect(result.get("usr-1")).toHaveLength(2);
      expect(result.size).toBe(1);
    });

    it("simply omits a requested user who has no contacts", async () => {
      mockDb.queueSelect([
        { userId: "usr-1", id: "c1", channel: "email", target: "a@example.com", enabled: true },
      ]);
      const repo = new ContactRepository(mockDb.db);

      const result = await repo.findActiveByUserIds("proj-1", ["usr-1", "usr-2"]);

      expect(result.has("usr-2")).toBe(false);
    });

    it("resolves contacts with a single join rather than a query per user", async () => {
      mockDb.queueSelect([]);
      const repo = new ContactRepository(mockDb.db);

      await repo.findActiveByUserIds("proj-1", ["usr-1", "usr-2", "usr-3"]);

      expect(mockDb.selects).toHaveLength(1);
      expect(mockDb.selects[0]!.table).toBe(users);
      expect(mockDb.selects[0]!.chain).toContain("innerJoin");
    });
  });

  describe("ContactRepository.findByUserId", () => {
    it("returns nothing for an unknown user", async () => {
      mockDb.queueSelect([]);
      const repo = new ContactRepository(mockDb.db);

      await expect(repo.findByUserId("proj-1", "ghost")).resolves.toEqual([]);
      expect(mockDb.selects).toHaveLength(1);
    });

    it("skips the topic lookup when the user has no contacts", async () => {
      mockDb.queueSelect([{ id: "internal-1" }]);
      mockDb.queueSelect([]);
      const repo = new ContactRepository(mockDb.db);

      await expect(repo.findByUserId("proj-1", "usr-1")).resolves.toEqual([]);
      expect(mockDb.selects.map((s) => s.table)).toEqual([users, userContacts]);
    });

    it("attaches each contact's topic preferences to that contact", async () => {
      mockDb.queueSelect([{ id: "internal-1" }]);
      mockDb.queueSelect([
        { id: "c1", channel: "email", target: "a@example.com", enabled: true },
        { id: "c2", channel: "sms", target: "+15550000000", enabled: false },
      ]);
      mockDb.queueSelect([
        { contactId: "c1", topic: "marketing", enabled: false },
        { contactId: "c1", topic: "digest", enabled: true },
      ]);
      const repo = new ContactRepository(mockDb.db);

      const contacts = await repo.findByUserId("proj-1", "usr-1");

      expect(mockDb.selects[2]!.table).toBe(contactTopicPreferences);
      expect(contacts[0]!.preferences).toEqual({ topics: { marketing: false, digest: true } });
      // A contact with no rows gets an empty set, not the other contact's.
      expect(contacts[1]!.preferences).toEqual({ topics: {} });
    });

    it("reports a disabled contact as inactive", async () => {
      mockDb.queueSelect([{ id: "internal-1" }]);
      mockDb.queueSelect([{ id: "c1", channel: "email", target: "a@example.com", enabled: false }]);
      mockDb.queueSelect([]);
      const repo = new ContactRepository(mockDb.db);

      const contacts = await repo.findByUserId("proj-1", "usr-1");

      expect(contacts[0]!.active).toBe(false);
    });
  });

  describe("TemplateRepository", () => {
    it("returns null for a template this project does not own", async () => {
      mockDb.queueSelect([]);
      const repo = new TemplateRepository(mockDb.db);

      await expect(repo.findById("proj-1", "welcome")).resolves.toBeNull();
    });

    it("defaults a template with no topics to an empty list", async () => {
      // The engine reads `topics.length` to decide whether mail is bulk, so a
      // null here would throw on the send path.
      mockDb.queueSelect([
        { id: "welcome", channel: "email", content: {}, topics: null, aiPrompts: null },
      ]);
      const repo = new TemplateRepository(mockDb.db);

      const template = await repo.findById("proj-1", "welcome");

      expect(template!.topics).toEqual([]);
    });

    it("maps a listed template the same way it maps a fetched one", async () => {
      mockDb.queueSelect([
        { id: "a", channel: "email", content: { subject: "s" }, topics: ["x"], aiPrompts: null },
      ]);
      const repo = new TemplateRepository(mockDb.db);

      await expect(repo.list("proj-1")).resolves.toEqual([
        { id: "a", channel: "email", content: { subject: "s" }, topics: ["x"], aiPrompts: null },
      ]);
    });

    it("writes nothing and reports zero for an empty sync", async () => {
      const repo = new TemplateRepository(mockDb.db);

      await expect(repo.upsertMany("proj-1", [])).resolves.toBe(0);
      expect(mockDb.inserts).toHaveLength(0);
    });

    it("overwrites an existing template on sync and reports how many were written", async () => {
      const repo = new TemplateRepository(mockDb.db);

      const count = await repo.upsertMany("proj-1", [
        { id: "a", channel: "email", content: {} },
        { id: "b", channel: "sms", content: {}, topics: ["news"] },
      ]);

      expect(count).toBe(2);
      expect(mockDb.inserts[0]!.table).toBe(templates);
      expect(mockDb.inserts[0]!.conflict).toBe("update");
      // A template that arrives without topics is stored as having none.
      expect(mockDb.inserts[0]!.values[0].topics).toEqual([]);
    });

    it("reports whether a delete actually removed anything", async () => {
      const repo = new TemplateRepository(mockDb.db);

      mockDb.queueDelete([{ id: "a" }]);
      await expect(repo.delete("proj-1", "a")).resolves.toBe(true);

      mockDb.queueDelete([]);
      await expect(repo.delete("proj-1", "missing")).resolves.toBe(false);
    });
  });

  describe("ProjectRepository", () => {
    it("returns the throttle overrides for a project", async () => {
      mockDb.queueSelect([{ throttleLimit: 50, throttleWindowHours: 24 }]);
      const repo = new ProjectRepository(mockDb.db);

      await expect(repo.findThrottleSettings("proj-1")).resolves.toEqual({
        throttleLimit: 50,
        throttleWindowHours: 24,
      });
      expect(mockDb.selects[0]!.table).toBe(projects);
      expect(mockDb.selects[0]!.limit).toBe(1);
    });

    it("returns null for a project that does not exist", async () => {
      // The settings cache turns this into "no overrides" — it must not be
      // mistaken for a limit of zero.
      mockDb.queueSelect([]);
      const repo = new ProjectRepository(mockDb.db);

      await expect(repo.findThrottleSettings("ghost")).resolves.toBeNull();
    });

    it("reports whether a settings update matched a row", async () => {
      const repo = new ProjectRepository(mockDb.db);

      mockDb.queueUpdate([{ id: "proj-1" }]);
      await expect(repo.updateSettings("proj-1", { throttleLimit: 10 })).resolves.toBe(true);

      mockDb.queueUpdate([]);
      await expect(repo.updateSettings("ghost", { throttleLimit: 10 })).resolves.toBe(false);
    });

    it("reports whether a project delete matched a row", async () => {
      const repo = new ProjectRepository(mockDb.db);

      mockDb.queueSelect([]); // users lookup
      mockDb.queueDelete([]); // suppressions
      mockDb.queueDelete([]); // messageLogs
      mockDb.queueDelete([]); // workflowInstances
      mockDb.queueDelete([{ id: "proj-1" }]); // projects
      await expect(repo.delete("proj-1")).resolves.toBe(true);

      mockDb.queueSelect([]); // users lookup
      mockDb.queueDelete([]); // suppressions
      mockDb.queueDelete([]); // messageLogs
      mockDb.queueDelete([]); // workflowInstances
      mockDb.queueDelete([]); // projects
      await expect(repo.delete("ghost")).resolves.toBe(false);
    });

    it("cascades deletions across users, contacts, suppressions, logs, and workflows on delete", async () => {
      const repo = new ProjectRepository(mockDb.db);

      // 1. User lookup returns user IDs
      mockDb.queueSelect([{ id: "u-1" }, { id: "u-2" }]);
      // 2. Child user tables deletes (6 deletes)
      for (let i = 0; i < 6; i++) mockDb.queueDelete([]);
      // 3. Project child tables deletes (3 deletes)
      for (let i = 0; i < 3; i++) mockDb.queueDelete([]);
      // 4. Final delete of project returns deleted row
      mockDb.queueDelete([{ id: "proj-1" }]);

      const result = await repo.delete("proj-1");
      expect(result).toBe(true);

      // Verifies child table delete calls
      const deletedTables = mockDb.deletes.map((d) => d.table);
      expect(deletedTables).toContain(userContacts);
      expect(deletedTables).toContain(userSegments);
      expect(deletedTables).toContain(userTopicPreferences);
      expect(deletedTables).toContain(userChannelPreferences);
      expect(deletedTables).toContain(quietHours);
      expect(deletedTables).toContain(users);
      expect(deletedTables).toContain(suppressions);
      expect(deletedTables).toContain(messageLogs);
      expect(deletedTables).toContain(workflowInstances);
      expect(deletedTables).toContain(projects);
    });

    it("stores only the hash of an API key and hands back the new id", async () => {
      mockDb.queueInsert([{ id: "key-1" }]);
      const repo = new ProjectRepository(mockDb.db);

      const created = await repo.createApiKey("proj-1", "sha256-hash", "read_only");

      expect(created).toEqual({ id: "key-1" });
      expect(mockDb.inserts[0]!.table).toBe(projectApiKeys);
      expect(mockDb.inserts[0]!.values).toEqual({
        projectId: "proj-1",
        keyHash: "sha256-hash",
        role: "read_only",
      });
    });

    it("defaults a new API key to admin", async () => {
      mockDb.queueInsert([{ id: "key-1" }]);
      const repo = new ProjectRepository(mockDb.db);

      await repo.createApiKey("proj-1", "sha256-hash");

      expect(mockDb.inserts[0]!.values.role).toBe("admin");
    });

    it("reports whether a key delete matched, so one project cannot revoke another's", async () => {
      const repo = new ProjectRepository(mockDb.db);

      mockDb.queueDelete([]);
      await expect(repo.deleteApiKey("proj-1", "someone-elses-key")).resolves.toBe(false);

      mockDb.queueDelete([{ id: "key-1" }]);
      await expect(repo.deleteApiKey("proj-1", "key-1")).resolves.toBe(true);
    });
  });

  describe("WorkflowRepository", () => {
    it("returns null for an instance in another project, without loading its steps", async () => {
      mockDb.queueSelect([]);
      const repo = new WorkflowRepository(mockDb.db);

      await expect(repo.getInstance("proj-1", "wf-1")).resolves.toBeNull();
      expect(mockDb.selects).toHaveLength(1);
    });

    it("returns the instance with its steps and waiters attached", async () => {
      mockDb.queueSelect([{ id: "wf-1", status: "running" }]);
      mockDb.queueSelect([{ id: "s1" }, { id: "s2" }]);
      mockDb.queueSelect([{ id: "w1" }]);
      const repo = new WorkflowRepository(mockDb.db);

      const instance = await repo.getInstance("proj-1", "wf-1");

      expect(instance).toMatchObject({ id: "wf-1", status: "running" });
      expect(instance.steps).toHaveLength(2);
      expect(instance.waiters).toHaveLength(1);
    });

    it("cancels a running instance and clears what it was waiting on", async () => {
      mockDb.queueUpdate([{ id: "wf-1" }]);
      const repo = new WorkflowRepository(mockDb.db);

      await expect(repo.cancelInstance("proj-1", "wf-1")).resolves.toBe(true);
      // A leftover waiter would resume a workflow that was already canceled.
      expect(mockDb.deletes[0]!.table).toBe(workflowWaiters);
    });

    it("leaves an already-finished instance alone", async () => {
      mockDb.queueUpdate([]);
      const repo = new WorkflowRepository(mockDb.db);

      await expect(repo.cancelInstance("proj-1", "wf-1")).resolves.toBe(false);
      expect(mockDb.deletes).toHaveLength(0);
    });

    it("scopes the cancel to the caller's project", async () => {
      mockDb.queueUpdate([{ id: "wf-1" }]);
      const repo = new WorkflowRepository(mockDb.db);

      await repo.cancelInstance("proj-1", "wf-1");

      expect(mockDb.db.update).toHaveBeenCalledWith(workflowInstances);
    });

    it("lists definitions scoped to the project", async () => {
      mockDb.queueSelect([{ id: "def-1", name: "onboarding", projectId: "proj-1" }]);
      const repo = new WorkflowRepository(mockDb.db);

      const defs = await repo.listDefinitions("proj-1");
      expect(defs).toHaveLength(1);
      expect(defs[0].name).toBe("onboarding");
      expect(mockDb.selects[0]!.table).toBe(workflowDefinitions);
    });
  });

  describe("SegmentRepository", () => {
    it("returns an empty list for a project with no segments", async () => {
      mockDb.db.execute = async () => [];
      const repo = new SegmentRepository(mockDb.db);

      await expect(repo.listSegments("proj-1")).resolves.toEqual([]);
    });

    it("flattens the rows to segment names", async () => {
      mockDb.db.execute = async () => [{ segment: "premium" }, { segment: "trial" }];
      const repo = new SegmentRepository(mockDb.db);

      await expect(repo.listSegments("proj-1")).resolves.toEqual(["premium", "trial"]);
    });
  });

  describe("UserRepository.upsertFull", () => {
    it("upserts user profile, segments, topic preferences, and channel preferences", async () => {
      const repo = new UserRepository(mockDb.db);

      // User upsert returns internal ID
      mockDb.queueSelect([{ id: "int-u1" }]);

      await repo.upsertFull("proj-1", {
        userId: "u1",
        email: "u1@example.com",
        segments: ["beta", "vip"],
        preferences: {
          topics: { news: true, alerts: false },
          channels: { email: true, sms: false },
        },
      });

      const segmentInsert = mockDb.inserts.find((i) => i.table === userSegments);
      expect(segmentInsert).toBeDefined();

      const topicInsert = mockDb.inserts.find((i) => i.table === userTopicPreferences);
      expect(topicInsert).toBeDefined();

      const channelInsert = mockDb.inserts.find((i) => i.table === userChannelPreferences);
      expect(channelInsert).toBeDefined();
    });
  });
});
