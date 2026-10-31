import { describe, it, expect, vi } from "vitest";
import type * as Bootstrap from "@/workers/bootstrap.js";
import type * as Workers from "@/workers/index.js";

// The AI worker logs its Redis URL at startup; the password must not reach the log.
const infoCalls = vi.hoisted(() => {
  process.env.REDIS_URL = "redis://user:s3cret@redis.example:6379/0";
  return [] as unknown[][];
});

vi.mock("@/workers/bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Bootstrap>();
  const logger = {
    info: (...args: unknown[]) => infoCalls.push(args),
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => logger,
  };
  const subscriber = { subscribe: async () => {}, on: () => {} };
  return {
    ...actual,
    createWorkerRuntime: () => ({
      logger,
      redis: { native: { duplicate: () => subscriber } },
      sql: {},
      db: {},
    }),
    createStreamConsumer: () => ({ consumer: {}, pendingScanner: {} }),
    createPriorityProducers: () => ({}),
  };
});

vi.mock("@/workers/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Workers>();
  return { ...actual, startHealthReporter: () => null };
});

import { BaseWorker } from "@/workers/index.js";
import { startAiWorker } from "@/services/ai/main.js";

describe("AI worker startup log", () => {
  it("redacts the Redis password", async () => {
    vi.spyOn(BaseWorker.prototype, "start").mockResolvedValue();

    await startAiWorker();

    const starting = infoCalls.find((args) => args[1] === "ai starting");
    expect(starting).toBeDefined();
    const logged = JSON.stringify(starting![0]);
    expect(logged).not.toContain("s3cret");
    expect(logged).toContain("redis.example");
  });
});
