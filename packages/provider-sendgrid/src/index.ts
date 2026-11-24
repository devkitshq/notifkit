import { verify as cryptoVerify } from "node:crypto";
import type {
  DeliveryResult,
  Logger,
  NotificationDispatchedPayload,
  Transport,
  WebhookEvent,
} from "notifkit";

export interface SendGridTransportOptions {
  /** SendGrid API key (`Authorization: Bearer <apiKey>`). */
  apiKey: string;
  /**
   * Sender used for any template that does not name its own. A template may
   * override it with a `from` in its content — see `send`.
   */
  from: string;
  /**
   * SendGrid Event Webhook ECDSA public verification key (PEM or base64-encoded
   * SPKI DER from the SendGrid Mail Settings dashboard).
   */
  webhookPublicKey?: string;
  /** Override the SendGrid API base URL (defaults to `https://api.sendgrid.com`). */
  apiBaseUrl?: string;
  logger?: Logger;
  limits?: { limit: number; windowSeconds: number };
}

interface SendGridErrorResponse {
  errors?: Array<{ message?: string }>;
}

const DEFAULT_API_BASE_URL = "https://api.sendgrid.com";

export class SendGridTransport implements Transport {
  readonly channel = "email" as const;
  readonly webhookPath = "/webhooks/sendgrid";
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly apiKey: string;
  private readonly from: string;
  private readonly webhookPublicKey?: string;
  private readonly apiBaseUrl: string;
  private readonly logger?: Logger;

  constructor({
    apiKey,
    from,
    webhookPublicKey,
    apiBaseUrl = DEFAULT_API_BASE_URL,
    logger,
    limits = { limit: 1000, windowSeconds: 10 },
  }: SendGridTransportOptions) {
    this.apiKey = apiKey;
    this.from = from;
    this.webhookPublicKey = webhookPublicKey;
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
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

    const mailContent: Array<{ type: string; value: string }> = [];
    if (body !== undefined) {
      mailContent.push({ type: "text/plain", value: body });
    }
    if (htmlBody !== undefined) {
      mailContent.push({ type: "text/html", value: htmlBody });
    } else if (body !== undefined) {
      mailContent.push({ type: "text/html", value: textToHtml(body) });
    }

    const customHeaders = task.deliveryOptions?.headers;
    const payload: Record<string, unknown> = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from },
      subject: subject ?? "Notification",
      content: mailContent,
      ...(replyTo ? { reply_to: { email: replyTo } } : {}),
      ...(customHeaders && Object.keys(customHeaders).length > 0 ? { headers: customHeaders } : {}),
    };

    try {
      const response = await fetch(`${this.apiBaseUrl}/v3/mail/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errData = (await response.json().catch(() => null)) as SendGridErrorResponse | null;
        const message =
          errData?.errors?.map((e) => e.message).filter(Boolean).join("; ") ||
          `SendGrid API error (HTTP ${response.status})`;

        this.logger?.warn(
          { taskId: task.taskId, status: response.status, error: message },
          "SendGrid send failed",
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

      const providerMessageId = response.headers.get("x-message-id") ?? "";
      this.logger?.debug({ taskId: task.taskId, messageId: providerMessageId }, "SendGrid email sent");
      return { success: true, providerMessageId };
    } catch (err) {
      const error = err as Error;
      this.logger?.error({ taskId: task.taskId, error: error.message }, "SendGrid unexpected error");
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Verify SendGrid Event Webhook ECDSA signature over `timestamp + rawBody`.
   * Fail closed when `webhookPublicKey` is missing or headers are invalid.
   */
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    if (!this.webhookPublicKey) {
      this.logger?.error(
        "SendGrid webhook rejected: webhookPublicKey is not configured, cannot verify signature",
      );
      return false;
    }

    if (!rawBody || !headers) {
      this.logger?.warn("SendGrid webhook rejected: raw body or headers unavailable");
      return false;
    }

    const signature = getHeader(headers, "x-twilio-email-event-webhook-signature");
    const timestamp = getHeader(headers, "x-twilio-email-event-webhook-timestamp");
    if (!signature || !timestamp) {
      this.logger?.warn("SendGrid webhook rejected: missing signature headers");
      return false;
    }

    try {
      const pem = normalizePublicKey(this.webhookPublicKey);
      const payload = Buffer.from(`${timestamp}${rawBody}`, "utf8");
      const sigBuf = Buffer.from(signature, "base64");
      return cryptoVerify("sha256", payload, pem, sigBuf);
    } catch (err) {
      const error = err as Error;
      this.logger?.warn({ error: error.message }, "SendGrid webhook signature verification failed");
      return false;
    }
  }

  async parseWebhook(
    body: any,
    rawBody?: string,
    headers?: Record<string, string | string[] | undefined>,
  ): Promise<WebhookEvent[]> {
    const raw = rawBody ?? (typeof body === "string" ? body : JSON.stringify(body ?? []));
    if (!this.verifyWebhook(raw, headers ?? {})) {
      return [];
    }

    let eventsPayload = body;
    if (!Array.isArray(eventsPayload)) {
      try {
        eventsPayload = JSON.parse(raw);
      } catch {
        this.logger?.warn("SendGrid webhook payload is not valid JSON");
        return [];
      }
    }

    if (!Array.isArray(eventsPayload)) {
      this.logger?.warn("SendGrid webhook payload is not an array");
      return [];
    }

    const mapped: WebhookEvent[] = [];
    for (const entry of eventsPayload) {
      if (!entry || typeof entry !== "object") continue;

      const sgMessageId = typeof entry.sg_message_id === "string" ? entry.sg_message_id : "";
      if (!sgMessageId) continue;

      // SendGrid's sg_message_id starts with the X-Message-Id value (often followed by `.filter...`).
      const dotIndex = sgMessageId.indexOf(".");
      const providerMessageId = dotIndex > 0 ? sgMessageId.slice(0, dotIndex) : sgMessageId;

      let status: WebhookEvent["status"] | undefined;
      let bounceType: WebhookEvent["bounceType"] | undefined;

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
        case "open":
          status = "opened";
          break;
        case "click":
          status = "clicked";
          break;
        default:
          continue;
      }

      const recipient = typeof entry.email === "string" ? entry.email : undefined;
      const timestamp =
        typeof entry.timestamp === "number" ? new Date(entry.timestamp * 1000) : new Date();

      const metadata: Record<string, unknown> = { sgMessageId };
      if (typeof entry.reason === "string" && entry.reason) {
        metadata["bounceMessage"] = entry.reason;
      }
      if (status === "clicked" && typeof entry.url === "string" && entry.url) {
        metadata["url"] = entry.url;
      }

      mapped.push({
        providerMessageId,
        status,
        timestamp,
        ...(recipient ? { recipient } : {}),
        ...(bounceType ? { bounceType } : {}),
        metadata,
      });
    }

    return mapped;
  }
}

function normalizePublicKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.includes("BEGIN PUBLIC KEY")) return trimmed;
  return `-----BEGIN PUBLIC KEY-----\n${trimmed}\n-----END PUBLIC KEY-----`;
}

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      if (Array.isArray(value)) return value[0];
      return value;
    }
  }
  return undefined;
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
