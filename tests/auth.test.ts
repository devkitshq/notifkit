import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  hashPassword,
  verifyPassword,
  createAdminSession,
  getAdminSession,
  revokeAdminSession,
  DUMMY_PASSWORD_HASH,
} from "@/services/auth/index.js";
import { createHandlers } from "@/services/api/handlers.js";

function createMockReq(body?: any, headers: Record<string, string> = {}) {
  return {
    on: vi.fn((event: string, cb: any) => {
      if (event === "data" && body !== undefined) {
        cb(Buffer.from(JSON.stringify(body)));
      }
      if (event === "end") {
        cb();
      }
    }),
    headers,
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

describe("Password Hashing & Verification", () => {
  it("hashes password and verifies successfully", async () => {
    const raw = "SuperSecretPassword123!";
    const hash = await hashPassword(raw);

    expect(hash).toContain(":");
    expect(await verifyPassword(raw, hash)).toBe(true);
    expect(await verifyPassword("WrongPassword", hash)).toBe(false);
  });

  it("fails verification on malformed hash", async () => {
    expect(await verifyPassword("password", "invalid_hash_string")).toBe(false);
  });

  it("fails verification on dummy hash without throwing", async () => {
    expect(await verifyPassword("password", DUMMY_PASSWORD_HASH)).toBe(false);
  });
});

describe("Admin Session Management", () => {
  let redisStore: Map<string, string>;
  let mockRedisNative: any;

  beforeEach(() => {
    redisStore = new Map();
    mockRedisNative = {
      set: vi.fn(async (key: string, val: string) => {
        redisStore.set(key, val);
        return "OK";
      }),
      get: vi.fn(async (key: string) => {
        return redisStore.get(key) || null;
      }),
      del: vi.fn(async (key: string) => {
        redisStore.delete(key);
        return 1;
      }),
    };
  });

  it("creates, retrieves, and revokes a session", async () => {
    const user = {
      id: "admin-uuid-1",
      email: "admin@example.com",
      username: "admin",
      passwordHash: "hash",
      role: "superadmin",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const session = await createAdminSession(mockRedisNative, user);
    expect(session.token).toMatch(/^nk_sess_[a-f0-9]{64}$/);
    expect(session.adminId).toBe("admin-uuid-1");
    expect(session.email).toBe("admin@example.com");

    const retrieved = await getAdminSession(mockRedisNative, session.token);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.email).toBe("admin@example.com");

    await revokeAdminSession(mockRedisNative, session.token);
    const afterRevoke = await getAdminSession(mockRedisNative, session.token);
    expect(afterRevoke).toBeNull();
  });
});

describe("Auth Handlers", () => {
  let mockAdminUserRepo: any;
  let mockRedis: any;
  let redisStore: Map<string, string>;
  let handlers: ReturnType<typeof createHandlers>;

  beforeEach(async () => {
    redisStore = new Map();
    mockRedis = {
      native: {
        set: vi.fn(async (key: string, val: string) => {
          redisStore.set(key, val);
          return "OK";
        }),
        get: vi.fn(async (key: string) => {
          return redisStore.get(key) || null;
        }),
        del: vi.fn(async (key: string) => {
          redisStore.delete(key);
          return 1;
        }),
      },
    };

    const passwordHash = await hashPassword("correct_password");
    mockAdminUserRepo = {
      findByEmailOrUsername: vi.fn(async (identifier: string) => {
        if (identifier === "admin@example.com" || identifier === "adminuser") {
          return {
            id: "user-123",
            email: "admin@example.com",
            username: "adminuser",
            passwordHash,
            role: "superadmin",
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        return null;
      }),
      findById: vi.fn(async (id: string) => {
        if (id === "user-123") {
          return {
            id: "user-123",
            email: "admin@example.com",
            username: "adminuser",
            passwordHash,
            role: "superadmin",
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        return null;
      }),
    };

    handlers = createHandlers({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      redis: mockRedis,
      producers: {} as any,
      userRepo: {} as any,
      contactRepo: {} as any,
      templateRepo: {} as any,
      projectRepo: {} as any,
      workflowRepo: {} as any,
      segmentRepo: {} as any,
      adminUserRepo: mockAdminUserRepo,
      db: {} as any,
    });
  });

  it("POST /v1/auth/login logs in with valid email and password", async () => {
    const req = createMockReq({ identifier: "admin@example.com", password: "correct_password" });
    const res = createMockRes();

    await handlers.login(req, res);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.token).toMatch(/^nk_sess_/);
    expect(body.user.email).toBe("admin@example.com");
    expect(body.user.role).toBe("superadmin");
  });

  it("POST /v1/auth/login logs in with username", async () => {
    const req = createMockReq({ identifier: "adminuser", password: "correct_password" });
    const res = createMockRes();

    await handlers.login(req, res);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.token).toMatch(/^nk_sess_/);
  });

  it("POST /v1/auth/login rejects wrong password", async () => {
    const req = createMockReq({ identifier: "admin@example.com", password: "wrong_password" });
    const res = createMockRes();

    await handlers.login(req, res);

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("unauthorized");
  });

  it("POST /v1/auth/login rejects non-existent user", async () => {
    const req = createMockReq({ identifier: "unknown@example.com", password: "password" });
    const res = createMockRes();

    await handlers.login(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("GET /v1/auth/me returns current session info", async () => {
    // First login
    const loginReq = createMockReq({
      identifier: "admin@example.com",
      password: "correct_password",
    });
    const loginRes = createMockRes();
    await handlers.login(loginReq, loginRes);
    const { token } = JSON.parse(loginRes.body);

    // Call /v1/auth/me
    const meReq = createMockReq(undefined, { authorization: `Bearer ${token}` });
    const meRes = createMockRes();
    await handlers.getMe(meReq, meRes);

    expect(meRes.statusCode).toBe(200);
    const meBody = JSON.parse(meRes.body);
    expect(meBody.user.email).toBe("admin@example.com");
    expect(meBody.user.role).toBe("superadmin");
  });

  it("POST /v1/auth/logout invalidates session", async () => {
    const loginReq = createMockReq({
      identifier: "admin@example.com",
      password: "correct_password",
    });
    const loginRes = createMockRes();
    await handlers.login(loginReq, loginRes);
    const { token } = JSON.parse(loginRes.body);

    const logoutReq = createMockReq(undefined, { authorization: `Bearer ${token}` });
    const logoutRes = createMockRes();
    await handlers.logout(logoutReq, logoutRes);

    expect(logoutRes.statusCode).toBe(200);

    // Subsequent /v1/auth/me should fail
    const meReq = createMockReq(undefined, { authorization: `Bearer ${token}` });
    const meRes = createMockRes();
    await handlers.getMe(meReq, meRes);
    expect(meRes.statusCode).toBe(401);
  });
});
