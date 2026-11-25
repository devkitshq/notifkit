import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { handleAdminRequest, findDashboardDir } from "@/services/api/admin-static.js";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

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

  // The build links assets as ./assets/…, so /admin/logs/ would load them from
  // /admin/logs/assets/, get index.html back and render a blank page.
  it("redirects a trailing-slash page to the path without it", async () => {
    const req = createMockReq("/admin/logs/?tab=1");
    const res = createMockRes();
    const url = new URL(req.url, "http://localhost:3000");

    expect(await handleAdminRequest(req, res, url)).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(301, { Location: "/admin/logs?tab=1" });
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

describe("findDashboardDir", () => {
  // An installed copy: the bundle runs from node_modules/notifkit/dist, and the
  // built dashboard ships beside it. The app itself runs from its own folder.
  function installedPackage() {
    const root = mkdtempSync(join(tmpdir(), "notifkit-dash-"));
    const pkg = join(root, "node_modules", "notifkit");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    mkdirSync(join(pkg, "dashboard", "dist"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"name":"notifkit"}');
    writeFileSync(join(pkg, "dashboard", "dist", "index.html"), "<html></html>");
    const app = join(root, "app");
    mkdirSync(app);
    return { root, pkg, app };
  }

  it("finds the dashboard shipped in the package when the app runs from another directory", () => {
    const { root, pkg, app } = installedPackage();
    try {
      expect(findDashboardDir(join(pkg, "dist"), app, {})).toBe(join(pkg, "dashboard", "dist"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses NOTIFKIT_DASHBOARD_DIR over the shipped build when it holds an index", () => {
    const { root, pkg, app } = installedPackage();
    const custom = join(root, "custom");
    mkdirSync(custom);
    writeFileSync(join(custom, "index.html"), "<html></html>");
    try {
      expect(findDashboardDir(join(pkg, "dist"), app, { NOTIFKIT_DASHBOARD_DIR: custom })).toBe(
        custom,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when no build exists anywhere", () => {
    const root = mkdtempSync(join(tmpdir(), "notifkit-dash-"));
    try {
      expect(findDashboardDir(root, root, {})).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
