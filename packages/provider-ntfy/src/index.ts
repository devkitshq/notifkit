import type { DeliveryResult, Logger, NotificationDispatchedPayload, Transport } from "notifkit";

/** The public ntfy server, used when no `serverUrl` is given. */
const DEFAULT_SERVER_URL = "https://ntfy.sh";

/**
 * ntfy's own rule for a topic name. Checked before the URL is built, so a
 * destination like `../v1/account` cannot reach another path on the server.
 */
const TOPIC = /^[-_A-Za-z0-9]{1,64}$/;

/**
 * notifkit priority → ntfy priority (1 min … 5 max). ntfy's default is 3, so
 * `normal` changes nothing on the phone.
 */
const PRIORITY = { low: "2", normal: "3", high: "4", critical: "5" } as const;

/**
 * The longest body ntfy keeps as the notification text. It reads 4,096 bytes
 * ahead, and a body that fills them, 4,096 bytes included, becomes a file
 * attachment, so a longer body is cut to fit.
 */
const MAX_MESSAGE_BYTES = 4095;

/** ntfy refuses a title longer than this many bytes with a 400. */
const MAX_TITLE_BYTES = 1024;

export interface NtfyTransportOptions {
  /**
   * The ntfy server to publish to, `https://ntfy.sh` by default. A
   * self-hosted server works the same way, also behind a path
   * (`https://example.com/ntfy`).
   */
  serverUrl?: string;
  /**
   * An access token (`tk_…`) for topics that need one: reserved topics on
   * ntfy.sh, or any topic on a server with access control. Sent as
   * `Authorization: Bearer`.
   */
  accessToken?: string;
  logger?: Logger;
  /**
   * Local send rate. Defaults to `{ limit: 60, windowSeconds: 300 }`, which
   * stays inside ntfy's default per-visitor limit (a burst of 60 requests,
   * then one every 5 seconds). Raise it for a server or an account tier with
   * higher limits.
   */
  limits?: { limit: number; windowSeconds: number };
}

export class NtfyTransport implements Transport {
  readonly channel = "push" as const;
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly serverUrl: string;
  private readonly accessToken?: string;
  private readonly logger?: Logger;

  constructor({
    serverUrl = DEFAULT_SERVER_URL,
    accessToken,
    logger,
    limits = { limit: 60, windowSeconds: 300 },
  }: NtfyTransportOptions = {}) {
    // A wrong server URL is a configuration mistake: fail at startup rather
    // than on every send.
    const url = new URL(serverUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`ntfy serverUrl must be an http(s) URL, got ${url.protocol}`);
    }
    this.serverUrl = url.href.replace(/\/+$/, "");
    this.accessToken = accessToken;
    this.logger = logger;
    this.limits = limits;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    // `destination` is optional on the contract, so a malformed task can reach
    // a transport without one.
    const topic = task.destination;
    if (!topic) {
      return { success: false, retryable: false, error: "No destination (ntfy topic) on task" };
    }
    // Not an invalid token: the push channel is shared, so this may be another
    // provider's device token (an FCM token is not a topic name). Flagging it
    // would deactivate a contact that provider can still reach.
    if (!TOPIC.test(topic)) {
      return {
        success: false,
        retryable: false,
        error: "Invalid ntfy topic: use 1-64 letters, digits, '-' or '_'",
      };
    }

    const content = task.renderedContent.content as Record<string, unknown>;
    const body = firstText(content["text"], content["body"]);
    const title = firstText(content["title"], content["subject"])?.replace(/\s+/g, " ").trim();
    // ntfy shows an empty message as "triggered", so a title-only template
    // sends its title as the message.
    const message = body ?? title;
    if (!message) {
      return { success: false, retryable: false, error: "No message body on task" };
    }

