import type { DeliveryResult, Logger, NotificationDispatchedPayload, Transport } from "notifkit";
import { createECDH } from "node:crypto";
import {
  generateRequestDetails,
  getVapidHeaders,
  type PushSubscription,
  type RequestDetails,
} from "web-push";

/**
 * The most a push service has to accept as a message body, encrypted (RFC 8030
 * §7.2). Encryption adds 103 bytes, which leaves 3,993 for the JSON payload.
 */
const MAX_ENCRYPTED_BYTES = 4096;

/**
 * notifkit priority → Web Push `Urgency` (RFC 8030 §5.3). A device saving its
 * battery may hold back `low` messages until it wakes up.
 */
const URGENCY = { low: "low", normal: "normal", high: "high", critical: "high" } as const;

/**
 * The push services browsers subscribe with, by host: Google's for Chrome
 * and the other Chromium browsers (Opera, Samsung Internet, Brave…), and
 * Mozilla's for Firefox.
 */
const PUSH_SERVICE_HOSTS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com"]);

/**
 * Push services spread over subdomains: Microsoft's for Edge, one host per
 * region (`wns2-par02p.notify.windows.com`), and Apple's for Safari, which
 * Apple documents as any subdomain of push.apple.com.
 */
const PUSH_SERVICE_DOMAINS = [".notify.windows.com", ".push.apple.com"];

/**
 * Whether `url` is an endpoint of a push service browsers use: https, on its
 * default port, with no credentials, on one of the hosts above.
 */
export function isKnownPushServiceUrl(url: URL): boolean {
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  // URL has already lowercased the host.
  const hostname = url.hostname;
  return (
    PUSH_SERVICE_HOSTS.has(hostname) ||
    PUSH_SERVICE_DOMAINS.some((domain) => hostname.endsWith(domain))
  );
}

export interface WebPushTransportOptions {
  /**
   * How push services can reach you about your messages: a `mailto:` address
   * or an `https:` URL. Apple's push service refuses `localhost`.
   */
  vapidSubject: string;
  /**
   * The VAPID public key, URL-safe base64. The same key goes to
   * `pushManager.subscribe({ applicationServerKey })` in the browser.
   */
  vapidPublicKey: string;
  /** The VAPID private key, URL-safe base64. */
  vapidPrivateKey: string;
  /**
   * How long, in seconds, a push service keeps a message for a device that is
   * offline. Defaults to 4 weeks, the most push services keep a message.
   */
  ttlSeconds?: number;
  logger?: Logger;
  limits?: { limit: number; windowSeconds: number };
}

export class WebPushTransport implements Transport {
  readonly channel = "push" as const;
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly vapidDetails: { subject: string; publicKey: string; privateKey: string };
  private readonly ttlSeconds?: number;
  private readonly logger?: Logger;

  constructor({
    vapidSubject,
    vapidPublicKey,
    vapidPrivateKey,
    ttlSeconds,
    logger,
    limits = { limit: 1000, windowSeconds: 60 },
  }: WebPushTransportOptions) {
    // Wrong VAPID details fail every send the same way, so they fail here,
    // at startup, instead.
    try {
      getVapidHeaders(
        "https://push.example",
        vapidSubject,
        vapidPublicKey,
        vapidPrivateKey,
        "aes128gcm",
      );
      // Keys from two different pairs pass the check above, then every push
      // service refuses the signature.
      const ecdh = createECDH("prime256v1");
      ecdh.setPrivateKey(Buffer.from(vapidPrivateKey, "base64url"));
      if (!ecdh.getPublicKey().equals(Buffer.from(vapidPublicKey, "base64url"))) {
        throw new Error("vapidPublicKey is not the public key of vapidPrivateKey");
      }
    } catch (err) {
      throw new Error(`Invalid VAPID details: ${(err as Error).message}`);
    }
    if (ttlSeconds !== undefined && !(Number.isInteger(ttlSeconds) && ttlSeconds >= 0)) {
      throw new Error(`ttlSeconds must be a whole number of seconds, got ${ttlSeconds}`);
    }

    // Passed with every send, not set with `setVapidDetails`: that one is
    // global to the web-push module, so a second transport would replace the
    // first one's keys.
    this.vapidDetails = {
      subject: vapidSubject,
      publicKey: vapidPublicKey,
      privateKey: vapidPrivateKey,
    };
    this.ttlSeconds = ttlSeconds;
    this.logger = logger;
    this.limits = limits;
  }

