import { createHmac, timingSafeEqual } from "node:crypto";
import type { DeliveryResult, Transport } from "notifkit";
import type { NotificationDispatchedPayload, Logger } from "notifkit";
import type { WebhookEvent } from "notifkit";

export interface MailgunTransportOptions {
  /** Mailgun API key (Sending > API keys). Sent as basic auth `api:<key>`. */
  apiKey: string;
  /** Mailgun domain the mail is sent from (e.g. `mg.example.com`). */
  domain: string;
  /**
   * Sender used for any template that does not name its own. A template may
   * override it with a `from` in its content — see `send`.
   */
  from: string;
  logger?: Logger;
  /**
   * API base URL. Defaults to `https://api.mailgun.net`; EU accounts use
   * `https://api.eu.mailgun.net`.
   */
  baseUrl?: string;
  /**
   * Webhook signing key from the Mailgun dashboard (Settings > Webhooks >
   * Signing key). Required for `verifyWebhook` and `parseWebhook`: without it
   * every webhook is rejected.
   */
  webhookSigningKey?: string;
  limits?: { limit: number; windowSeconds: number };
}

/** Default Mailgun API base URL (US region). */
const DEFAULT_BASE_URL = "https://api.mailgun.net";

export class MailgunTransport implements Transport {
  readonly channel = "email" as const;
  readonly webhookPath = "/webhooks/mailgun";
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly apiKey: string;
  private readonly domain: string;
  private readonly from: string;
  private readonly logger?: Logger;
  private readonly baseUrl: string;
  private readonly webhookSigningKey?: string;

