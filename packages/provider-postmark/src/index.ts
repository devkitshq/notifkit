import { timingSafeEqual } from "node:crypto";
import type {
  DeliveryResult,
  Logger,
  NotificationDispatchedPayload,
  Transport,
  WebhookEvent,
} from "notifkit";

export interface PostmarkWebhookBasicAuth {
  username: string;
  password: string;
}

export interface PostmarkTransportOptions {
  /** Postmark Server API token sent in `X-Postmark-Server-Token`. */
  serverToken: string;
  /**
   * Sender used for any template that does not name its own. A template may
   * override it with a `from` in its content — see `send`.
   */
  from: string;
  /** Optional Postmark Message Stream ID (e.g. `"outbound"`). */
  messageStream?: string;
  /**
   * HTTP Basic Auth credentials configured in the Postmark webhook URL.
   * Postmark does not sign webhook requests, so Basic Auth is used to verify
   * incoming events.
   */
  webhookBasicAuth?: PostmarkWebhookBasicAuth;
  /** Override the Postmark API base URL (defaults to `https://api.postmarkapp.com`). */
  apiBaseUrl?: string;
  logger?: Logger;
  limits?: { limit: number; windowSeconds: number };
}

interface PostmarkSendResponse {
  MessageID?: string;
  ErrorCode?: number;
  Message?: string;
}

const DEFAULT_API_BASE_URL = "https://api.postmarkapp.com";
const POSTMARK_INACTIVE_RECIPIENT_CODE = 406;

export class PostmarkTransport implements Transport {
  readonly channel = "email" as const;
  readonly webhookPath = "/webhooks/postmark";
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly serverToken: string;
  private readonly from: string;
  private readonly messageStream?: string;
  private readonly webhookBasicAuth?: PostmarkWebhookBasicAuth;
  private readonly apiBaseUrl: string;
  private readonly logger?: Logger;

  constructor({
    serverToken,
    from,
    messageStream,
    webhookBasicAuth,
    apiBaseUrl = DEFAULT_API_BASE_URL,
    logger,
    limits = { limit: 1000, windowSeconds: 10 },
  }: PostmarkTransportOptions) {
    this.serverToken = serverToken;
    this.from = from;
    this.messageStream = messageStream;
    this.webhookBasicAuth = webhookBasicAuth;
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

    const customHeaders = task.deliveryOptions?.headers;
    const postmarkHeaders =
      customHeaders && Object.keys(customHeaders).length > 0
        ? Object.entries(customHeaders).map(([Name, Value]) => ({ Name, Value }))
        : undefined;

    const payload: Record<string, unknown> = {
      From: from,
      To: to,
      Subject: subject ?? "Notification",
      ...(htmlBody !== undefined
        ? { HtmlBody: htmlBody }
        : body !== undefined
          ? { HtmlBody: textToHtml(body) }
          : {}),
      ...(body !== undefined ? { TextBody: body } : {}),
      ...(replyTo ? { ReplyTo: replyTo } : {}),
      ...(this.messageStream ? { MessageStream: this.messageStream } : {}),
      ...(postmarkHeaders ? { Headers: postmarkHeaders } : {}),
    };

    try {
      const response = await fetch(`${this.apiBaseUrl}/email`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": this.serverToken,
        },
        body: JSON.stringify(payload),
      });

      const data = await parseJsonSafe(response);

