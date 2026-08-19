import type { IncomingMessage, ServerResponse } from "node:http";

export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  projectId?: string;
  role?: "admin" | "read_only";
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
 */
export class Router {
  private readonly routes: Route[] = [];

  add(method: Method, pattern: string, handler: RouteHandler): this {
    this.routes.push({ method, segments: split(pattern), handler });
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
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;

      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!;
        const part = parts[i]!;
        if (seg.startsWith(":")) {
          params[seg.slice(1)] = decodeURIComponent(part);
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
