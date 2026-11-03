import { describe, it, expect, vi } from "vitest";
import { createNotificationsHandlers } from "@/services/api/handlers/notifications.js";

function jsonReq(body: unknown) {
  return {
    headers: {},
    on: (event: string, cb: any) => {
      if (event === "data") cb(Buffer.from(JSON.stringify(body)));
      if (event === "end") cb();
    },
  } as any;
}

describe("POST /v1/notify with an inline user", () => {
  it("fails the request instead of queueing it when the user cannot be saved", async () => {
    const publishBatch = vi.fn().mockResolvedValue({ messageIds: ["1-0"], eventIds: ["e1"] });
    const deps: any = {
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      producers: { normal: { publishBatch } },
      db: { transaction: vi.fn().mockRejectedValue(new Error("connection refused")) },
    };
    const { notify } = createNotificationsHandlers(deps);
    const res: any = { writeHead: vi.fn(), end: vi.fn() };

    await expect(
      notify(jsonReq({ user: { id: "usr_new", email: "new@x.com" }, template: "welcome" }), res, {
        params: {},
        query: new URLSearchParams(),
        projectId: "11111111-1111-4111-8111-111111111111",
      }),
    ).rejects.toThrow("connection refused");
    expect(publishBatch).not.toHaveBeenCalled();
    expect(res.writeHead).not.toHaveBeenCalled();
  });
});
