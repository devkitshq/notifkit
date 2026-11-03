import { describe, it, expect, vi } from "vitest";
import { maybePruneDeliveryLogs, pruneDeliveryLogs } from "@/services/scheduler/retention.js";
import { createMockDb } from "./helpers/mock-db.js";

const rows = (n: number) => Array.from({ length: n }, () => ({}));
const logger = { info: vi.fn(), error: vi.fn() } as any;

describe("pruneDeliveryLogs", () => {
  it("deletes in batches until a batch comes back short, for both tables", async () => {
    const mock = createMockDb();
    mock.queueSelect(rows(5000)); // message_logs, full batch: go again
    mock.queueSelect(rows(3)); // message_logs, done
    mock.queueSelect(rows(0)); // delivery_outbox, nothing old

    expect(await pruneDeliveryLogs(mock.db, 30)).toBe(5003);
    expect(mock.db.execute).toHaveBeenCalledTimes(3);
  });
});

describe("maybePruneDeliveryLogs", () => {
  it("prunes at most once per hour across processes", async () => {
    const mock = createMockDb();
    const set = vi.fn().mockResolvedValueOnce("OK").mockResolvedValue(null);
    const redis = { set } as any;

    await maybePruneDeliveryLogs(redis, mock.db, logger, 30);
    await maybePruneDeliveryLogs(redis, mock.db, logger, 30);

    expect(set).toHaveBeenCalledWith(expect.any(String), "1", "EX", 3600, "NX");
    expect(mock.db.execute).toHaveBeenCalledTimes(2); // one empty batch per table, first call only
  });

  it("logs a failed prune instead of throwing into the poll loop", async () => {
    const mock = createMockDb();
    mock.db.execute.mockRejectedValueOnce(new Error("db down"));

    await expect(
      maybePruneDeliveryLogs({ set: async () => "OK" } as any, mock.db, logger, 30),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