    const headers: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
    };
    // X-Title and X-Priority are ntfy's canonical names. A bare `Priority`
    // header can be rewritten on the way (RFC 9218, which Cloudflare sets).
    if (body && title) headers["X-Title"] = encodeHeader(truncateBytes(title, MAX_TITLE_BYTES));
    const priority = task.priority ? PRIORITY[task.priority] : undefined;
    if (priority) headers["X-Priority"] = priority;
    if (this.accessToken) headers["Authorization"] = `Bearer ${this.accessToken}`;

    try {
      const res = await fetch(`${this.serverUrl}/${topic}`, {
        method: "POST",
        headers,
        body: truncateBytes(message, MAX_MESSAGE_BYTES),
        // Followed, a redirect turns the POST into a GET, answered 200 with a
        // page while nothing is published: ntfy.sh sends `/docs` to its
        // documentation, and an http:// server URL is often sent to https://.
        redirect: "manual",
        // Delivery aborts this when the send runs past its timeout. Called on
        // its own, a send gets the same timeout.
        signal:
          (task as { signal?: AbortSignal }).signal ??
          AbortSignal.timeout(task.deliveryOptions?.timeoutMs ?? 10_000),
      });
      const text = await res.text().catch(() => "");

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location") ?? "another URL";
        this.logger?.warn(
          { taskId: task.taskId, status: res.status, location },
          "ntfy redirected the publish",
        );
        // Nothing was published, and the next attempt would be redirected too.
        return {
          success: false,
          retryable: false,
          error: `ntfy redirected the publish to ${location}, so nothing was sent: check serverUrl and the topic name`,
        };
      }

      if (!res.ok) {
        const reason = errorReason(text) ?? `HTTP ${res.status}`;
        this.logger?.warn(
          { taskId: task.taskId, status: res.status, error: reason },
          "ntfy send failed",
        );
        // No answer flags the contact. ntfy says a topic is gone (410) only to
        // UnifiedPush publishes, which this provider doesn't send, and a 401
        // or 403 is our token or the server's access rules refusing us.
        return {
          success: false,
          ...(isPermanentStatus(res.status) ? { retryable: false } : {}),
          ...(res.status === 429 ? { throttled: true } : {}),
          error: `ntfy error ${res.status}: ${reason}`,
        };
      }

      // ntfy answers every publish with the stored message. A reply without
      // its id came from something else (a proxy, a web page), so there is no
      // sign the message was published, and the next attempt would get the
      // same reply.
      const id = messageId(text);
      if (!id) {
        this.logger?.warn(
          { taskId: task.taskId, status: res.status },
          "ntfy reply has no message id",
        );
        return {
          success: false,
          retryable: false,
          error: `ntfy answered ${res.status} without a message id, so the publish is unconfirmed: is serverUrl an ntfy server?`,
        };
      }
      this.logger?.debug({ taskId: task.taskId, providerMessageId: id }, "ntfy message sent");
      return { success: true, providerMessageId: id };
    } catch (err) {
      // A network error or a timeout: worth another attempt.
      const error = err as Error;
      this.logger?.warn({ taskId: task.taskId, error: error.message }, "ntfy send threw");
      return { success: false, error: error.message };
    }
  }
}

/** The first argument that is a non-blank string. */
function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/**
 * A header value fetch can send as is, or else RFC 2047 encoded words, which
 * ntfy decodes. fetch only sends Latin-1 in headers: an emoji throws, and an
 * accented letter would arrive as a byte that is not UTF-8. A plain value that
 * looks like an encoded word (`=?`) is encoded too, so ntfy doesn't decode it.
 */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value) && !value.includes("=?")) return value;
  // Encoded words are capped at 75 characters (RFC 2047 §2): 45 bytes of
  // UTF-8 is 60 in base64, plus the 12 of `=?UTF-8?B?…?=`. Words split
  // between characters, never inside one.
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join(" ");
}

/**
 * Cuts `text` to at most `max` bytes of UTF-8, ending in "…", without
 * splitting a character. ntfy's limits count bytes, not characters.
 */
function truncateBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  const budget = max - Buffer.byteLength("…");
  let cut = "";
  let size = 0;
  for (const char of text) {
    size += Buffer.byteLength(char);
    if (size > budget) break;
    cut += char;
  }
  return `${cut}…`;
}

/**
 * Whether a refusal with this HTTP status is final. A 4xx says the request
 * itself is wrong, so sending it again cannot succeed; 408 and 429 are the
 * exceptions (the request was fine, the moment was not), as is every 5xx.
 */
function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** `error` from ntfy's JSON error body (`{"code":40101,"http":401,"error":"unauthorized"}`). */
function errorReason(text: string): string | undefined {
  const data = parseJson(text) as { error?: unknown } | undefined;
  return typeof data?.error === "string" && data.error ? data.error : undefined;
}

/** `id` from ntfy's JSON reply to a publish. */
function messageId(text: string): string | undefined {
  const data = parseJson(text) as { id?: unknown } | undefined;
  return typeof data?.id === "string" && data.id ? data.id : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
