import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  DeliveryResult,
  Logger,
  NotificationDispatchedPayload,
  Transport,
  WebhookEvent,
} from "notifkit";

export interface MailgunTransportOptions {
  /** Mailgun API key used for HTTP Basic Auth (`api:<apiKey>`). */
  apiKey: string;
  /** Sending domain configured in Mailgun (e.g. `"mg.example.com"`). */
  domain: string;
  /**
   * Sender used for any template that does not name its own. A template may
   * override it with a `from` in its content — see `send`.
   */
  from: string;
  /**
   * Mailgun API base URL. Defaults to `"https://api.mailgun.net"`.
   * Set to `"https://api.eu.mailgun.net"` for EU region domains.
   */
  apiBaseUrl?: string;
  /** Mailgun HTTP webhook signing key used for HMAC-SHA256 verification. */
  webhookSigningKey?: string;
  logger?: Logger;
  limits?: { limit: number; windowSeconds: number };
}

interface MailgunSendResponse {
  id?: string;
  message?: string;
}

const DEFAULT_API_BASE_URL = "https://api.mailgun.net";

export class MailgunTransport implements Transport {
  readonly channel = "email" as const;
  readonly webhookPath = "/webhooks/mailgun";
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly apiKey: string;
  private readonly domain: string;
  private readonly from: string;
  private readonly apiBaseUrl: string;
  private readonly webhookSigningKey?: string;
  private readonly logger?: Logger;

