import { verify as verifySignature } from "node:crypto";
import type { DeliveryResult, Transport } from "notifkit";
import type { NotificationDispatchedPayload, Logger } from "notifkit";
import type { WebhookEvent } from "notifkit";

export interface SendGridTransportOptions {
  apiKey: string;
  /**
   * Sender used for any template that does not name its own. A template may
   * override it with a `from` in its content — see `send`.
   */
  from: string;
  logger?: Logger;
  /**
   * PEM public key from the SendGrid dashboard (Settings > Mail Settings >
   * Event Settings > Signed Event Webhook). Required for `verifyWebhook` and
   * `parseWebhook`: without it every webhook is rejected.
   */
  webhookPublicKey?: string;
  limits?: { limit: number; windowSeconds: number };
}

/** SendGrid Mail Send endpoint. */
const SEND_URL = "https://api.sendgrid.com/v3/mail/send";

/**
 * Error `field` values that name the recipient address. A refusal pointing
 * at `personalizations.<n>.to.<m>.email` means the destination itself is
 * dead, so notifkit deactivates the contact instead of retrying. A refusal
 * pointing anywhere else (a rejected sender, a bad template) is permanent
 * but says nothing about the destination.
 */
const DEAD_DESTINATION_FIELD = /^personalizations\.\d+\.to\.\d+\.email$/;

export class SendGridTransport implements Transport {
  readonly channel = "email" as const;
  readonly webhookPath = "/webhooks/sendgrid";
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly apiKey: string;
  private readonly from: string;
  private readonly logger?: Logger;
  private readonly webhookPublicKey?: string;

