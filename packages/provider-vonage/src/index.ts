import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  DeliveryResult,
  Logger,
  NotificationDispatchedPayload,
  Transport,
  WebhookEvent,
} from "notifkit";

/** Messages API v1 send endpoint. https://developer.vonage.com/en/api/messages */
const MESSAGES_URL = "https://api.nexmo.com/v1/messages";

/** Route the status webhook is mounted at, once a signature secret is configured. */
const WEBHOOK_PATH = "/webhooks/vonage";

/**
 * Error codes that say the destination itself is bad, as opposed to the
 * sender, the account or the moment. Only these deactivate the contact on a
 * failed send. https://developer.vonage.com/en/api-errors/messages
 */
const INVALID_DESTINATION_CODES = new Set([
  1050, // Number barred
  1170, // Invalid recipient
  1190, // Absent subscriber permanent: the number is no longer active
  1240, // Illegal number: the recipient replied STOP
  1430, // Invalid recipient (channel level)
]);

/**
 * Codes a later attempt can get past. Vonage does not document which HTTP
 * status carries each code, so a 4xx with one of these is still retried.
 */
const THROTTLED_CODES = new Set([
  1000, // Throttled: over the account's submission capacity
  1241, // Too many send requests to phone numbers
  1461, // Auto-limiting by provider
]);
const TEMPORARY_CODES = new Set([
  1030, // Internal error
  1100, // Communication failed
  1180, // Destination temporarily unavailable
  1220, // Handset busy
  1230, // Temporary network failure
  1331, // Provider error
]);

/**
 * Codes on a `rejected` status webhook that mean the number is gone, not that
 * this one attempt lost. Everything unlisted is a soft bounce: an unrecognised
 * code must never suppress a number a person still uses.
 */
const HARD_BOUNCE_CODES = new Set([
  1050, // Number barred
  1170, // Invalid recipient
  1190, // Absent subscriber permanent
  1310, // Not suitable device (cannot receive SMS)
  1430, // Invalid recipient (channel level)
]);

/** The recipient replied STOP. An opt-out, not a delivery failure. */
const OPT_OUT_CODE = 1240;

/** Vonage rejects a `text` longer than this. */
const VONAGE_MAX_TEXT = 3200;

/** A phone number, maybe formatted: digits, `+`, spaces, `()`, `.` and `-`. */
const PHONE_NUMBER = /^[+\d\s().-]+$/;

export interface VonageTransportOptions {
  /** API key from the Vonage Dashboard. */
  apiKey: string;
  /** API secret from the Vonage Dashboard. */
  apiSecret: string;
  /**
   * Sender used for any template that does not name its own: a Vonage
   * number in E.164 (`+447700900001`) or, where the destination country
   * allows it, an alphanumeric sender ID. A template may override it with a
   * `from` in its content — see `send`.
   */
  from: string;
  /**
   * Dashboard > Settings > Signature secret. Vonage signs every Messages API
   * status webhook with it. Leave it unset to send without delivery tracking:
   * the webhook route is only mounted when it is present, because an
   * unverifiable callback is an anonymous, forgeable write into delivery
   * history.
   */
  signatureSecret?: string;
  logger?: Logger;
  limits?: { limit: number; windowSeconds: number };
}

export class VonageTransport implements Transport {
  readonly channel = "sms" as const;
  readonly webhookPath?: string;
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly authorization: string;
  private readonly from: string;
  private readonly signatureSecret?: string;
  private readonly logger?: Logger;

  constructor({
    apiKey,
    apiSecret,
    from,
    signatureSecret,
    logger,
    // Vonage's documented default for the Messages API: 75 requests per
    // second per API key.
    limits = { limit: 75, windowSeconds: 1 },
  }: VonageTransportOptions) {
    this.authorization = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
    this.from = from;
    this.signatureSecret = signatureSecret;
    this.logger = logger;
    this.limits = limits;
    if (signatureSecret) this.webhookPath = WEBHOOK_PATH;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    // `destination` is optional on the contract, so a malformed task can reach
    // a transport without one. Vonage wants the number without the leading
    // `+` (447700900000), so keep only its digits, and only of a phone number:
    // "ext 12" would otherwise be dialled as part of it.
    const to =
      task.destination && PHONE_NUMBER.test(task.destination)
        ? task.destination.replace(/\D/g, "")
        : undefined;
    if (!to) {
      return {
        success: false,
        retryable: false,
        error: "No destination (recipient phone number) on task",
      };
    }

    const content = task.renderedContent.content as Record<string, unknown>;
    const text = content["text"] || content["body"];
    if (typeof text !== "string" || !text) {
      return { success: false, retryable: false, error: "No message body on task" };
    }

    // A template may carry its own sender. Non-strings are ignored rather
    // than coerced, so `from: 123` cannot reach Vonage as "123".
    const from =
      typeof content["from"] === "string" && content["from"] ? content["from"] : this.from;

    try {
      const res = await fetch(MESSAGES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: this.authorization,
        },
        body: JSON.stringify({
          message_type: "text",
          channel: "sms",
          to,
          from: normaliseSender(from),
          text: truncate(text, VONAGE_MAX_TEXT),
        }),
        // Delivery aborts this when it gives up on the send and retries, so a late
        // request can't send the SMS twice. Called on its own, a send gets the same timeout.
        signal:
          (task as { signal?: AbortSignal }).signal ??
          AbortSignal.timeout(task.deliveryOptions?.timeoutMs ?? 10_000),
      });
      const data: unknown = await res.json().catch(() => undefined);

