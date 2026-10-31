import type { IncomingMessage, ServerResponse } from "node:http";

export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  projectId?: string;
  role?: "admin" | "read_only";
  isAdmin?: boolean;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
) => Promise<void> | void;

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

interface Route {
  method: Method;
  segments: string[];
  handler: RouteHandler;
}

/**
 * Minimal path router with `:param` capture — enough for the REST surface here
 * without pulling in a framework. First match wins.
 *
 * Routes are indexed by `"METHOD:segmentCount"` so `match()` only inspects the
 * small bucket of routes that share the same method and path depth, instead of
 * scanning every registered route on every request.
 */
export class Router {
  /** Indexed buckets: key is `"METHOD:segmentCount"`. */
  private readonly index = new Map<string, Route[]>();

  add(method: Method, pattern: string, handler: RouteHandler): this {
    const route: Route = { method, segments: split(pattern), handler };
    const key = `${method}:${route.segments.length}`;
    let bucket = this.index.get(key);
    if (!bucket) {
      bucket = [];
      this.index.set(key, bucket);
    }
    bucket.push(route);
    return this;
  }

  get(p: string, h: RouteHandler) {
    return this.add("GET", p, h);
  }
  post(p: string, h: RouteHandler) {
    return this.add("POST", p, h);
  }
  patch(p: string, h: RouteHandler) {
    return this.add("PATCH", p, h);
  }
  put(p: string, h: RouteHandler) {
    return this.add("PUT", p, h);
  }
  delete(p: string, h: RouteHandler) {
    return this.add("DELETE", p, h);
  }

  /** Returns the matched handler + captured params, or null. */
  match(
    method: string,
    pathname: string,
  ): { handler: RouteHandler; params: Record<string, string> } | null {
    const parts = split(pathname);
    const key = `${method}:${parts.length}`;
    const candidates = this.index.get(key);
    if (!candidates) return null;

    for (const route of candidates) {
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!;
        const part = parts[i]!;
        if (seg.startsWith(":")) {
          try {
            params[seg.slice(1)] = decodeURIComponent(part);
          } catch {
            ok = false;
            break;
          }
        } else if (seg !== part) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}

function split(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}