  /** A Web Push subscription; delivery hands anything else (an FCM token) to another provider. */
  accepts(destination: string): boolean {
    return parseSubscription(destination) !== undefined;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    // `destination` is optional on the contract, so a malformed task can reach
    // a transport without one.
    if (!task.destination) {
      return {
        success: false,
        retryable: false,
        error: "No destination (Web Push subscription) on task",
      };
    }
    const subscription = parseSubscription(task.destination);
    // Not an invalid token: the push channel is shared, so this may be another
    // provider's device token (an FCM token is not JSON). Flagging it would
    // deactivate a contact that provider can still reach.
    if (!subscription) {
      return {
        success: false,
        retryable: false,
        error: "Destination is not a Web Push subscription (JSON with an endpoint)",
      };
    }

    const content = task.renderedContent.content as Record<string, unknown>;
    const title = firstText(content["title"], content["subject"]);
    const body = firstText(content["text"], content["body"]);
    if (!title && !body) {
      return { success: false, retryable: false, error: "No title or body on task" };
    }
    const payload = JSON.stringify({
      title: title ?? "",
      body: body ?? "",
      data: {
        ...(isRecord(content["data"]) ? content["data"] : {}),
        eventId: task.enrichedEventId,
        taskId: task.taskId,
      },
    });

    let request: RequestDetails;
    try {
      // RFC 8030 has push services on https only; over http the VAPID token
      // would travel in the clear.
      const endpoint = new URL(subscription.endpoint);
      if (endpoint.protocol !== "https:") {
        throw new Error("the endpoint must be an https:// URL");
      }
      if (endpoint.username || endpoint.password) {
        throw new Error("the endpoint must not carry credentials");
      }
      // The endpoint reaches notifkit from the browser, through the app, so
      // anyone could make one up. Only a push service gets the request.
      if (!isKnownPushServiceUrl(endpoint)) {
        throw new Error(`${endpoint.host} is not a known push service`);
      }
      request = generateRequestDetails(subscription, payload, {
        vapidDetails: this.vapidDetails,
        urgency: URGENCY[task.priority] ?? "normal",
        ...(this.ttlSeconds !== undefined ? { TTL: this.ttlSeconds } : {}),
      });
    } catch (err) {
      // The destination is a subscription, so no other provider can use it,
      // but its endpoint or keys are unusable (a bad URL, a host that is not
      // a push service, a p256dh that is not a P-256 key): no send to it will
      // ever be made.
      const error = `Invalid Web Push subscription: ${(err as Error).message}`;
      this.logger?.warn({ taskId: task.taskId, error }, "Web Push subscription refused");
      return { success: false, invalidToken: true, retryable: false, error };
    }

    const encrypted = request.body ?? Buffer.alloc(0);
    if (encrypted.length > MAX_ENCRYPTED_BYTES) {
      return {
        success: false,
        retryable: false,
        error: `Web Push payload is ${encrypted.length} bytes encrypted; push services accept ${MAX_ENCRYPTED_BYTES}`,
      };
    }

    // Logged by origin only: the full endpoint is the address of one browser.
    const pushService = new URL(request.endpoint).origin;
    try {
      // fetch rather than web-push's sendNotification, which can't be
      // canceled: delivery aborts a send that runs past its timeout.
      const res = await fetch(request.endpoint, {
        method: "POST",
        headers: requestHeaders(request.headers),
        body: new Uint8Array(encrypted),
        // A push service answers a push itself. A redirect would turn the POST
        // into a GET that delivers nothing.
        redirect: "manual",
        // Delivery aborts this when the send runs past its timeout. Called on
        // its own, a send gets the same timeout.
        signal:
          (task as { signal?: AbortSignal }).signal ??
          AbortSignal.timeout(task.deliveryOptions?.timeoutMs ?? 10_000),
      });
      const text = await res.text().catch(() => "");

      if (!res.ok) {
        const reason = errorReason(text) ?? `HTTP ${res.status}`;
        // 404 and 410: the browser unsubscribed, or the subscription expired.
        // It won't come back, so notifkit stops sending to it.
        const invalidToken = res.status === 404 || res.status === 410;
        this.logger?.warn(
          { taskId: task.taskId, pushService, status: res.status, error: reason, invalidToken },
          "Web Push send failed",
        );
        return {
          success: false,
          // Never set for a 401 or 403: that is our VAPID key being refused,
          // which flagging every contact would not fix.
          invalidToken,
          ...(isPermanentStatus(res.status) ? { retryable: false } : {}),
          ...(res.status === 429 ? { throttled: true } : {}),
          error: `Web Push error ${res.status}: ${reason}`,
        };
      }

      // RFC 8030 §5: the push service returns the message's URL in Location.
      // Apple's service sends an apns-id instead.
      const providerMessageId =
        res.headers.get("location") ?? res.headers.get("apns-id") ?? undefined;
      this.logger?.debug(
        { taskId: task.taskId, pushService, providerMessageId },
        "Web Push message sent",
      );
      return { success: true, providerMessageId };
    } catch (err) {
      // A network error or a timeout: worth another attempt.
      const error = err as Error;
      this.logger?.warn(
        { taskId: task.taskId, pushService, error: error.message },
        "Web Push send threw",
      );
      return { success: false, error: error.message };
    }
  }
}

