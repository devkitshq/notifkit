import { timingSafeEqual } from "node:crypto";
import type { DeliveryResult, Transport } from "notifkit";
import type { NotificationDispatchedPayload, Logger } from "notifkit";
import type { WebhookEvent } from "notifkit";

export interface PostmarkTransportOptions {
  /**
   * Server API Token from the Postmark dashboard (Servers > API Tokens).
   * Sent as the `X-Postmark-Server-Token` header.
   */
  serverToken: string;
  /**
   * Sender used for any template that does not name its own. A template may
   * override it with a `from` in its content — see `send`.
   */
  from: string;
  logger?: Logger;
  /**
   * Basic-auth credentials for the bounce webhook. Postmark does not sign
   * webhooks, so the documented protection is HTTP Basic Auth: put the
   * credentials in the webhook URL configured in the Postmark dashboard
   * (https://<username>:<password>@host/webhooks/postmark) and set the same
   * pair here. Required for `verifyWebhook` and `parseWebhook`: without them
   * every webhook is rejected.
   */
  webhookUsername?: string;
  webhookPassword?: string;
  limits?: { limit: number; windowSeconds: number };
}

/** Postmark Email API endpoint for sending a single email. */
const SEND_URL = "https://api.postmarkapp.com/email";

/**
 * Postmark ErrorCode for an inactive recipient. The address hard bounced or
 * generated a spam complaint, so Postmark suppressed it — sending again
 * cannot succeed, and notifkit should deactivate the contact instead.
 */
const INACTIVE_RECIPIENT_ERROR_CODE = 406;

export class PostmarkTransport implements Transport {
  readonly channel = "email" as const;
  readonly webhookPath = "/webhooks/postmark";
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly serverToken: string;
  private readonly from: string;
  private readonly logger?: Logger;
  private readonly webhookUsername?: string;
  private readonly webhookPassword?: string;

  constructor({
    serverToken,
    from,
    logger,
    webhookUsername,
    webhookPassword,
    limits = { limit: 1000, windowSeconds: 10 },
  }: PostmarkTransportOptions) {
    this.serverToken = serverToken;
    this.from = from;
    this.logger = logger;
    this.webhookUsername = webhookUsername;
    this.webhookPassword = webhookPassword;
    this.limits = limits;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    // `destination` is optional on the contract, so a malformed task can reach
    // a transport without one. Failing here costs one clear error; passing
    // `undefined` to Postmark costs an opaque provider rejection and a retry cycle.
    const to = task.destination;
    if (!to) {
      return {
        success: false,
        retryable: false,
        error: "No destination (recipient address) on task",
      };
    }

    const content = task.renderedContent.content as any;
    const body = content.text || content.body;
    const subject = content.subject;
    const htmlBody = content.htmlBody || content.html;

    // A template may carry its own sender, so one transport can serve
    // no-reply@ for receipts and marketing@ for campaigns. Both fields are
    // header fields to the renderer, which strips CR/LF from interpolated
    // values — a template naming neither falls back to the constructor's.
    // Non-strings are ignored rather than coerced: `from: 123` reaching the
    // provider as "123" would fail the send with a confusing error.
    const from = typeof content.from === "string" && content.from ? content.from : this.from;
    const replyTo =
      typeof content.replyTo === "string" && content.replyTo ? content.replyTo : undefined;

    // Carries the List-Unsubscribe pair the engine attaches to topic-bearing
    // mail. Postmark takes custom headers as a `Headers` array of
    // `{ Name, Value }` objects; passing them through is what makes the inbox
    // render a real unsubscribe button instead of leaving the recipient the
    // spam key.
    const headers = task.deliveryOptions?.headers;

    // Postmark needs at least one body part. A text-only template gets an
    // HTML part built from its text. The text was rendered unescaped (it is
    // plain text), so it is escaped here — otherwise a variable holding
    // markup becomes live HTML in the email.
    const textBody = typeof body === "string" ? body : "";
    const html = typeof htmlBody === "string" ? htmlBody : textToHtml(textBody);

    try {
      const res = await fetch(SEND_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": this.serverToken,
        },
        body: JSON.stringify({
          From: from,
          To: to,
          Subject: subject ?? "Notification",
          TextBody: textBody,
          HtmlBody: html,
          ...(replyTo ? { ReplyTo: replyTo } : {}),
          ...(headers && Object.keys(headers).length > 0
            ? {
                Headers: Object.entries(headers).map(([name, value]) => ({
                  Name: name,
                  Value: String(value),
                })),
              }
            : {}),
        }),
      });

