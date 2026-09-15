import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, extname, join } from "node:path";
import { existsSync, statSync, createReadStream } from "node:fs";
import { request as httpRequest } from "node:http";

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

// Possible output directories where built dashboard static files might reside
const POSSIBLE_DASHBOARD_DIRS = [
  resolve(process.cwd(), "dashboard", "dist"),
  resolve(process.cwd(), "dashboard", "out"),
  resolve(process.cwd(), "dist", "admin"),
  resolve(process.cwd(), "dist", "dashboard"),
];

function getDashboardDir(): string | null {
  for (const dir of POSSIBLE_DASHBOARD_DIRS) {
    if (existsSync(dir) && existsSync(join(dir, "index.html"))) {
      return dir;
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

  // In development, attempt to proxy to local Vite dev server on port 5173 (or VITE_DEV_URL) if active
  if (process.env.NODE_ENV !== "production") {
    const devProxyUrl =
      process.env.VITE_DEV_URL || process.env.ADMIN_DEV_URL || process.env.NEXT_DEV_URL;
    const targetPort = devProxyUrl ? parseInt(new URL(devProxyUrl).port, 10) : 5173;
    const targetHost = devProxyUrl ? new URL(devProxyUrl).hostname : "127.0.0.1";

    const proxied = await proxyToDevServer(req, res, targetHost, targetPort);
    if (proxied) {
      return true;
    }
  }

  const dashboardDir = getDashboardDir();
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
          <p>or run the dev server with <code>npm --prefix dashboard run dev</code>.</p>
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
  if (!filePath.startsWith(dashboardDir)) {
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

  const stream = createReadStream(filePath);
  stream.pipe(res);
  return true;
}
