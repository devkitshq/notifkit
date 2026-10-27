import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type * as Fs from "node:fs";

// The file is there when it is stat'ed and gone (or unreadable) when it is
// opened: a deploy swapping the bundle out, a permissions change.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>();
  return {
    ...fs,
    createReadStream: () =>
      new Readable({
        read() {
          this.destroy(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }));
        },
      }),
  };
});

const { handleAdminRequest } = await import("@/services/api/admin-static.js");

describe("serving a dashboard file that cannot be read", () => {
  let dir: string;
  let server: Server;
  let base: string;
  const saved = process.env.NOTIFKIT_DASHBOARD_DIR;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "nk-admin-"));
    writeFileSync(join(dir, "index.html"), "<html>Admin</html>");
    process.env.NOTIFKIT_DASHBOARD_DIR = dir;
    server = createServer((req, res) => {
      void handleAdminRequest(req, res, new URL(req.url!, "http://x"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  afterAll(async () => {
    process.env.NOTIFKIT_DASHBOARD_DIR = saved;
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails that one response instead of crashing the process", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      // Headers are already sent when the read fails, so the client sees the
      // response cut short rather than a status. What matters is that it ends:
      // left open, it hangs until the client gives up.
      const outcome = await fetch(`${base}/admin/index.html`, {
        signal: AbortSignal.timeout(3_000),
      })
        .then((r) => r.text())
        .then(
          () => "ended",
          (err) => (err?.name === "TimeoutError" ? "hung" : "cut short"),
        );
      await new Promise((r) => setTimeout(r, 50));
      expect(outcome).not.toBe("hung");
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    expect(uncaught).toEqual([]);

    // And the server is still answering.
    expect((await fetch(`${base}/admin`, { redirect: "manual" })).status).toBe(301);
  });
});
