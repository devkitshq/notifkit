import http from "node:http";
import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";

/**
 * Stands in for third-party APIs at the HTTP layer.
 *
 * Providers keep calling `fetch("https://api.telegram.org/...")` exactly as in
 * production; requests to the hosts registered here are routed to a local
 * server instead, so the real request is serialised, sent, answered with a
 * real status code and body, and parsed by the provider's own code. Nothing in
 * the provider is replaced.
 */

export interface RecordedRequest {
  method: string;
  host: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** The body as sent, for one that is not text (an encrypted Web Push message). */
  bytes: Buffer;
  json(): any;
}

export type Reply =
  | {
      status?: number;
      json?: unknown;
      text?: string;
      headers?: Record<string, string>;
      delayMs?: number;
    }
  | "hang-up";

export type Handler = (req: RecordedRequest) => Reply | Promise<Reply>;

export interface FakeInternet {
  requests: RecordedRequest[];
  /** Answers requests to `host` with `handler`, replacing any previous one. */
  on(host: string, handler: Handler): void;
  close(): Promise<void>;
}

export async function startFakeInternet(): Promise<FakeInternet> {
  const handlers = new Map<string, Handler>();
  const requests: RecordedRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => void respond());
    const respond = async () => {
      const bytes = Buffer.concat(chunks);
      const body = bytes.toString("utf8");
      // /__host/<host><path>
      const [, , host, ...rest] = (req.url ?? "/").split("/");
      const path = `/${rest.join("/")}`;
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        host: host ?? "",
        path,
        headers: req.headers,
        body,
        bytes,
        json: () => JSON.parse(body),
      };
      requests.push(recorded);
      const handler = handlers.get(recorded.host);
      const reply: Reply = handler
        ? await handler(recorded)
        : { status: 404, text: "no fake for host" };
      if (reply === "hang-up") {
        req.socket.destroy();
        return;
      }
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      const headers: Record<string, string> = { ...(reply.headers ?? {}) };
      let out = reply.text ?? "";
      if (reply.json !== undefined) {
        headers["content-type"] ??= "application/json";
        out = JSON.stringify(reply.json);
      }
      res.writeHead(reply.status ?? 200, headers);
      res.end(out);
    };
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;

  const previous = getGlobalDispatcher();
  const direct = new Agent();
  class Router extends Agent {
    override dispatch(
      opts: Dispatcher.DispatchOptions,
      handler: Dispatcher.DispatchHandler,
    ): boolean {
      const url = new URL(opts.path, opts.origin as string);
      if (!handlers.has(url.host)) return (previous as any).dispatch(opts, handler);
      return direct.dispatch({ ...opts, origin, path: `/__host/${url.host}${opts.path}` }, handler);
    }
  }
  setGlobalDispatcher(new Router());

  return {
    requests,
    on(host, handler) {
      handlers.set(host, handler);
    },
    async close() {
      setGlobalDispatcher(previous);
      await direct.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