      if (!res.ok) {
        // Errors come back as RFC 7807 problem details, the Vonage code in
        // the `type` URL (`…/api-errors/messages#1170`) or in `title`.
        const code = errorCode(data);
        const message = problemMessage(data) ?? `HTTP ${res.status}`;
        const invalidToken = code !== undefined && INVALID_DESTINATION_CODES.has(code);
        const throttled = res.status === 429 || (code !== undefined && THROTTLED_CODES.has(code));
        const retryableCode =
          code !== undefined && (THROTTLED_CODES.has(code) || TEMPORARY_CODES.has(code));
        const permanent = invalidToken || (!retryableCode && isPermanentStatus(res.status));

        this.logger?.warn(
          { taskId: task.taskId, status: res.status, code, error: message, invalidToken },
          "Vonage send failed",
        );
        return {
          success: false,
          // Never set for a 401: that is our own API key being refused, and
          // flagging it would deactivate every recipient's number. The 4xx
          // still makes it permanent, so it isn't retried.
          invalidToken,
          ...(permanent ? { retryable: false } : {}),
          ...(throttled ? { throttled: true } : {}),
          error: message,
        };
      }

      // 202 Accepted: Vonage has the message, no carrier has seen it yet.
      // Whether it landed arrives later on the status webhook.
      const messageUuid = (data as { message_uuid?: unknown } | undefined)?.message_uuid;
      if (typeof messageUuid !== "string" || !messageUuid) {
        this.logger?.warn(
          { taskId: task.taskId, status: res.status },
          "Vonage accepted the message without a message_uuid",
        );
        return { success: true };
      }
      this.logger?.debug({ taskId: task.taskId, messageUuid }, "Vonage message accepted");
      return { success: true, providerMessageId: messageUuid };
    } catch (err) {
      // A network error or a timeout: worth another attempt.
      const error = err as Error;
      this.logger?.warn({ taskId: task.taskId, error: error.message }, "Vonage send threw");
      return { success: false, error: error.message };
    }
  }

  /**
   * Signature gate for the route mounted at `webhookPath`.
   *
   * Vonage sends `Authorization: Bearer <JWT>`, signed HS256 with the
   * account's signature secret. The JWT only covers its own claims, so the
   * body is bound to it through the `payload_hash` claim (SHA-256 of the
   * body): without that check, a captured token could carry any body.
   * Fail closed on every missing piece.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean {
    if (!this.signatureSecret) {
      this.logger?.error(
        "Vonage webhook rejected: signatureSecret is not configured, cannot verify signature",
      );
      return false;
    }

    const header = headers["authorization"];
    const value = Array.isArray(header) ? header[0] : header;
    const token = value?.startsWith("Bearer ") ? value.slice("Bearer ".length).trim() : undefined;
    if (!token) {
      this.logger?.warn("Vonage webhook rejected: missing Bearer token in Authorization header");
      return false;
    }

    const claims = verifyHs256(token, this.signatureSecret);
    if (!claims) {
      this.logger?.warn("Vonage webhook signature verification failed");
      return false;
    }

    const bodyHash = createHash("sha256").update(rawBody).digest("hex");
    if (typeof claims["payload_hash"] !== "string" || claims["payload_hash"] !== bodyHash) {
      this.logger?.warn("Vonage webhook rejected: payload_hash does not match the body");
      return false;
    }
    return true;
  }

  async parseWebhook(
    payload: unknown,
    rawBody?: string,
    headers?: Record<string, string | string[] | undefined>,
  ): Promise<WebhookEvent[]> {
    // Verify again rather than trusting the caller. This method is public and
    // may be called directly, and an unverified callback is a forgeable write
    // into delivery history.
    if (rawBody === undefined || !headers || !this.verifyWebhook(rawBody, headers)) {
      return [];
    }

    const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    const providerMessageId = body["message_uuid"];
    const messageStatus = body["status"];
    if (typeof providerMessageId !== "string" || typeof messageStatus !== "string") {
      this.logger?.warn("Vonage status webhook malformed or missing message_uuid");
      return [];
    }

    const code = errorCode(body["error"]);
    let status: WebhookEvent["status"];
    let bounceType: WebhookEvent["bounceType"] | undefined;

    switch (messageStatus) {
      case "rejected":
        // A STOP reply is a withdrawal of consent, not a broken number: one
        // should never be messaged again, the other may come back.
        if (code === OPT_OUT_CODE) {
          status = "unsubscribed";
        } else {
          status = "bounced";
          bounceType = code !== undefined && HARD_BOUNCE_CODES.has(code) ? "hard" : "soft";
        }
        break;
      case "undeliverable":
        // Vonage could not reach the carrier (an outage), which says nothing
        // about the number.
        status = "bounced";
        bounceType = "soft";
        break;
      default:
        // submitted, delivered: progress the delivery log already infers.
        this.logger?.debug({ messageStatus }, "Vonage status webhook ignored (untracked status)");
        return [];
    }

    const metadata: Record<string, unknown> = { messageStatus };
    if (code !== undefined) metadata["errorCode"] = code;
    const detail = problemMessage(body["error"]);
    if (detail) metadata["errorDetail"] = detail;

    // Contacts are stored in E.164 and suppressions match them exactly, so
    // give back the `+` Vonage leaves off.
    const to = body["to"];
    const recipient = typeof to === "string" && /^\d+$/.test(to) ? `+${to}` : undefined;
    const sentAt = body["timestamp"];
    const timestamp = typeof sentAt === "string" ? new Date(sentAt) : undefined;

    this.logger?.info(
      { providerMessageId, status, messageStatus, errorCode: code },
      "Vonage status webhook mapped to notifkit status",
    );

    return [
      {
        providerMessageId,
        status,
        timestamp: timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp : new Date(),
        ...(recipient ? { recipient } : {}),
        ...(bounceType ? { bounceType } : {}),
        metadata,
      },
    ];
  }
}

/**
 * The claims of an HS256 JWT signed with `secret`, or undefined when the token
 * is malformed, uses another algorithm, or its signature does not match.
 */