  constructor({
    apiKey,
    domain,
    from,
    logger,
    baseUrl = DEFAULT_BASE_URL,
    webhookSigningKey,
    limits = { limit: 1000, windowSeconds: 10 },
  }: MailgunTransportOptions) {
    this.apiKey = apiKey;
    this.domain = domain;
    this.from = from;
    this.logger = logger;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.webhookSigningKey = webhookSigningKey;
    this.limits = limits;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    // `destination` is optional on the contract, so a malformed task can reach
    // a transport without one. Failing here costs one clear error; passing
    // `undefined` to Mailgun costs an opaque provider rejection and a retry cycle.
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
    // Mailgun takes custom headers as `h:`-prefixed form fields.
    const headers = task.deliveryOptions?.headers;

    // Mailgun takes a form-encoded body. A text-only template gets an HTML
    // part built from its text. The text was rendered unescaped (it is plain
    // text), so it is escaped here — otherwise a variable holding markup
    // becomes live HTML in the email.
    const form = new URLSearchParams();
    form.set("from", from);
    form.set("to", to);
    form.set("subject", subject ?? "Notification");
    if (typeof body === "string") form.set("text", body);
    if (typeof htmlBody === "string") {
      form.set("html", htmlBody);
    } else if (typeof body === "string") {
      form.set("html", textToHtml(body));
    }
    if (replyTo) form.set("h:Reply-To", replyTo);
    if (headers && Object.keys(headers).length > 0) {
      for (const [name, value] of Object.entries(headers)) form.set(`h:${name}`, value);
    }

    try {
      const res = await fetch(`${this.baseUrl}/v3/${this.domain}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${this.apiKey}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      });

      if (res.ok) {
        // 200 carries `{ "id": "<...>", "message": "Queued. Thank you." }`;
        // the id is the providerMessageId the webhook later reports.
        const data = (await res.json().catch(() => ({}))) as { id?: string };
        const providerMessageId = typeof data.id === "string" ? data.id : "";
        this.logger?.debug({ taskId: task.taskId, providerMessageId }, "Mailgun email sent");
        return { success: true, providerMessageId };
      }

      const error = await parseErrorBody(res);
      const permanent = isPermanentStatus(res.status);

      this.logger?.warn(
        { taskId: task.taskId, status: res.status, error },
        "Mailgun send failed",
      );

      return {
        success: false,
        invalidToken: false,
        ...(permanent ? { retryable: false } : {}),
        error,
      };
    } catch (err) {
      const error = err as Error;
      this.logger?.error(
        { taskId: task.taskId, error: error.message },
        "Mailgun unexpected error",
      );

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Check the HMAC-SHA256 signature on a Mailgun webhook and return whether
   * it verifies, or false. Mailgun signs `timestamp + token` with the webhook
   * signing key and puts `{ timestamp, token, signature }` in the body, so
   * the raw body — not the headers — carries the proof.
   *
   * Fail closed. An unverified webhook is an anonymous, forgeable write into
   * delivery history, so a missing signing key, an unparseable body or a
   * missing signature field is a reason to drop the event — never a reason
   * to trust it.
   */
  private verifySignature(rawBody: string | undefined): boolean {
    if (!this.webhookSigningKey) {
      this.logger?.error(
        "Mailgun webhook rejected: webhookSigningKey is not configured, cannot verify signature",
      );
      return false;
    }

    if (!rawBody) {
      this.logger?.warn("Mailgun webhook rejected: raw body unavailable for verification");
      return false;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      this.logger?.warn("Mailgun webhook rejected: raw body is not JSON");
      return false;
    }

    const signature = parsed?.signature;
    const timestamp = signature?.timestamp;
    const token = signature?.token;
    const expected = signature?.signature;

    if (
      typeof timestamp !== "string" ||
      typeof token !== "string" ||
      typeof expected !== "string"
    ) {
      this.logger?.warn("Mailgun webhook rejected: missing signature fields");
      return false;
    }

    // Node's built-in HMAC is enough — no new dependency.
    const computed = createHmac("sha256", this.webhookSigningKey)
      .update(`${timestamp}${token}`)
      .digest("hex");

    if (expected.length !== computed.length) return false;
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(computed));
    } catch (err: any) {
      this.logger?.warn({ error: err.message }, "Mailgun webhook signature check failed");
      return false;
    }
  }

  /**
   * Signature gate for the route the API mounts at `webhookPath`.
   *
   * Required, not optional: the mounted route answers 501 for a transport that
   * omits it, so without this `parseWebhook` is never reached at all.
   */
  verifyWebhook(
    rawBody: string,
    _headers: Record<string, string | string[] | undefined>,
  ): boolean {
    return this.verifySignature(rawBody);
  }

  async parseWebhook(
    body: any,
    rawBody?: string,
    _headers?: Record<string, string | string[] | undefined>,
  ): Promise<WebhookEvent[]> {
    // Verify again rather than trusting the caller's parse of the body. This
    // method is public and may be called directly, and a verified payload is
    // the only one worth acting on.
    if (!this.verifySignature(rawBody)) return [];

    // Mailgun wraps the event in `event-data`; accept a bare event too.
    const data = body?.["event-data"] ?? body;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      this.logger?.warn("Mailgun webhook payload has no event data");
      return [];
    }

    const mapped = this.mapEvent(data);
    return mapped ? [mapped] : [];
  }

  /**
   * Map one Mailgun event onto a notifkit status, or null when the event
   * type is not one this transport tracks.
   */
  private mapEvent(data: any): WebhookEvent | null {
    if (!data || typeof data !== "object") {
      this.logger?.debug("Mailgun webhook ignored (entry is not an object)");
      return null;
    }

    let status: WebhookEvent["status"];
    let bounceType: WebhookEvent["bounceType"];
    switch (data.event) {
      case "failed":
        status = "bounced";
        // Anything not explicitly permanent is treated as soft, so an
        // unrecognised severity never suppresses a working address.
        bounceType = data.severity === "permanent" ? ("hard" as const) : ("soft" as const);
        break;
      case "complained":
        status = "complained";
        break;
      default:
        this.logger?.debug(
          { type: data.event },
          "Mailgun webhook ignored (untracked event type)",
        );
        return null;
    }

    // `message.headers.message-id` is the id the send returned, so the event
    // correlates with the delivery log.
    const messageHeaders = data.message?.headers;
    const providerMessageId =
      messageHeaders?.["message-id"] ?? messageHeaders?.["Message-Id"];
    if (typeof providerMessageId !== "string" || !providerMessageId) {
      this.logger?.warn("Mailgun webhook event missing message-id");
      return null;
    }

    const recipient = typeof data.recipient === "string" ? data.recipient : undefined;
    const timestamp =
      typeof data.timestamp === "number" ? new Date(data.timestamp * 1000) : new Date();

    this.logger?.info(
      { providerMessageId, status, type: data.event },
      "Mailgun webhook mapped to notifkit status",
    );

    const metadata: Record<string, unknown> = {};
    if (typeof data.severity === "string") metadata["severity"] = data.severity;
    const bounceMessage = data["delivery-status"]?.description;
    if (typeof bounceMessage === "string" && bounceMessage) {
      metadata["bounceMessage"] = bounceMessage;
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
 * Read Mailgun's error body: `{"message": "..."}`.
 * A non-JSON body falls back to the raw text as a single message.
 */
async function parseErrorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return `Mailgun error ${res.status}`;
  try {
    const parsed = JSON.parse(text) as { message?: string };
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return text;
}

/**
 * Whether a refusal with this HTTP status is final. A 4xx says the request
 * itself is wrong, so sending it again cannot succeed; 408 and 429 are the
 * exceptions (the request was fine, the moment was not), as is every 5xx.
 */
function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
