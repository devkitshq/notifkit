import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { DeliveryResult, Logger, NotificationDispatchedPayload, Transport, WebhookEvent } from "notifkit";

const DEFAULT_API_BASE_URL = "https://api.nexmo.com";
const DEFAULT_WEBHOOK_PATH = "/webhooks/vonage";

export interface VonageTransportOptions {
  apiKey: string;
  apiSecret: string;
  /**
   * Default sender ID or phone number. A template may override it with `from`
   * in its rendered content.
   */
  from: string;
  /**
   * Signature secret configured in the Vonage dashboard for verifying HS256
   * JWTs on incoming Messages API status webhooks.
   *
   * Leave unset to send without delivery status webhooks; `webhookPath` is
   * only mounted when a signature secret is present so unsigned webhooks are
   * never accepted.
   */
  signatureSecret?: string;
  /** Webhook mount path (defaults to `/webhooks/vonage` when `signatureSecret` is set). */
  webhookPath?: string;
  /** Override the Vonage Messages API base URL (defaults to `https://api.nexmo.com`). */
  apiBaseUrl?: string;
  logger?: Logger;
  limits?: { limit: number; windowSeconds: number };
}

export class VonageTransport implements Transport {
  readonly channel = "sms" as const;
  readonly webhookPath?: string;
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly from: string;
  private readonly signatureSecret?: string;
  private readonly apiBaseUrl: string;
  private readonly logger?: Logger;

  constructor({
    apiKey,
    apiSecret,
    from,
    signatureSecret,
    webhookPath,
    apiBaseUrl = DEFAULT_API_BASE_URL,
    logger,
    limits = { limit: 30, windowSeconds: 1 },
  }: VonageTransportOptions) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.from = from;
    this.signatureSecret = signatureSecret;
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
    this.logger = logger;
    this.limits = limits;

    if (signatureSecret) {
      this.webhookPath = webhookPath ?? DEFAULT_WEBHOOK_PATH;
    }
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    const rawTo = task.destination?.trim();
    if (!rawTo) {
      return {
        success: false,
        retryable: false,
        error: "No destination (recipient phone number) on task",
      };
    }

    const content = task.renderedContent.content as Record<string, unknown>;
    const body =
      typeof content["text"] === "string" && content["text"]
        ? content["text"]
        : typeof content["body"] === "string" && content["body"]
          ? content["body"]
          : undefined;
    if (!body) {
      return { success: false, retryable: false, error: "No message body on task" };
    }

    const rawFrom =
      typeof content["from"] === "string" && content["from"] ? content["from"] : this.from;

    // Vonage Messages API expects phone numbers without a leading `+`.
    const to = stripLeadingPlus(rawTo);
    const from = stripLeadingPlus(rawFrom);
    const authHeader = `Basic ${Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString("base64")}`;