  constructor({
    apiKey,
    from,
    logger,
    webhookPublicKey,
    limits = { limit: 1000, windowSeconds: 10 },
  }: SendGridTransportOptions) {
    this.apiKey = apiKey;
    this.from = from;
    this.logger = logger;
    this.webhookPublicKey = webhookPublicKey;
    this.limits = limits;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    // `destination` is optional on the contract, so a malformed task can reach
    // a transport without one. Failing here costs one clear error; passing
    // `undefined` to SendGrid costs an opaque provider rejection and a retry cycle.
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
    // mail. Passing them through is what makes the inbox render a real
    // unsubscribe button instead of leaving the recipient the spam key.
    const headers = task.deliveryOptions?.headers;

    // SendGrid needs at least one content part. A text-only template gets an
    // HTML part built from its text. The text was rendered unescaped (it is
    // plain text), so it is escaped here — otherwise a variable holding
    // markup becomes live HTML in the email.
    const parts: { type: string; value: string }[] = [];
    if (typeof body === "string") parts.push({ type: "text/plain", value: body });
    if (typeof htmlBody === "string") {
      parts.push({ type: "text/html", value: htmlBody });
    } else if (typeof body === "string") {
      parts.push({ type: "text/html", value: textToHtml(body) });
    }
    if (parts.length === 0) parts.push({ type: "text/plain", value: "" });

    try {
      const res = await fetch(SEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: from },
          subject: subject ?? "Notification",
          content: parts,
          ...(replyTo ? { reply_to: { email: replyTo } } : {}),
          ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
        }),
      });

      if (res.status === 202) {
        // 202 carries an empty body; the message id is the X-Message-Id header.
        const providerMessageId = res.headers.get("x-message-id") ?? "";
        this.logger?.debug({ taskId: task.taskId, providerMessageId }, "SendGrid email sent");
        return { success: true, providerMessageId };
      }

      const errors = await parseErrorBody(res);
      const message = errors
        .map((e) => e.message)
        .filter(Boolean)
        .join("; ");
      const error = message || `SendGrid error ${res.status}`;
      const invalidToken = errors.some((e) => DEAD_DESTINATION_FIELD.test(e.field ?? ""));
      const permanent = invalidToken || isPermanentStatus(res.status);

      this.logger?.warn(
        { taskId: task.taskId, status: res.status, error, invalidToken },
        "SendGrid send failed",
      );

      return {
        success: false,
        invalidToken,
        ...(permanent ? { retryable: false } : {}),
        error,
      };
    } catch (err) {
      const error = err as Error;
      this.logger?.error(
        { taskId: task.taskId, error: error.message },
        "SendGrid unexpected error",
      );

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Check the ECDSA signature on a signed event webhook and return whether
   * it verifies, or false.
   *
   * Fail closed. An unverified webhook is an anonymous, forgeable write into
   * delivery history, so a missing public key or missing request data is a
   * reason to drop the event — never a reason to trust it. The signed payload
   * is the `X-Twilio-Email-Event-Webhook-Timestamp` header concatenated with
   * the raw request body.
   */
  private verifySignature(
    rawBody: string | undefined,
    headers: Record<string, string | string[] | undefined> | undefined,
  ): boolean {
    if (!this.webhookPublicKey) {
      this.logger?.error(
        "SendGrid webhook rejected: webhookPublicKey is not configured, cannot verify signature",
      );
      return false;
    }

    if (!rawBody || !headers) {
      this.logger?.warn(
        "SendGrid webhook rejected: raw body or headers unavailable for verification",
      );
      return false;
    }

    // Header names are case-insensitive on the wire.
    const lower: Record<string, string> = {};
    for (const [key, val] of Object.entries(headers)) {
      if (Array.isArray(val)) lower[key.toLowerCase()] = val.join(" ");
      else if (val) lower[key.toLowerCase()] = val;
    }
    const signature = lower["x-twilio-email-event-webhook-signature"];
    const timestamp = lower["x-twilio-email-event-webhook-timestamp"];

    if (!signature || !timestamp) {
      this.logger?.warn("SendGrid webhook rejected: missing signature headers");
      return false;
    }

    try {
      // Node's built-in ECDSA verify is enough — no new dependency. The
      // signature is base64 DER, the key is the PEM public key from the
      // SendGrid dashboard.
      return verifySignature(
        "sha256",
        Buffer.from(timestamp + rawBody),
        this.webhookPublicKey,
        Buffer.from(signature, "base64"),
      );
    } catch (err: any) {
      this.logger?.warn({ error: err.message }, "SendGrid webhook signature verification failed");
      return false;
    }
  }

  /**
   * Signature gate for the route the API mounts at `webhookPath`.
   *
   * Required, not optional: the mounted route answers 501 for a transport that
   * omits it, so without this `parseWebhook` is never reached at all.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean {
    return this.verifySignature(rawBody, headers);
  }

  async parseWebhook(
    body: any,
    rawBody?: string,
    headers?: Record<string, string | string[] | undefined>,
  ): Promise<WebhookEvent[]> {
    // Verify again rather than trusting the caller's parse of the body. This
    // method is public and may be called directly, and a verified payload is
    // the only one worth acting on.
    if (!this.verifySignature(rawBody, headers)) return [];

    // The event webhook posts an array of events, one per delivery event.
    if (!Array.isArray(body)) {
      this.logger?.warn("SendGrid webhook payload is not an array of events");
      return [];
    }

    const events: WebhookEvent[] = [];
    for (const entry of body) {
      const mapped = this.mapEvent(entry);
      if (mapped) events.push(mapped);
    }
    return events;
  }

  /**
   * Map one SendGrid event onto a notifkit status, or null when the event
   * type is not one this transport tracks.
   */
  private mapEvent(entry: any): WebhookEvent | null {
    if (!entry || typeof entry !== "object") {
      this.logger?.debug("SendGrid webhook ignored (entry is not an object)");
      return null;
    }

    let status: WebhookEvent["status"];
    let bounceType: WebhookEvent["bounceType"];
    switch (entry.event) {
      case "bounce":
        status = "bounced";
        bounceType = "hard";
        break;
      case "blocked":
      case "deferred":
        status = "bounced";
        bounceType = "soft";
        break;
      case "spamreport":
        status = "complained";
        break;
      case "unsubscribe":
        status = "unsubscribed";
        break;
      default:
        this.logger?.debug(
          { type: entry.event },
          "SendGrid webhook ignored (untracked event type)",
        );
        return null;
    }

    // `sg_message_id` starts with the X-Message-Id the send returned, so the
    // event correlates with the delivery log on that prefix.
    const providerMessageId = entry.sg_message_id;
    if (typeof providerMessageId !== "string" || !providerMessageId) {
      this.logger?.warn("SendGrid webhook event missing sg_message_id");
      return null;
    }

    const recipient = typeof entry.email === "string" ? entry.email : undefined;
    const timestamp =
      typeof entry.timestamp === "number" ? new Date(entry.timestamp * 1000) : new Date();

    this.logger?.info(
      { providerMessageId, status, type: entry.event },
      "SendGrid webhook mapped to notifkit status",
    );

    return {
      providerMessageId,
      status,
      timestamp,
      ...(recipient ? { recipient } : {}),
      ...(bounceType ? { bounceType } : {}),
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
 * Read SendGrid's error body: `{"errors": [{"message", "field", "help"}]}`.
 * A non-JSON body falls back to the raw text as a single message.
 */
async function parseErrorBody(res: Response): Promise<{ message?: string; field?: string }[]> {
  const text = await res.text().catch(() => "");
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { errors?: { message?: string; field?: string }[] };
    if (Array.isArray(parsed.errors)) return parsed.errors;
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return [{ message: text }];
}

/**
 * Whether a refusal with this HTTP status is final. A 4xx says the request
 * itself is wrong, so sending it again cannot succeed; 408 and 429 are the
 * exceptions (the request was fine, the moment was not), as is every 5xx.
 */
function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
