import type { DeliveryResult, Logger, NotificationDispatchedPayload, Transport } from "notifkit";
import { createHash } from "node:crypto";

const API_URL = "https://api.onesignal.com/notifications?c=push";

/** OneSignal ids (apps, subscriptions) are UUIDs, of any version. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * notifkit priority → OneSignal priority: 10 is high, 5 normal, which a
 * device saving its battery may hold back. The same split as the FCM provider.
 */
const PRIORITY = { low: 5, normal: 5, high: 10, critical: 10 } as const;

/**
 * Namespace for the idempotency keys (a UUID made for notifkit), so a key
 * derived from a task id can't collide with one derived elsewhere.
 */
const IDEMPOTENCY_NAMESPACE = Buffer.from("6f1c2a5e9b8d4e7fa3c0d5b2e8f71a46", "hex");

export interface OneSignalTransportOptions {
  /** The OneSignal app's id, a UUID (Settings → Keys & IDs). */
  appId: string;
  /**
   * An App API key of that app (`os_v2_app_…`), sent as `Authorization: Key`.
   * Not the key's id, which the dashboard shows next to it.
   */
  apiKey: string;
  logger?: Logger;
  /**
   * Local send rate. Defaults to `{ limit: 150, windowSeconds: 1 }`, OneSignal's
   * per-app limit on the free plan. Paid plans allow 6,000 a second.
   */
  limits?: { limit: number; windowSeconds: number };
}

export class OneSignalTransport implements Transport {
  readonly channel = "push" as const;
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly appId: string;
  private readonly apiKey: string;
  private readonly logger?: Logger;

  constructor({
    appId,
    apiKey,
    logger,
    limits = { limit: 150, windowSeconds: 1 },
  }: OneSignalTransportOptions) {
    // Wrong credentials fail every send the same way: fail at startup instead.
    if (!UUID.test(appId ?? "")) {
      throw new Error(`OneSignal appId must be the app's UUID, got ${JSON.stringify(appId)}`);
    }
    if (!apiKey?.trim()) {
      throw new Error("OneSignal apiKey is required");
    }
    this.appId = appId;
    this.apiKey = apiKey.trim();
    this.logger = logger;
    this.limits = limits;
  }

