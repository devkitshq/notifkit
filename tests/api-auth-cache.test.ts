import { describe, it, expect, vi, afterAll } from "vitest";
import { createHash } from "node:crypto";
import type * as Http from "node:http";
import type * as DrizzleOrm from "drizzle-orm";

// Drives the API's request listener directly, with Redis, Postgres and the
// HTTP server faked, to check how the API key cache reacts to revocation.
const state = vi.hoisted(() => {
  delete process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_API_KEY;
  process.env.LOG_LEVEL = "silent";
  return {
    listener: null as null | ((req: any, res: any) => void),
    onMessage: null as null | ((channel: string, message: string) => void),
    /** Tokens the fake api-keys table still holds. */
    validTokens: new Set<string>(),
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
    on: (event: string, cb: any) => {
      if (event === "message") state.onMessage = cb;
    },
    disconnect: vi.fn(),
  };
  const client = {
    native: { duplicate: () => subscriber },
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

// Lets the fake query below see which key hash it was asked for.
vi.mock("drizzle-orm", async (orig) => ({
  ...(await orig<typeof DrizzleOrm>()),
  eq: (_column: unknown, value: unknown) => ({ value }),
}));

vi.mock("@/db/index.js", () => {
  const hashOf = (t: string) => createHash("sha256").update(t).digest("hex");
  // select().from().innerJoin().where(eq(keyHash, hash)).limit(1)
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: ({ value }: { value: string }) => ({
            limit: async () =>
              [...state.validTokens].some((t) => hashOf(t) === value)
                ? [{ id: "proj_1", rateLimitRpm: 600, role: "admin" }]
                : [],
          }),
        }),
      }),
    }),
  };
  return { createDatabase: () => ({ db, sql: { end: vi.fn() } }) };
});

import { startApiServer, stopApiServer } from "@/services/api/main.js";

async function request(token: string): Promise<number> {
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
        url: "/v1/no-such-route",
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        socket: { remoteAddress: "127.0.0.1" },
      },
      res,
    );
  });
}

describe("API key cache", () => {
  afterAll(async () => {
    await stopApiServer();
  });

  it("drops a revoked key even after more than 2,000 keys have been seen", async () => {
    await startApiServer();

    const tokens = Array.from({ length: 2001 }, (_, i) => `nk_live_key_${i}`);
    for (const t of tokens) state.validTokens.add(t);
    // An authorised key reaches routing and 404s; a rejected one is a 401.
    for (const t of tokens) expect(await request(t)).toBe(404);

    const revoked = tokens.at(-1)!;
    state.validTokens.delete(revoked);
    state.onMessage!("apikey.invalidated", createHash("sha256").update(revoked).digest("hex"));

    expect(await request(revoked)).toBe(401);
  });
});