    try {
      const response = await fetch(`${this.apiBaseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          message_type: "text",
          channel: "sms",
          to,
          from,
          text: body,
        }),
      });

      const responseText = await response.text();
      let payload: Record<string, unknown> = {};
      if (responseText) {
        try {
          payload = JSON.parse(responseText) as Record<string, unknown>;
        } catch {
          // Non-JSON error bodies still surface via status text / raw body below.
        }
      }

      if (response.ok) {
        const messageUuid =
          typeof payload["message_uuid"] === "string" ? payload["message_uuid"] : undefined;
        this.logger?.debug(
          { taskId: task.taskId, messageId: messageUuid },
          "Vonage message accepted",
        );
        return {
          success: true,
          ...(messageUuid ? { providerMessageId: messageUuid } : {}),
        };
      }

      const detail =
        (typeof payload["detail"] === "string" && payload["detail"]) ||
        (typeof payload["title"] === "string" && payload["title"]) ||
        responseText ||
        `HTTP ${response.status}`;

      const permanent = isPermanentStatus(response.status);
      const invalidToken = isInvalidDestinationError(response.status, payload);

      this.logger?.warn(
        { taskId: task.taskId, status: response.status, error: detail, invalidToken },
        "Vonage send failed",
      );

      return {
        success: false,
        ...(invalidToken ? { invalidToken: true } : {}),
        ...(permanent || invalidToken ? { retryable: false } : {}),
        ...(response.status === 429 ? { throttled: true } : {}),
        error: detail,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn({ taskId: task.taskId, error: message }, "Vonage network error");
      return {
        success: false,
        error: message,
      };
    }
  }

  /**
   * Verifies Vonage Messages API status webhooks signed with HS256 JWT in the
   * `Authorization: Bearer <token>` header. Fails closed when the secret or
   * header is missing or invalid.
   */
  async verifyWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    if (!this.signatureSecret) {
      this.logger?.error(
        "Vonage webhook rejected: signatureSecret is not configured, cannot verify JWT",
      );
      return false;
    }

    const rawAuth = headers["authorization"] ?? headers["Authorization"];
    const authHeader = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      this.logger?.warn("Vonage webhook rejected: missing Bearer Authorization header");
      return false;
    }

    const token = authHeader.slice("Bearer ".length).trim();
    const parts = token.split(".");
    if (parts.length !== 3) {
      this.logger?.warn("Vonage webhook rejected: malformed JWT");
      return false;
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(base64UrlDecode(encodedHeader).toString("utf8")) as Record<
        string,
        unknown
      >;
      claims = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      this.logger?.warn("Vonage webhook rejected: unreadable JWT JSON");
      return false;
    }

    if (header["alg"] !== "HS256") {
      this.logger?.warn({ alg: header["alg"] }, "Vonage webhook rejected: unsupported JWT alg");
      return false;
    }

    const expectedSig = createHmac("sha256", this.signatureSecret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest();
    const providedSig = base64UrlDecode(encodedSignature);

    if (expectedSig.length !== providedSig.length || !timingSafeEqual(expectedSig, providedSig)) {
      this.logger?.warn("Vonage webhook JWT signature verification failed");
      return false;
    }

    if (typeof claims["exp"] === "number" && claims["exp"] * 1000 < Date.now()) {
      this.logger?.warn("Vonage webhook rejected: JWT expired");
      return false;
    }

    if (typeof claims["payload_hash"] === "string") {
      const actualHash = createHash("sha256").update(rawBody, "utf8").digest("hex");
      const expectedBuf = Buffer.from(claims["payload_hash"], "utf8");
      const actualBuf = Buffer.from(actualHash, "utf8");
      if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
        this.logger?.warn("Vonage webhook rejected: payload_hash mismatch");
        return false;
      }
    }

    return true;
  }

  async parseWebhook(
    body: unknown,
    rawBody?: string,
    headers?: Record<string, string | string[] | undefined>,
  ): Promise<WebhookEvent[]> {
    if (rawBody === undefined || !headers || !(await this.verifyWebhook(rawBody, headers))) {
      return [];
    }

    let payload: Record<string, unknown>;
    if (body && typeof body === "object") {
      payload = body as Record<string, unknown>;
    } else {
      try {
        payload = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return [];
      }
    }

    const providerMessageId =
      typeof payload["message_uuid"] === "string" ? payload["message_uuid"] : undefined;
    const messageStatus = typeof payload["status"] === "string" ? payload["status"] : undefined;

    if (!providerMessageId || !messageStatus) {
      this.logger?.warn("Vonage status webhook malformed or missing message_uuid/status");
      return [];
    }

    let status: WebhookEvent["status"];
    let bounceType: WebhookEvent["bounceType"] | undefined;

    switch (messageStatus) {
      case "rejected":
      case "undeliverable":
        status = "bounced";
        bounceType = "soft";
        break;
      case "read":
        status = "opened";
        break;
      default:
        // submitted, delivered — progress states the delivery log already tracks.
        this.logger?.debug(
          { messageStatus },
          "Vonage status webhook ignored (untracked message status)",
        );
        return [];
    }

    const recipient = typeof payload["to"] === "string" ? payload["to"] : undefined;
    const timestamp =
      typeof payload["timestamp"] === "string" && !Number.isNaN(Date.parse(payload["timestamp"]))
        ? new Date(payload["timestamp"])
        : new Date();

    const metadata: Record<string, unknown> = { messageStatus };
    if (payload["error"] && typeof payload["error"] === "object") {
      metadata["error"] = payload["error"];
    }

    return [
      {
        providerMessageId,
        status,
        timestamp,
        ...(recipient ? { recipient } : {}),
        ...(bounceType ? { bounceType } : {}),
        metadata,
      },
    ];
  }
}

function stripLeadingPlus(value: string): string {
  return value.startsWith("+") ? value.slice(1) : value;
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function isInvalidDestinationError(status: number, payload: Record<string, unknown>): boolean {
  if (status !== 422 && status !== 400) return false;
  const type = typeof payload["type"] === "string" ? payload["type"] : "";
  const detail = typeof payload["detail"] === "string" ? payload["detail"] : "";
  const combined = `${type} ${detail}`.toLowerCase();
  return (
    combined.includes("invalid-param") &&
    (combined.includes("`to`") || combined.includes("'to'") || combined.includes(" to "))
  );
}