  /**
   * A OneSignal subscription id. Delivery hands anything else (an FCM token, a
   * Web Push subscription) to another provider.
   */
  accepts(destination: string): boolean {
    return UUID.test(destination);
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    // `destination` is optional on the contract, so a malformed task can reach
    // a transport without one.
    const subscriptionId = task.destination;
    if (!subscriptionId) {
      return {
        success: false,
        retryable: false,
        error: "No destination (OneSignal subscription id) on task",
      };
    }
    // Not an invalid token: the push channel is shared, so this may be another
    // provider's device token. Flagging it would deactivate a contact that
    // provider can still reach.
    if (!UUID.test(subscriptionId)) {
      return {
        success: false,
        retryable: false,
        error: "Destination is not a OneSignal subscription id (a UUID)",
      };
    }

    const content = task.renderedContent.content as Record<string, unknown>;
    const title = firstText(content["title"], content["subject"]);
    const body = firstText(content["text"], content["body"]);
    // OneSignal requires English content; a title-only template sends its
    // title as the message.
    const message = body ?? title;
    if (!message) {
      return { success: false, retryable: false, error: "No message body on task" };
    }

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Key ${this.apiKey}`,
        },
        body: JSON.stringify({
          app_id: this.appId,
          target_channel: "push",
          include_subscription_ids: [subscriptionId],
          ...(body && title ? { headings: { en: title } } : {}),
          contents: { en: message },
          data: {
            ...(isRecord(content["data"]) ? content["data"] : {}),
            eventId: task.enrichedEventId,
            taskId: task.taskId,
          },
          priority: PRIORITY[task.priority] ?? 5,
          // The same key on every attempt of this task: when a send timed
          // out after OneSignal created the message, the retry gets that
          // message back instead of a second notification.
          idempotency_key: idempotencyKey(task.taskId),
        }),
        // OneSignal answers the request itself. A redirect would turn the POST
        // into a GET that sends nothing.
        redirect: "manual",
        // Delivery aborts this when the send runs past its timeout. Called on
        // its own, a send gets the same timeout.
        signal:
          (task as { signal?: AbortSignal }).signal ??
          AbortSignal.timeout(task.deliveryOptions?.timeoutMs ?? 10_000),
      });
      const text = await res.text().catch(() => "");
      const data = parseJson(text);

      if (!res.ok) {
        const reason = errorReason(data, text) ?? `HTTP ${res.status}`;
        this.logger?.warn(
          { taskId: task.taskId, status: res.status, error: reason },
          "OneSignal send failed",
        );
        // A 401 or 403 is our key, or the app's plan, refusing us: never the
        // subscription's fault, so nothing flags the contact.
        return {
          success: false,
          ...(isPermanentStatus(res.status) ? { retryable: false } : {}),
          ...(res.status === 429 ? { throttled: true } : {}),
          error: `OneSignal error ${res.status}: ${reason}`,
        };
      }

      // OneSignal answers 200 for a subscription that can't receive the
      // message, and says so in `errors`: with no message id when nobody was
      // reachable, or listing the id in `invalid_player_ids`.
      const id = typeof data?.["id"] === "string" ? data["id"] : "";
      if (isUnsubscribed(data, subscriptionId)) {
        const reason = Array.isArray(data?.["errors"])
          ? errorReason(data, text)
          : "the subscription is unsubscribed (invalid_player_ids)";
        this.logger?.warn(
          { taskId: task.taskId, status: res.status, error: reason },
          "OneSignal subscription is unsubscribed",
        );
        return {
          success: false,
          invalidToken: true,
          retryable: false,
          error: `OneSignal did not send: ${reason}`,
        };
      }
      if (!id) {
        // No message and no reason we know: the next attempt would get the
        // same answer.
        const reason = errorReason(data, text) ?? "no message id in the reply";
        this.logger?.warn(
          { taskId: task.taskId, status: res.status, error: reason },
          "OneSignal did not create a message",
        );
        return { success: false, retryable: false, error: `OneSignal did not send: ${reason}` };
      }

      this.logger?.debug(
        {
          taskId: task.taskId,
          providerMessageId: id,
          replayed: res.headers.get("idempotent-replayed") === "true",
        },
        "OneSignal message sent",
      );
      return { success: true, providerMessageId: id };
    } catch (err) {
      // A network error or a timeout: worth another attempt, which the
      // idempotency key keeps from notifying twice.
      const error = err as Error;
      this.logger?.warn({ taskId: task.taskId, error: error.message }, "OneSignal send threw");
      return { success: false, error: error.message };
    }
  }
}

/**
 * A UUID (RFC 9562 version 5, name-based) for a task, the same on every
 * attempt, so OneSignal sends the task's message once.
 */
function idempotencyKey(taskId: string): string {
  const hash = createHash("sha1").update(IDEMPOTENCY_NAMESPACE).update(taskId).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Whether a 200 says this subscription can't get the message: no message was
 * created because nobody included is subscribed, or the subscription is listed
 * as unsubscribed.
 */
function isUnsubscribed(
  data: Record<string, unknown> | undefined,
  subscriptionId: string,
): boolean {
  const errors = data?.["errors"];
  if (Array.isArray(errors)) {
    return errors.some((e) => typeof e === "string" && /not subscribed/i.test(e));
  }
  if (isRecord(errors)) {
    const invalid = errors["invalid_player_ids"];
    return (
      Array.isArray(invalid) &&
      invalid.some(
        (id) => typeof id === "string" && id.toLowerCase() === subscriptionId.toLowerCase(),
      )
    );
  }
  return false;
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
 * Whether a refusal with this HTTP status is final. A 4xx says the request
 * itself is wrong, so sending it again cannot succeed; 408 and 429 are the
 * exceptions (the request was fine, the moment was not), as is every 5xx. A
 * 3xx is final too: the redirect was not followed, and would not be next time.
 */
function isPermanentStatus(status: number): boolean {
  return status >= 300 && status < 500 && status !== 408 && status !== 429;
}

/**
 * The reason in a OneSignal reply: `errors` is a list of messages, or an
 * object of lists (`invalid_player_ids`). A body that isn't JSON (a gateway's
 * page) is cut to 200 characters.
 */
function errorReason(data: Record<string, unknown> | undefined, text: string): string | undefined {
  const errors = data?.["errors"];
  if (Array.isArray(errors)) {
    const messages = errors.filter((e): e is string => typeof e === "string" && e.length > 0);
    if (messages.length) return messages.join("; ");
  }
  if (isRecord(errors)) {
    const keys = Object.keys(errors);
    if (keys.length) return keys.join(", ");
  }
  if (data) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const data: unknown = JSON.parse(text);
    return isRecord(data) ? data : undefined;
  } catch {
    return undefined;
  }
}
