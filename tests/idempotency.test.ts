import { describe, it, expect, vi, beforeEach } from "vitest";
import { IdempotencyGuard } from "@/idempotency/index.js";

describe("IdempotencyGuard (src/idempotency/index.ts)", () => {
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = {
      set: vi.fn(),
      get: vi.fn(),
      del: vi.fn(),
    };
  });

  it("checkAndMark returns true on first call and sets key with NX and default TTL", async () => {
    mockRedis.set.mockResolvedValueOnce("OK");
    const guard = new IdempotencyGuard({ redis: mockRedis, keyPrefix: "notif:idem" });

    const result = await guard.checkAndMark("msg-100");

    expect(result).toBe(true);
    expect(mockRedis.set).toHaveBeenCalledWith("notif:idem:msg-100", "1", "EX", 86_400, "NX");
  });

  it("checkAndMark returns false when Redis SET NX returns null (already seen)", async () => {
    mockRedis.set.mockResolvedValueOnce(null);
    const guard = new IdempotencyGuard({ redis: mockRedis, keyPrefix: "notif:idem" });

    const result = await guard.checkAndMark("msg-100");

    expect(result).toBe(false);
    expect(mockRedis.set).toHaveBeenCalledWith("notif:idem:msg-100", "1", "EX", 86_400, "NX");
  });

  it("checkAndMark applies custom TTL when provided", async () => {
    mockRedis.set.mockResolvedValueOnce("OK");
    const guard = new IdempotencyGuard({
      redis: mockRedis,
      keyPrefix: "notif:idem",
      ttlSeconds: 3600,
    });

    const result = await guard.checkAndMark("msg-200", 60);

    expect(result).toBe(true);
    expect(mockRedis.set).toHaveBeenCalledWith("notif:idem:msg-200", "1", "EX", 60, "NX");
  });

  it("markProcessed sets the key unconditionally with given or default TTL", async () => {
    mockRedis.set.mockResolvedValueOnce("OK");
    const guard = new IdempotencyGuard({
      redis: mockRedis,
      keyPrefix: "notif:idem",
      ttlSeconds: 7200,
    });

    await guard.markProcessed("msg-300");
    expect(mockRedis.set).toHaveBeenCalledWith("notif:idem:msg-300", "1", "EX", 7200);

    await guard.markProcessed("msg-300", 120);
    expect(mockRedis.set).toHaveBeenCalledWith("notif:idem:msg-300", "1", "EX", 120);
  });

  it("isProcessed returns true when key exists in Redis", async () => {
    mockRedis.get.mockResolvedValueOnce("1");
    const guard = new IdempotencyGuard({ redis: mockRedis, keyPrefix: "notif:idem" });

    const processed = await guard.isProcessed("msg-400");
    expect(processed).toBe(true);
    expect(mockRedis.get).toHaveBeenCalledWith("notif:idem:msg-400");
  });

  it("isProcessed returns false when key does not exist (null)", async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    const guard = new IdempotencyGuard({ redis: mockRedis, keyPrefix: "notif:idem" });

    const processed = await guard.isProcessed("msg-missing");
    expect(processed).toBe(false);
    expect(mockRedis.get).toHaveBeenCalledWith("notif:idem:msg-missing");
  });

  it("unmark deletes the key from Redis", async () => {
    mockRedis.del.mockResolvedValueOnce(1);
    const guard = new IdempotencyGuard({ redis: mockRedis, keyPrefix: "notif:idem" });

    await guard.unmark("msg-rollback");
    expect(mockRedis.del).toHaveBeenCalledWith("notif:idem:msg-rollback");
  });
});