function verifyHs256(token: string, secret: string): Record<string, unknown> | undefined {
  const [header, payload, signature, ...rest] = token.split(".");
  if (!header || !payload || !signature || rest.length > 0) return undefined;
  // Pin the algorithm: trusting the token's own `alg` would let it pick
  // `none` and skip the signature.
  if (decodeSegment(header)?.["alg"] !== "HS256") return undefined;

  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  const provided = Buffer.from(signature, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return undefined;
  }
  return decodeSegment(payload);
}

function decodeSegment(segment: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The numeric Vonage code of a problem-details object, if it has one. */
function errorCode(problem: unknown): number | undefined {
  if (!problem || typeof problem !== "object") return undefined;
  const { type, title } = problem as { type?: unknown; title?: unknown };
  const fromType = typeof type === "string" ? /#(\d+)$/.exec(type)?.[1] : undefined;
  const code = Number(fromType ?? title);
  return Number.isInteger(code) && code > 0 ? code : undefined;
}

function problemMessage(problem: unknown): string | undefined {
  if (!problem || typeof problem !== "object") return undefined;
  const { detail, title } = problem as { detail?: unknown; title?: unknown };
  if (typeof detail === "string" && detail) return detail;
  if (typeof title === "string" && title) return title;
  return undefined;
}

/**
 * Vonage wants a sender number without `+` or spaces. An alphanumeric sender
 * ID (`MyShop`) is passed as written.
 */
function normaliseSender(from: string): string {
  return PHONE_NUMBER.test(from) ? from.replace(/\D/g, "") : from;
}

/**
 * Whether a refusal with this HTTP status is final. A 4xx says the request
 * itself is wrong, so sending it again cannot succeed; 408 and 429 are the
 * exceptions (the request was fine, the moment was not), as is every 5xx.
 */
function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Cuts `text` to at most `max` UTF-16 units, ending in "…", without splitting
 * a surrogate pair. Vonage refuses an over-long text outright, so a truncated
 * message beats a permanently failed one.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}
