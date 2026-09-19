import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { handleAdminRequest } from "@/services/api/admin-static.js";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function createMockReq(url: string, method = "GET") {
  return {
    url,
    method,
    headers: { host: "localhost:3000" },
    pipe: vi.fn(),
    readable: false,
  } as any;
}

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, any>,
    body: "",
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    write: vi.fn((chunk: any) => {
      res.body += chunk?.toString() || "";
      return true;
    }),
    setHeader: vi.fn((k, v) => {
      res.headers[k] = v;
    }),
    writeHead: vi.fn((code: number, headers: any) => {
      res.statusCode = code;
      Object.assign(res.headers, headers || {});
      return res;
    }),
    end: vi.fn((data?: string) => {
      if (data) res.body += data;
    }),
  } as any;
  return res;
}

describe("Admin Static Server", () => {
  const testDir = resolve(process.cwd(), "dist", "admin");

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(resolve(testDir, "index.html"), "<html>Admin</html>", "utf8");
  });

  afterAll(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("ignores non-admin requests", async () => {
    const req = createMockReq("/v1/notify");
    const res = createMockRes();
    const url = new URL(req.url, "http://localhost:3000");

    const handled = await handleAdminRequest(req, res, url);
    expect(handled).toBe(false);
  });

  it("redirects /admin to /admin/", async () => {
    const req = createMockReq("/admin");
    const res = createMockRes();
    const url = new URL(req.url, "http://localhost:3000");

    const handled = await handleAdminRequest(req, res, url);
    expect(handled).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(301, { Location: "/admin/" });
  });

  it("handles /admin/ with either static file or fallback placeholder", async () => {
    const req = createMockReq("/admin/");
    const res = createMockRes();
    const url = new URL(req.url, "http://localhost:3000");

    const handled = await handleAdminRequest(req, res, url);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("blocks directory traversal attempts outside dashboardDir", async () => {
    const req = createMockReq("/admin/assets/../../admin_secret/config.json");
    const res = createMockRes();
    const url = new URL("http://localhost:3000/admin/assets/../../admin_secret/config.json");
    Object.defineProperty(url, "pathname", { value: "/admin/../admin_secret/config.json" });

    const handled = await handleAdminRequest(req, res, url);
    expect(handled).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(403, { "Content-Type": "text/plain" });
  });
});
