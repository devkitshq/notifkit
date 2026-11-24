import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type {
  DeliveryResult,
  Logger,
  NotificationDispatchedPayload,
  Transport,
  WebhookEvent,
} from "notifkit";

export interface TelnyxTransportOptions {
  /** Telnyx v2 API key (`Authorization: Bearer <apiKey>`). */
  apiKey: string;
  /** Default E.164 sender phone number. */
  from?: string;
  /** Optional Telnyx Messaging Profile ID (`messaging_profile_id`). */
  messagingProfileId?: string;
  /**
   * Ed25519 public key from the Telnyx portal (PEM, base64 SPKI DER, or
   * base64-encoded 32-byte raw Ed25519 public key).
   */
  webhookPublicKey?: string;
  /** Override the Telnyx API base URL (defaults to `https://api.telnyx.com`). */
  apiBaseUrl?: string;
  logger?: Logger;
  limits?: { limit: number; windowSeconds: number };
}

interface TelnyxResponse {
  data?: { id?: string };
  errors?: Array<{ detail?: string; title?: string; code?: string }>;
}

const DEFAULT_API_BASE_URL = "https://api.telnyx.com";
const E164_RE = /^\+[1-9]\d{1,14}$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class TelnyxTransport implements Transport {
  readonly channel = "sms" as const;
  readonly webhookPath = "/webhooks/telnyx";
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly apiKey: string;
  private readonly from?: string;
  private readonly messagingProfileId?: string;
  private readonly webhookPublicKey?: string;
  private readonly apiBaseUrl: string;
  private readonly logger?: Logger;

  constructor({
    apiKey,
    from,
    messagingProfileId,
    webhookPublicKey,
    apiBaseUrl = DEFAULT_API_BASE_URL,
    logger,
    limits = { limit: 1000, windowSeconds: 10 },
  }: TelnyxTransportOptions) {
    this.apiKey = apiKey;
    this.from = from;
    this.messagingProfileId = messagingProfileId;
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
        error: "No destination (recipient phone number) on task",
      };
    }

    if (!E164_RE.test(to)) {
      return {
        success: false,
        retryable: false,
        error: `Invalid E.164 phone number "${to}"`,
      };
    }

    const content = task.renderedContent.content as Record<string, unknown>;
    const text =
      typeof content.text === "string"
        ? content.text
        : typeof content.body === "string"
          ? content.body
          : "";
    const from = typeof content.from === "string" && content.from ? content.from : this.from;

    const payload: Record<string, unknown> = {
      to,
      text,
      ...(from ? { from } : {}),
      ...(this.messagingProfileId ? { messaging_profile_id: this.messagingProfileId } : {}),
    };

    try {
      const response = await fetch(`${this.apiBaseUrl}/v2/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = (await response.json().catch(() => null)) as TelnyxResponse | null;

      if (!response.ok) {
        const message =
          data?.errors
            ?.map((e) => e.detail || e.title)
            .filter(Boolean)
            .join("; ") || `Telnyx API error (HTTP ${response.status})`;

        this.logger?.warn(
          { taskId: task.taskId, status: response.status, error: message },
          "Telnyx send failed",
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

      const providerMessageId = typeof data?.data?.id === "string" ? data.data.id : "";
      this.logger?.debug({ taskId: task.taskId, messageId: providerMessageId }, "Telnyx SMS sent");
      return { success: true, providerMessageId };
    } catch (err) {
      const error = err as Error;
      this.logger?.error({ taskId: task.taskId, error: error.message }, "Telnyx unexpected error");
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Verify Telnyx webhook Ed25519 signature over `${timestamp}|${rawBody}`.
   * Fail closed when `webhookPublicKey` or headers are missing/invalid.
   */
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    if (!this.webhookPublicKey) {
      this.logger?.error(
        "Telnyx webhook rejected: webhookPublicKey is not configured, cannot verify signature",
      );
      return false;
    }

    if (!rawBody || !headers) {
      this.logger?.warn("Telnyx webhook rejected: raw body or headers unavailable");
      return false;
    }

    const signature = getHeader(headers, "telnyx-signature-ed25519");
    const timestamp = getHeader(headers, "telnyx-timestamp");
    if (!signature || !timestamp) {
      this.logger?.warn("Telnyx webhook rejected: missing signature headers");
      return false;
    }

    try {
      const key = toEd25519PublicKey(this.webhookPublicKey);
      const signedPayload = Buffer.from(`${timestamp}|${rawBody}`, "utf8");
      const sigBuf = Buffer.from(signature, "base64");
      return cryptoVerify(null, signedPayload, key, sigBuf);
    } catch (err) {
      const error = err as Error;
      this.logger?.warn({ error: error.message }, "Telnyx webhook signature verification failed");
      return false;
    }
  }

  async parseWebhook(
    body: any,
    rawBody?: string,
    headers?: Record<string, string | string[] | undefined>,
  ): Promise<WebhookEvent[]> {
    const raw = rawBody ?? (typeof body === "string" ? body : JSON.stringify(body ?? {}));
    if (!this.verifyWebhook(raw, headers ?? {})) {
      return [];
    }

    let parsed = body;
    if (!parsed || typeof parsed !== "object") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.logger?.warn("Telnyx webhook payload is not valid JSON");
        return [];
      }
    }

    const eventType = parsed?.data?.event_type;
    if (eventType !== "message.finalized") {
      this.logger?.debug({ eventType }, "Telnyx webhook ignored (untracked event type)");
      return [];
    }

    const payload = parsed?.data?.payload;
    const messageId = typeof payload?.id === "string" ? payload.id : undefined;
    const firstRecipient = Array.isArray(payload?.to) ? payload.to[0] : undefined;
    const deliveryStatus = typeof firstRecipient?.status === "string" ? firstRecipient.status : undefined;

    if (!messageId || (deliveryStatus !== "delivery_failed" && deliveryStatus !== "sending_failed")) {
      return [];
    }

    const recipient =
      typeof firstRecipient?.phone_number === "string" ? firstRecipient.phone_number : undefined;
    const rawTimestamp = parsed?.data?.occurred_at ?? payload?.completed_at;
    const timestamp = typeof rawTimestamp === "string" ? new Date(rawTimestamp) : new Date();

    const metadata: Record<string, unknown> = { telnyxStatus: deliveryStatus };
    if (Array.isArray(payload?.errors) && payload.errors[0]?.detail) {
      metadata["bounceMessage"] = payload.errors[0].detail;
    }

    return [
      {
        providerMessageId: messageId,
        status: "bounced",
        bounceType: "soft",
        timestamp,
        ...(recipient ? { recipient } : {}),
        metadata,
      },
    ];
  }
}

function toEd25519PublicKey(key: string) {
  const trimmed = key.trim();
  if (trimmed.includes("BEGIN PUBLIC KEY")) {
    return createPublicKey(trimmed);
  }
  const der = Buffer.from(trimmed, "base64");
  if (der.length === 32) {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, der]),
      format: "der",
      type: "spki",
    });
  }
  return createPublicKey({ key: der, format: "der", type: "spki" });
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

function isPermanentStatus(status: number | null | undefined): boolean {
  return (
    typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429
  );
}
