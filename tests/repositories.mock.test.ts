import { describe, it, expect, vi } from "vitest";
import { UserRepository, ContactRepository } from "@/repositories/index.js";

describe("Repositories (Mocked Unit Tests)", () => {
  const makeMockDb = () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      onConflictDoNothing: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      execute: vi.fn().mockReturnThis(),
      transaction: vi.fn(async (cb: any) => cb(db)),
    };
    return db;
  };

  describe("UserRepository", () => {
    it("findById returns user profile when found", async () => {
      const mockDb = makeMockDb();
      mockDb.limit.mockResolvedValueOnce([{ externalId: "u1", attributes: { email: "a@b.c" } }]);

      const repo = new UserRepository(mockDb as any);
      const user = await repo.findById("proj-1", "u1");

      expect(user).toEqual({
        userId: "u1",
        language: undefined,
        timezone: undefined,
        email: "a@b.c",
      });
    });

    it("findById returns null when not found", async () => {
      const mockDb = makeMockDb();
      mockDb.limit.mockResolvedValueOnce([]);

      const repo = new UserRepository(mockDb as any);
      const user = await repo.findById("proj-1", "u1");

      expect(user).toBeNull();
    });

    it("upsertManyFull retries on serialization failure (40001)", async () => {
      const mockDb = makeMockDb();
      const serializationError = new Error("Serialization error");
      (serializationError as any).code = "40001";

      mockDb.transaction
        .mockRejectedValueOnce(serializationError)
        .mockRejectedValueOnce(serializationError)
        .mockResolvedValueOnce("success");

      const repo = new UserRepository(mockDb as any);

      // Should not throw, should retry and succeed on 3rd attempt
      await repo.upsertManyFull("proj-1", [
        { userId: "u1", segments: ["a"] } as any,
        { userId: "u2", preferences: { topics: { promo: false } } } as any,
      ]);

      expect(mockDb.transaction).toHaveBeenCalledTimes(3);
    });

    it("upsertManyFull throws on non-retriable error", async () => {
      const mockDb = makeMockDb();
      const syntaxError = new Error("Syntax error");
      (syntaxError as any).code = "42601"; // Non-transient

      mockDb.transaction.mockRejectedValueOnce(syntaxError);

      const repo = new UserRepository(mockDb as any);

      await expect(repo.upsertManyFull("proj-1", [{ userId: "u1" } as any])).rejects.toThrow(
        "Syntax error",
      );

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    });

    it("upsertManyFull throws if retries exhausted", async () => {
      const mockDb = makeMockDb();
      const serializationError = new Error("Serialization error");
      (serializationError as any).code = "40001";

      mockDb.transaction
        .mockRejectedValueOnce(serializationError)
        .mockRejectedValueOnce(serializationError)
        .mockRejectedValueOnce(serializationError)
        .mockRejectedValueOnce(serializationError); // 4th would fail if it tried, but it stops at 3

      const repo = new UserRepository(mockDb as any);

      await expect(repo.upsertManyFull("proj-1", [{ userId: "u1" } as any])).rejects.toThrow(
        "Serialization error",
      );

      expect(mockDb.transaction).toHaveBeenCalledTimes(3);
    });
  });

  describe("ContactRepository", () => {
    it("upsertMany handles batch insertion", async () => {
      const mockDb = makeMockDb();
      // Mock the select query that fetches internal user IDs
      mockDb.where.mockResolvedValueOnce([{ id: "internal-1", externalId: "usr1" }]);
      // Mock the insert returning
      mockDb.returning.mockResolvedValueOnce([
        { id: "c1", userId: "internal-1", channel: "email", target: "a@b.com" },
      ]);

      const repo = new ContactRepository(mockDb as any);

      await repo.upsertMany("proj-1", [
        { userId: "usr1", channel: "email", target: "a@b.com", preferences: {} },
      ]);

      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.onConflictDoUpdate).toHaveBeenCalled();
    });
  });

  describe("ProjectRepository", () => {
    it("updateSettings modifies project settings", async () => {
      const mockDb = makeMockDb();
      const { ProjectRepository } = await import("../src/repositories/index.js");
      const repo = new ProjectRepository(mockDb as any);
      await repo.updateSettings("proj_1", { rateLimitRpm: 5000 });
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith(expect.objectContaining({ rateLimitRpm: 5000 }));
    });
  });

  describe("WorkflowRepository", () => {
    it("listDefinitions fetches all workflows for a project", async () => {
      const mockDb = makeMockDb();
      mockDb.orderBy.mockResolvedValueOnce([{ name: "wf-1", description: "test" }]);
      const { WorkflowRepository } = await import("../src/repositories/index.js");
      const repo = new WorkflowRepository(mockDb as any);
      const definitions = await repo.listDefinitions("proj_1");
      expect(definitions).toHaveLength(1);
      expect(mockDb.select).toHaveBeenCalled();
    });
  });

  describe("SegmentRepository", () => {
    it("listSegments queries distinct segments from users", async () => {
      const mockDb = makeMockDb();
      mockDb.execute.mockResolvedValueOnce([{ segment: "premium" }, { segment: "free" }]);
      const { SegmentRepository } = await import("../src/repositories/index.js");
      const repo = new SegmentRepository(mockDb as any);
      const segments = await repo.listSegments("proj_1");
      expect(segments).toEqual(["premium", "free"]);
      expect(mockDb.execute).toHaveBeenCalled();
    });
  });
});