  constructor({
    apiKey,
    domain,
    from,
    apiBaseUrl = DEFAULT_API_BASE_URL,
    webhookSigningKey,
    logger,
    limits = { limit: 1000, windowSeconds: 10 },
  }: MailgunTransportOptions) {
    this.apiKey = apiKey;
    this.domain = domain;
    this.from = from;
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
    this.webhookSigningKey = webhookSigningKey;
    this.logger = logger;
    this.limits = limits;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    const to = task.destination;
    if (!to) {
      return {
        success: false,
        retryable: false,
        error: "No destination (recipient address) on task",
      };
    }

    const content = task.renderedContent.content as Record<string, unknown>;
    const body =
      typeof content.text === "string"
        ? content.text
        : typeof content.body === "string"
          ? content.body
          : undefined;
    const subject = typeof content.subject === "string" ? content.subject : undefined;
    const htmlBody =
      typeof content.htmlBody === "string"
        ? content.htmlBody
        : typeof content.html === "string"
          ? content.html
          : undefined;

    const from = typeof content.from === "string" && content.from ? content.from : this.from;
    const replyTo =
      typeof content.replyTo === "string" && content.replyTo ? content.replyTo : undefined;

    const form = new URLSearchParams();
    form.set("from", from);
    form.set("to", to);
    form.set("subject", subject ?? "Notification");
    if (body !== undefined) {
      form.set("text", body);
    }
    if (htmlBody !== undefined) {
      form.set("html", htmlBody);
    } else if (body !== undefined) {
      form.set("html", textToHtml(body));
    }
    if (replyTo) {
      form.set("h:Reply-To", replyTo);
    }

    const customHeaders = task.deliveryOptions?.headers;
    if (customHeaders) {
      for (const [name, value] of Object.entries(customHeaders)) {
        form.set(`h:${name}`, value);
      }
    }

    const auth = Buffer.from(`api:${this.apiKey}`, "utf8").toString("base64");
    const url = `${this.apiBaseUrl}/v3/${encodeURIComponent(this.domain)}/messages`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      });

      const data = await parseJsonSafe(response);

      if (!response.ok) {
        const message =
          typeof data?.message === "string" && data.message
            ? data.message
            : `Mailgun API error (HTTP ${response.status})`;

        this.logger?.warn(
          { taskId: task.taskId, status: response.status, error: message },
          "Mailgun send failed",
        );

        if (response.status === 429) {
          return {
            success: false,
            throttled: true,
            error: message,
          };
        }

        return {
          success: false,
          ...(isPermanentStatus(response.status) ? { retryable: false } : {}),
          error: message,
        };
      }

      const providerMessageId = typeof data?.id === "string" ? data.id : "";
      this.logger?.debug({ taskId: task.taskId, messageId: providerMessageId }, "Mailgun email sent");
      return { success: true, providerMessageId };
    } catch (err) {
      const error = err as Error;
      this.logger?.error({ taskId: task.taskId, error: error.message }, "Mailgun unexpected error");
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Verify a Mailgun webhook payload using HMAC-SHA256 over `timestamp + token`
   * with `webhookSigningKey` and constant-time comparison. Fails closed when
   * the signing key is not configured or the signature is missing/invalid.
   */
  verifyWebhook(
    rawBody: string,
    _headers: Record<string, string | string[] | undefined>,
  ): boolean {
    if (!this.webhookSigningKey) {
      this.logger?.error(
        "Mailgun webhook rejected: webhookSigningKey is not configured, cannot verify signature",
      );
      return false;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      this.logger?.warn("Mailgun webhook rejected: raw body is not valid JSON");
      return false;
    }

    return this.verifySignatureObject(parsed?.signature);
  }

  private verifySignatureObject(sig: any): boolean {
    if (!this.webhookSigningKey) return false;
    if (
      !sig ||
      typeof sig.timestamp !== "string" ||
      typeof sig.token !== "string" ||
      typeof sig.signature !== "string"
    ) {
      this.logger?.warn("Mailgun webhook rejected: missing signature fields");
      return false;
    }

    const expectedHex = createHmac("sha256", this.webhookSigningKey)
      .update(`${sig.timestamp}${sig.token}`)
      .digest("hex");

    const actualBuf = Buffer.from(sig.signature.toLowerCase(), "utf8");
    const expectedBuf = Buffer.from(expectedHex.toLowerCase(), "utf8");

    if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
      this.logger?.warn("Mailgun webhook rejected: HMAC signature mismatch");
      return false;
    }

    return true;
  }

  async parseWebhook(
    body: any,
    rawBody?: string,
    _headers?: Record<string, string | string[] | undefined>,
  ): Promise<WebhookEvent[]> {
    let payload = body;
    if (typeof rawBody === "string" && rawBody.length > 0) {
      try {
        payload = JSON.parse(rawBody);
      } catch {
        this.logger?.warn("Mailgun webhook payload is not valid JSON");
        return [];
      }
    }

    if (!this.verifySignatureObject(payload?.signature)) {
      return [];
    }

    const eventData = payload?.["event-data"];
    if (!eventData || typeof eventData !== "object") {
      this.logger?.warn("Mailgun webhook payload missing event-data");
      return [];
    }

    const messageId: string | undefined =
      eventData.message?.headers?.["message-id"] ?? eventData.id;
    if (typeof messageId !== "string" || !messageId) {
      this.logger?.warn("Mailgun webhook payload missing message-id");
      return [];
    }

    const eventType: string | undefined = eventData.event;
    let status: WebhookEvent["status"] | undefined;
    let bounceType: WebhookEvent["bounceType"] | undefined;

    switch (eventType) {
      case "failed":
        status = "bounced";
        bounceType = eventData.severity === "permanent" ? "hard" : "soft";
        break;
      case "complained":
        status = "complained";
        break;
      case "opened":
        status = "opened";
        break;
      case "clicked":
        status = "clicked";
        break;
      case "unsubscribed":
        status = "unsubscribed";
        break;
      default:
        this.logger?.debug({ event: eventType }, "Mailgun webhook ignored (untracked event type)");
        return [];
    }

    const recipient = typeof eventData.recipient === "string" ? eventData.recipient : undefined;
    const timestamp =
      typeof eventData.timestamp === "number"
        ? new Date(eventData.timestamp * 1000)
        : new Date();

    const metadata: Record<string, unknown> = {};
    if (typeof eventData.severity === "string") metadata["severity"] = eventData.severity;
    if (typeof eventData.reason === "string") metadata["reason"] = eventData.reason;
    if (typeof eventData["delivery-status"]?.message === "string") {
      metadata["bounceMessage"] = eventData["delivery-status"].message;
    } else if (typeof eventData["delivery-status"]?.description === "string") {
      metadata["bounceMessage"] = eventData["delivery-status"].description;
    }
    if (status === "clicked" && typeof eventData.url === "string" && eventData.url) {
      metadata["url"] = eventData.url;
    }

    this.logger?.info(
      { providerMessageId: messageId, status, event: eventType },
      "Mailgun webhook mapped to notifkit status",
    );

    return [
      {
        providerMessageId: messageId,
        status,
        timestamp,
        ...(recipient ? { recipient } : {}),
        ...(bounceType ? { bounceType } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      },
    ];
  }
}

async function parseJsonSafe(response: Response): Promise<MailgunSendResponse | null> {
  try {
    return (await response.json()) as MailgunSendResponse;
  } catch {
    return null;
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

function isPermanentStatus(status: number | null | undefined): boolean {
  return (
    typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429
  );
}
