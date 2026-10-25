import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { useInfra } from "./support/infra.js";
import { apiClient, startNotifkit, type Running } from "./support/pipeline.js";

/**
 * The public routes' per-address limits behind a reverse proxy. A file of its
 * own because TRUST_PROXY is read once per process.
 */

const infra = useInfra();
let app: Running;

beforeAll(async () => {
  app = await startNotifkit(infra, { services: ["api"], env: { TRUST_PROXY: "true" } });
}, 120_000);

afterAll(async () => {
  await app?.stop();
}, 60_000);

beforeEach(async () => {
  const keys = await infra.redis.keys("rate-limit:api:*");
  if (keys.length > 0) await infra.redis.del(...keys);
});

/** Login attempts as the proxy would forward them: `forwarded` is the whole header. */
async function logins(count: number, forwarded: () => string) {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) {
    const client = apiClient(app.baseUrl, undefined, { "x-forwarded-for": forwarded() });
    statuses.push(
      (await client("POST", "/v1/auth/login", { identifier: "x", password: "y" })).status,
    );
  }
  return statuses;
}

describe("login throttling behind a trusted proxy", () => {
  it("cannot be dodged by writing a fresh X-Forwarded-For on every attempt", async () => {
    // The client sends its own made-up header; the proxy appends the address
    // it actually saw.
    const statuses = await logins(12, () => `${randomUUID()}, 203.0.113.7`);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("still tells clients apart", async () => {
    await logins(10, () => "203.0.113.7");
    expect(await logins(1, () => "203.0.113.8")).toEqual([401]);
  });
});