      if (!response.ok || (typeof data?.ErrorCode === "number" && data.ErrorCode !== 0)) {
        const message =
          typeof data?.Message === "string" && data.Message
            ? data.Message
            : `Postmark API error (HTTP ${response.status})`;

        this.logger?.warn(
          { taskId: task.taskId, status: response.status, errorCode: data?.ErrorCode, error: message },
          "Postmark send failed",
        );

        if (data?.ErrorCode === POSTMARK_INACTIVE_RECIPIENT_CODE) {
          return {
            success: false,
            retryable: false,
            invalidToken: true,
            error: message,
          };
        }

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

      const providerMessageId = typeof data?.MessageID === "string" ? data.MessageID : "";
      this.logger?.debug({ taskId: task.taskId, messageId: providerMessageId }, "Postmark email sent");
      return { success: true, providerMessageId };
    } catch (err) {
      const error = err as Error;
      this.logger?.error({ taskId: task.taskId, error: error.message }, "Postmark unexpected error");
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Verify incoming Postmark webhooks via HTTP Basic Auth credentials.
   * Fail closed when credentials are not configured or do not match.
   */
  verifyWebhook(
    _rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    if (!this.webhookBasicAuth) {
      this.logger?.error(
        "Postmark webhook rejected: webhookBasicAuth is not configured, cannot verify request",
      );
      return false;
    }

    if (!headers) {
      this.logger?.warn("Postmark webhook rejected: headers unavailable for verification");
      return false;
    }

    const authHeader = getHeader(headers, "authorization");
    if (!authHeader || !authHeader.startsWith("Basic ")) {
      this.logger?.warn("Postmark webhook rejected: missing or non-Basic Authorization header");
      return false;
    }

    const encoded = authHeader.slice("Basic ".length).trim();
    const expected = Buffer.from(
      `${this.webhookBasicAuth.username}:${this.webhookBasicAuth.password}`,
      "utf8",
    ).toString("base64");

    const actualBuf = Buffer.from(encoded, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");

    if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
      this.logger?.warn("Postmark webhook rejected: invalid Basic Auth credentials");
      return false;
    }

    return true;
  }

  async parseWebhook(
    body: any,
    rawBody?: string,
    headers?: Record<string, string | string[] | undefined>,
  ): Promise<WebhookEvent[]> {
    if (!this.verifyWebhook(rawBody ?? "", headers ?? {})) {
      return [];
    }

    if (!body || typeof body !== "object") {
      this.logger?.warn("Postmark webhook payload malformed");
      return [];
    }

    const messageId = typeof body.MessageID === "string" ? body.MessageID : undefined;
    if (!messageId) {
      this.logger?.warn("Postmark webhook payload missing MessageID");
      return [];
    }

    const recordType = typeof body.RecordType === "string" ? body.RecordType : undefined;
    const type = typeof body.Type === "string" ? body.Type : undefined;

    let status: WebhookEvent["status"] | undefined;
    let bounceType: WebhookEvent["bounceType"] | undefined;

    if (type === "SpamComplaint" || recordType === "SpamComplaint") {
      status = "complained";
    } else if (
      type === "HardBounce" ||
      type === "Transient" ||
      type === "SoftBounce" ||
      recordType === "Bounce"
    ) {
      status = "bounced";
      bounceType = type === "HardBounce" ? "hard" : "soft";
    } else if (recordType === "Open") {
      status = "opened";
    } else if (recordType === "Click") {
      status = "clicked";
    } else if (recordType === "SubscriptionChange" && body.SuppressSending === true) {
      status = "unsubscribed";
    } else {
      this.logger?.debug(
        { recordType, type },
        "Postmark webhook ignored (untracked event type)",
      );
      return [];
    }

    const recipient =
      typeof body.Email === "string"
        ? body.Email
        : typeof body.Recipient === "string"
          ? body.Recipient
          : undefined;

    const rawTimestamp = body.BouncedAt ?? body.ReceivedAt ?? body.ChangedAt;
    const timestamp = typeof rawTimestamp === "string" ? new Date(rawTimestamp) : new Date();

    const metadata: Record<string, unknown> = {};
    if (type) metadata["bounceType"] = type;
    if (typeof body.Description === "string" && body.Description) {
      metadata["bounceMessage"] = body.Description;
    } else if (typeof body.Details === "string" && body.Details) {
      metadata["bounceMessage"] = body.Details;
    }
    if (status === "clicked" && typeof body.OriginalLink === "string" && body.OriginalLink) {
      metadata["url"] = body.OriginalLink;
    }

    this.logger?.info(
      { providerMessageId: messageId, status, recordType, type },
      "Postmark webhook mapped to notifkit status",
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

async function parseJsonSafe(response: Response): Promise<PostmarkSendResponse | null> {
  try {
    return (await response.json()) as PostmarkSendResponse;
  } catch {
    return null;
  }
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