      const payload = await parseJsonBody(res);

      if (res.ok && payload && payload.ErrorCode !== 0 && payload.ErrorCode !== undefined) {
        // A 200 with a non-zero ErrorCode is not a delivery; fall through to
        // the failure path with the provider's own message and code.
        return this.failure(task, res.status, payload);
      }

      if (res.ok) {
        const providerMessageId =
          payload && typeof payload.MessageID === "string" ? payload.MessageID : "";
        this.logger?.debug({ taskId: task.taskId, providerMessageId }, "Postmark email sent");
        return { success: true, providerMessageId };
      }

      return this.failure(task, res.status, payload);
    } catch (err) {
      const error = err as Error;
      this.logger?.error(
        { taskId: task.taskId, error: error.message },
        "Postmark unexpected error",
      );

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Map a refused send onto a DeliveryResult. ErrorCode 406 means the
   * recipient is inactive (Postmark already suppressed it), so the contact is
   * dead; any other 4xx except 408/429 is permanent for a different reason
   * (a rejected sender, a bad request). Timeouts, 429 and 5xx stay retryable.
   */
  private failure(
    task: NotificationDispatchedPayload,
    status: number,
    payload: PostmarkApiBody | null,
  ): DeliveryResult {
    const body = payload ?? {};
    const errorCode = typeof body.ErrorCode === "number" ? body.ErrorCode : undefined;
    const message = typeof body.Message === "string" && body.Message ? body.Message : undefined;
    const error = message || `Postmark error ${status}`;
    const invalidToken = errorCode === INACTIVE_RECIPIENT_ERROR_CODE;
    const permanent = invalidToken || isPermanentStatus(status);

    this.logger?.warn(
      { taskId: task.taskId, status, error, errorCode, invalidToken },
      "Postmark send failed",
    );

    return {
      success: false,
      invalidToken,
      ...(permanent ? { retryable: false } : {}),
      error,
    };
  }

  /**
   * Check the HTTP Basic Auth credentials on an incoming bounce webhook and
   * return whether they match the pair configured in the transport options.
   *
   * Fail closed. Postmark does not sign webhooks, so basic auth is the only
   * thing standing between the endpoint and an anonymous, forgeable write
   * into delivery history. A missing credential pair or missing request data
   * is a reason to drop the event — never a reason to trust it.
   */
  private verifyBasicAuth(
    headers: Record<string, string | string[] | undefined> | undefined,
  ): boolean {
    if (!this.webhookUsername || !this.webhookPassword) {
      this.logger?.error(
        "Postmark webhook rejected: webhookUsername/webhookPassword are not configured, cannot verify basic auth",
      );
      return false;
    }

    if (!headers) {
      this.logger?.warn("Postmark webhook rejected: headers unavailable for verification");
      return false;
    }

    // Header names are case-insensitive on the wire.
    const lower: Record<string, string> = {};
    for (const [key, val] of Object.entries(headers)) {
      if (Array.isArray(val)) lower[key.toLowerCase()] = val.join(" ");
      else if (val) lower[key.toLowerCase()] = val;
    }
    const authorization = lower["authorization"];
    if (!authorization || !authorization.startsWith("Basic ")) {
      this.logger?.warn("Postmark webhook rejected: missing basic-auth credentials");
      return false;
    }

    // Constant-time compare, so a wrong password costs the same as a right one.
    const expected = Buffer.from(`${this.webhookUsername}:${this.webhookPassword}`);
    const provided = Buffer.from(authorization.slice("Basic ".length), "base64");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      this.logger?.warn("Postmark webhook rejected: basic-auth credentials do not match");
      return false;
    }
    return true;
  }

  /**
   * Credential gate for the route the API mounts at `webhookPath`.
   *
   * Required, not optional: the mounted route answers 501 for a transport that
   * omits it, so without this `parseWebhook` is never reached at all.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean {
    void rawBody;
    return this.verifyBasicAuth(headers);
  }

  async parseWebhook(
    body: unknown,
    rawBody?: string,
    headers?: Record<string, string | string[] | undefined>,
  ): Promise<WebhookEvent[]> {
    // Verify again rather than trusting the caller's parse of the body. This
    // method is public and may be called directly, and a verified payload is
    // the only one worth acting on.
    if (!this.verifyBasicAuth(headers)) return [];
    void rawBody;

    // The bounce webhook posts one event per request, as a single JSON object.
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      this.logger?.warn("Postmark webhook payload is not a bounce event object");
      return [];
    }

    const mapped = this.mapEvent(body as Record<string, unknown>);
    return mapped ? [mapped] : [];
  }

  /**
   * Map one Postmark bounce webhook event onto a notifkit status, or null
   * when the event type is not one this transport tracks.
   */
  private mapEvent(entry: Record<string, unknown>): WebhookEvent | null {
    let status: WebhookEvent["status"];
    let bounceType: WebhookEvent["bounceType"];
    switch (entry.Type) {
      case "HardBounce":
        status = "bounced";
        bounceType = "hard";
        break;
      case "SoftBounce":
      case "Transient":
        status = "bounced";
        bounceType = "soft";
        break;
      case "SpamComplaint":
        status = "complained";
        break;
      default:
        this.logger?.debug({ type: entry.Type }, "Postmark webhook ignored (untracked event type)");
        return null;
    }

    // `MessageID` is the id the send returned, so the event correlates with
    // the delivery log. Without it the event cannot be tied to a send.
    const providerMessageId = entry.MessageID;
    if (typeof providerMessageId !== "string" || !providerMessageId) {
      this.logger?.warn("Postmark webhook event missing MessageID");
      return null;
    }

    const recipient = typeof entry.Email === "string" ? entry.Email : undefined;
    const timestamp =
      typeof entry.BouncedAt === "string" && entry.BouncedAt
        ? new Date(entry.BouncedAt)
        : new Date();

    this.logger?.info(
      { providerMessageId, status, type: entry.Type },
      "Postmark webhook mapped to notifkit status",
    );

    const metadata: Record<string, unknown> = {};
    if (typeof entry.Description === "string" && entry.Description) {
      metadata["description"] = entry.Description;
    }

    return {
      providerMessageId,
      status,
      timestamp,
      ...(recipient ? { recipient } : {}),
      ...(bounceType ? { bounceType } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  }
}

function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
  return `<p>${escaped.replace(/\r?\n/g, "<br>")}</p>`;
}

/**
 * The fields Postmark's send endpoint returns: `{ MessageID, ErrorCode,
 * Message }` on success, `{ ErrorCode, Message }` on a 422.
 */
interface PostmarkApiBody {
  MessageID?: unknown;
  ErrorCode?: unknown;
  Message?: unknown;
}

/**
 * Read Postmark's response body: `{ MessageID, ErrorCode, Message }` on
 * success, `{ ErrorCode, Message }` on a 422. A non-JSON body yields null
 * and the caller falls back to the HTTP status.
 */
async function parseJsonBody(res: Response): Promise<PostmarkApiBody | null> {
  try {
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text) as PostmarkApiBody;
  } catch {
    return null;
  }
}

/**
 * Whether a refusal with this HTTP status is final. A 4xx says the request
 * itself is wrong, so sending it again cannot succeed; 408 and 429 are the
 * exceptions (the request was fine, the moment was not), as is every 5xx.
 */
function isPermanentStatus(status: number | null | undefined): boolean {
  return (
    typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429
  );
}
