import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, extname, join, relative, isAbsolute, dirname } from "node:path";
import { existsSync, statSync, createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { pipeline } from "node:stream";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

// Where a built dashboard may sit, relative to a base directory.
const DASHBOARD_SUBDIRS = [
  ["dashboard", "dist"],
  ["dashboard", "out"],
  ["dist", "admin"],
  ["dist", "dashboard"],
];

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** The nearest ancestor of `dir` holding a package.json: notifkit's own root. */
function packageRoot(dir: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, "package.json"))) return d;
    if (dirname(d) === d) return null;
  }
}

/**
 * Locates the built dashboard.
 *
 * The package ships `dashboard/dist`, so it is looked for beside this module
 * first. Resolving it from the working directory alone found it only when the
 * process was started from a notifkit checkout; installed as a dependency, the
 * working directory is the host app's and /admin reported "not built".
 * `NOTIFKIT_DASHBOARD_DIR` overrides both.
 */
export function findDashboardDir(
  moduleDir: string = MODULE_DIR,
  cwd: string = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): string | null {
  const override = env.NOTIFKIT_DASHBOARD_DIR;
  if (override && existsSync(join(override, "index.html"))) return resolve(override);

  const bases = [packageRoot(moduleDir), cwd].filter((b): b is string => b !== null);
  for (const base of bases) {
    for (const sub of DASHBOARD_SUBDIRS) {
      const dir = resolve(base, ...sub);
      if (existsSync(join(dir, "index.html"))) return dir;
    }
  }
  return null;
}

/**
 * Proxies request to frontend dev server if running.
 */
function proxyToDevServer(
  req: IncomingMessage,
  res: ServerResponse,
  targetHost: string,
  targetPort: number,
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const proxyReq = httpRequest(
      {
        host: targetHost,
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
        resolvePromise(true);
      },
    );

    proxyReq.on("error", () => {
      resolvePromise(false);
    });

    if (req.readable) {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  });
}

/**
 * Handles incoming HTTP requests for `/admin` and `/admin/*`.
 * Serves static exported assets from Vite SPA build with index.html fallback,
 * or proxies to Vite dev server if running in development mode.
 */
export async function handleAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname !== "/admin" && !url.pathname.startsWith("/admin/")) {
    return false;
  }

  // Redirect /admin to /admin/
  if (url.pathname === "/admin") {
    res.writeHead(301, { Location: "/admin/" + (url.search || "") });
    res.end();
    return true;
  }

  // Proxy to the dashboard's dev server only when one is named. Defaulting to
  // 127.0.0.1:5173 outside production meant a deployment that never set
  // NODE_ENV sent every /admin request, credentials included, to whatever
  // listened there, and served its reply as the dashboard.
  const devProxyUrl =
    process.env.VITE_DEV_URL || process.env.ADMIN_DEV_URL || process.env.NEXT_DEV_URL;
  if (devProxyUrl && process.env.NODE_ENV !== "production") {
    const target = new URL(devProxyUrl);
    const proxied = await proxyToDevServer(
      req,
      res,
      target.hostname,
      parseInt(target.port, 10) || 80,
    );
    if (proxied) {
      return true;
    }
  }

  const dashboardDir = findDashboardDir();
  if (!dashboardDir) {
    // If dashboard build not found, return friendly message
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <title>Notifkit Admin Dashboard</title>
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; background: #09090b; color: #f4f4f5; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #18181b; border: 1px solid #27272a; padding: 2rem; border-radius: 0.75rem; max-width: 500px; text-align: center; }
          h1 { margin-top: 0; color: #fafafa; }
          code { background: #27272a; padding: 0.2rem 0.4rem; border-radius: 0.25rem; font-family: monospace; font-size: 0.9em; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Notifkit Admin Dashboard</h1>
          <p>The dashboard static bundle has not been built yet.</p>
          <p>Please build it by running:</p>
          <p><code>npm run build:dashboard</code></p>
          <p>or run the dev server with <code>npm --prefix dashboard run dev</code> and start notifkit with <code>VITE_DEV_URL=http://127.0.0.1:5173</code>.</p>
        </div>
      </body>
      </html>
    `);
    return true;
  }

  // Strip /admin prefix to find relative path inside dashboardDir
  let subPath = url.pathname.slice("/admin".length);
  if (subPath.startsWith("/")) {
    subPath = subPath.slice(1);
  }
  if (!subPath) {
    subPath = "index.html";
  }

  const normalizedSubPath = subPath.replace(/\/$/, "");
  let filePath = resolve(dashboardDir, subPath);

  // Security check: ensure filePath is inside dashboardDir
  const rel = relative(dashboardDir, filePath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return true;
  }

  // Check direct file
  let stat: ReturnType<typeof statSync> | null = null;
  if (existsSync(filePath)) {
    stat = statSync(filePath);
    if (stat.isDirectory()) {
      filePath = join(filePath, "index.html");
      stat = existsSync(filePath) ? statSync(filePath) : null;
    }
  }

  // Check path.html if direct file not found
  if (!stat) {
    const htmlPath = resolve(dashboardDir, `${normalizedSubPath}.html`);
    if (existsSync(htmlPath)) {
      filePath = htmlPath;
      stat = statSync(filePath);
    }
  }

  // Check path/index.html
  if (!stat) {
    const dirIndexPath = resolve(dashboardDir, normalizedSubPath, "index.html");
    if (existsSync(dirIndexPath)) {
      filePath = dirIndexPath;
      stat = statSync(filePath);
    }
  }

  // Fallback to index.html for SPA client-side routing
  if (!stat) {
    filePath = resolve(dashboardDir, "index.html");
    if (existsSync(filePath)) {
      stat = statSync(filePath);
    }
  }

  if (!stat) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
    return true;
  }

  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  // Cache static assets (_next/static) aggressively (immutable, 1 year), HTML files no-cache
  const isImmutable = filePath.includes("_next") || ext === ".js" || ext === ".css";
  const cacheControl = isImmutable
    ? "public, max-age=31536000, immutable"
    : "public, max-age=0, must-revalidate";

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Cache-Control": cacheControl,
  });

  // pipeline, not pipe: a file that vanished or turned unreadable after the
  // stat above fails the read, and pipe left that error unhandled (crashing
  // the process) and the response open. pipeline destroys the response, so
  // the client sees it cut short, and the error stops here.
  pipeline(createReadStream(filePath), res, () => {});
  return true;
}
