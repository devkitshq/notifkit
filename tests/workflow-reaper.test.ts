import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { reapStuckInstances } from "@/services/workflow/timers.js";

const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any;

function fakeDb(runningIds: string[]) {
  const updates: unknown[] = [];
  const db = {
    select: () => ({ from: () => ({ where: async () => runningIds.map((id) => ({ id })) }) }),
    update: () => ({
      set: () => ({
        where: async (cond: unknown) => {
          updates.push(cond);
        },
      }),
    }),
  };
  return { db, updates };
}

const redis = (locked: boolean) =>
  ({ native: { exists: vi.fn().mockResolvedValue(locked ? 1 : 0) } }) as any;

describe("reapStuckInstances", () => {
  it("puts back an instance whose lock is gone, but only while it is still running", async () => {
    const { db, updates } = fakeDb(["inst-1"]);
    await reapStuckInstances({ redis: redis(false), db, logger });

    expect(updates).toHaveLength(1);
    // The instance may finish or be canceled between the select and this
    // update, so the update itself must require status = 'running'.
    const { sql, params } = new PgDialect().sqlToQuery(updates[0] as any);
    expect(sql).toContain('"status" = $');
    expect(params).toContain("running");
    expect(params).toContain("inst-1");
  });

  it("leaves an instance alone while its lock is held", async () => {
    const { db, updates } = fakeDb(["inst-1"]);
    await reapStuckInstances({ redis: redis(true), db, logger });
    expect(updates).toHaveLength(0);
  });
});