/**
 * The subscription in a destination: the browser's `PushSubscription` as JSON
 * (`JSON.stringify(subscription)` gives `{ endpoint, expirationTime, keys }`).
 * Undefined when the destination is something else, such as a device token.
 */
function parseSubscription(destination: string): PushSubscription | undefined {
  let data: unknown;
  try {
    data = JSON.parse(destination);
  } catch {
    return undefined;
  }
  if (!isRecord(data) || typeof data["endpoint"] !== "string") return undefined;
  const keys = isRecord(data["keys"]) ? data["keys"] : {};
  return {
    endpoint: data["endpoint"],
    keys: {
      p256dh: typeof keys["p256dh"] === "string" ? keys["p256dh"] : "",
      auth: typeof keys["auth"] === "string" ? keys["auth"] : "",
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first argument that is a non-blank string. */
function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/**
 * web-push's headers as fetch takes them: values as strings, and no
 * Content-Length, which fetch sets from the body.
 */
function requestHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "content-length" || value === undefined) continue;
    out[name] = String(value);
  }
  return out;
}

/**
 * Whether a refusal with this HTTP status is final. A 4xx says the request
 * itself is wrong, so sending it again cannot succeed; 408 and 429 are the
 * exceptions (the request was fine, the moment was not), as is every 5xx. A
 * 3xx is final too: the redirect was not followed, and would not be next time.
 */
function isPermanentStatus(status: number): boolean {
  return status >= 300 && status < 500 && status !== 408 && status !== 429;
}

/**
 * The reason in a push service's error body: Mozilla's is JSON with a
 * `message`, Google's and Apple's are text (Apple's JSON has a `reason`).
 */
function errorReason(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const data = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ["message", "reason", "error"]) {
      if (typeof data[key] === "string" && data[key]) return data[key] as string;
    }
  } catch {
    // Not JSON: the text is the reason.
  }
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}
