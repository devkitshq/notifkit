import { describe, it, expect, vi } from "vitest";
import { NotifkitServer } from "@/server.js";
import { globalEmitter } from "@/shared/index.js";

describe("NotifkitServer Events & Emitters", () => {
  it("forwards lifecycle events from globalEmitter to the server instance", async () => {
    const server = new NotifkitServer({
      services: [],
    });

    const mockListener = vi.fn();
    server.on("delivery:delivered", mockListener);

    globalEmitter.emit("delivery:delivered", "task-1", "msg-123", "email", "proj-1");

    expect(mockListener).toHaveBeenCalledWith("task-1", "msg-123", "email", "proj-1");
    await server.stop();
  });
});
