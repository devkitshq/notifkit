import { describe, it, expect, vi, afterAll } from "vitest";
import type * as Http from "node:http";

// Drives the API's request listener with Redis, Postgres and the HTTP server faked.
const state = vi.hoisted(() => {
  delete process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_API_KEY;
  process.env.LOG_LEVEL = "silent";
  return {
    listener: null as null | ((req: any, res: any) => void),
    sessions: new Map<string, string>(),
  };
});

vi.mock("node:http", async (orig) => {
  const actual = await orig<typeof Http>();
  return {
    ...actual,
    createServer: (listener: any) => {
      state.listener = listener;
      return { listen: vi.fn(), close: (cb: any) => cb() };
    },
  };
});

vi.mock("@/redis/index.js", () => {
  const subscriber = {
    subscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    disconnect: vi.fn(),
  };
  const client = {
    native: {
      duplicate: () => subscriber,
      get: async (key: string) => state.sessions.get(key) ?? null,
      del: async (key: string) => (state.sessions.delete(key) ? 1 : 0),
    },
    healthCheck: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return { RedisClient: { shared: () => client } };
});

vi.mock("@/rate-limiter/index.js", () => ({
  ApiRateLimiter: class {
    check = vi.fn().mockResolvedValue(true);
    clear = vi.fn();
  },
}));

vi.mock("@/queue/index.js", () => ({ StreamProducer: class {} }));

vi.mock("@/db/index.js", () => ({
  createDatabase: () => ({ db: {}, sql: { end: vi.fn() } }),
}));

import { startApiServer, stopApiServer } from "@/services/api/main.js";

function request(method: string, url: string, token: string): Promise<number> {
  return new Promise((resolve) => {
    const res: any = {
      headersSent: false,
      setHeader: vi.fn(),
      writeHead: (code: number) => {
        res.statusCode = code;
        res.headersSent = true;
        return res;
      },
      end: () => resolve(res.statusCode),
    };
    state.listener!(
      {
        url,
        method,
        headers: { authorization: `Bearer ${token}` },
        socket: { remoteAddress: "127.0.0.1" },
      },
      res,
    );
  });
}

describe("read-only dashboard session", () => {
  afterAll(async () => {
    await stopApiServer();
  });

  it("can log out, and the session stops working", async () => {
    await startApiServer();
    const token = "nk_sess_readonly";
    state.sessions.set(
      `notif:session:${token}`,
      JSON.stringify({
        token,
        adminId: "a1",
        email: "ro@x.com",
        role: "read_only",
        expiresAt: Date.now() + 60_000,
      }),
    );

    expect(await request("POST", "/v1/auth/logout", token)).toBe(200);
    expect(state.sessions.size).toBe(0);
  });

  it("is still refused other writes", async () => {
    const token = "nk_sess_readonly2";
    state.sessions.set(
      `notif:session:${token}`,
      JSON.stringify({
        token,
        adminId: "a1",
        email: "ro@x.com",
        role: "read_only",
        expiresAt: Date.now() + 60_000,
      }),
    );

    expect(await request("POST", "/v1/dlq/replay", token)).toBe(403);
  });
});
