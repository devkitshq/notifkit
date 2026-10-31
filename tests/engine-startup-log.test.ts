import { describe, it, expect, vi } from "vitest";
import type * as Bootstrap from "@/workers/bootstrap.js";

// A missing UNSUBSCRIBE_SECRET is a deployment setting: warn once when the
// engine starts. Startup is cut off when the consumer is created.
const warnings = vi.hoisted(() => {
  delete process.env.UNSUBSCRIBE_SECRET;
  return [] as unknown[][];
});

vi.mock("@/workers/bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Bootstrap>();
  const logger = {
    info: () => {},
    warn: (...args: unknown[]) => warnings.push(args),
    error: () => {},
    debug: () => {},
  };
  return {
    ...actual,
    createWorkerRuntime: () => ({ logger, redis: { native: {} }, sql: {}, db: {} }),
    createStreamConsumer: () => {
      throw new Error("stop at the consumer");
    },
  };
});

import { startEngineWorker } from "@/services/engine/main.js";

describe("engine startup", () => {
  it("warns once that UNSUBSCRIBE_SECRET is not configured", async () => {
    await expect(startEngineWorker()).rejects.toThrow("stop at the consumer");

    const matching = warnings.filter((args) => String(args.at(-1)).includes("UNSUBSCRIBE_SECRET"));
    expect(matching).toHaveLength(1);
  });
});
