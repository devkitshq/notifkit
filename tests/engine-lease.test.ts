import { describe, it, expect, vi } from "vitest";
import { EngineWorker } from "@/services/engine/main.js";
import { IdempotencyGuard } from "@/idempotency/index.js";
import { ProjectSettingsCache } from "@/rate-limiter/index.js";
import { createMockDb } from "./helpers/mock-db.js";

/** Just enough Redis for IdempotencyGuard, on a clock the test moves. */
function fakeRedis() {
  let now = 0;
  const store = new Map<string, { value: string; expiresAt: number }>();
  const live = (key: string) => {
    const entry = store.get(key);
    if (entry && entry.expiresAt <= now) store.delete(key);
    return store.get(key);
  };
  return {
    advance(ms: number) {
      now += ms;
    },
    async set(key: string, value: string, _ex: "EX", ttl: number, nx?: "NX") {
      if (nx && live(key)) return null;
      store.set(key, { value, expiresAt: now + ttl * 1000 });
      return "OK";
    },
    async get(key: string) {
      return live(key)?.value ?? null;
    },
    async del(key: string) {
      store.delete(key);
      return 1;
    },
  };
}

function engine(redis: ReturnType<typeof fakeRedis>, scheduledPublish: () => Promise<unknown>) {
  const sendAt = new Date(Date.now() + 3_600_000).toISOString();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return new EngineWorker({
    consumer: {} as any,
    pendingScanner: {} as any,
    logger: logger as any,
    registry: {
      safeParsePayload: () => ({
        success: true,
        data: {
          projectId: "123e4567-e89b-12d3-a456-426614174000",
          rawEventId: "evt-1",
          recipientId: "usr-1",
          channel: "email",
          priority: "normal",
          contactId: "c-1",
          destination: "alice@example.com",
          recipient: { locale: "en", timezone: "UTC", preferences: { optedOut: false } },
          templateVariables: {},
          scheduledAt: sendAt,
        },
      }),
    } as any,
    idempotency: new IdempotencyGuard({ redis: redis as any, keyPrefix: "engine" }),
    throttle: { check: vi.fn().mockResolvedValue({ allowed: true, count: 1, limit: 100 }) },
    projectSettings: new ProjectSettingsCache(async () => null),
    redis: {} as any,
    templateCache: { getCachedTemplate: vi.fn() } as any,
    aiPendingProducer: { publish: vi.fn() },
    scheduledProducer: { publish: vi.fn(scheduledPublish) },
    outboundProducers: {},
    globalEmitter: { emit: vi.fn() },
    contactRepo: {},
    db: createMockDb().db,
  });
}

const message = { id: "1-0", event: { id: "e-1", metadata: { traceId: "t" }, payload: {} } };

describe("EngineWorker lease on scheduled sends", () => {
  it("lets a redelivery through after the first worker died mid-message", async () => {
    const redis = fakeRedis();

    // The first worker dies while publishing: its handler never returns.
    void engine(redis, () => new Promise(() => {})).process(message as any);
    await new Promise((r) => setTimeout(r, 10));

    // The stream redelivers once the entry has sat idle past the reclaim threshold.
    redis.advance(61_000);
    const publish = vi.fn().mockResolvedValue("ok");
    await engine(redis, publish).process(message as any);

    expect(publish).toHaveBeenCalledTimes(1);
  });
});
