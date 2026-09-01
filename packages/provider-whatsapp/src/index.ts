import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  DeliveryResult,
  Transport,
  NotificationDispatchedPayload,
  Logger,
  WebhookEvent,
} from "notifkit";

export interface WhatsAppTransportOptions {
  /** WhatsApp Business phone number ID from Meta's App Dashboard > WhatsApp > API Setup. */
  phoneNumberId: string;
  accessToken: string;
  /** Graph API version. Defaults to the latest tested against. */
  apiVersion?: string;
  logger?: Logger;
  limits?: { limit: number; windowSeconds: number };
  /**
   * The string you type into Meta's webhook subscription dialog. Required to
   * answer the one-time GET verification handshake (hub.challenge); omit it
   * and the transport rejects every verification attempt.
   */
  verifyToken?: string;
  /**
   * Meta App Dashboard > App Settings > Basic > App Secret. Required to verify
   * the `X-Hub-Signature-256` header on inbound webhook POSTs; omit it and
   * every webhook event is rejected rather than trusted unverified.
   */
  appSecret?: string;
}

/**
 * Delivers via Meta's WhatsApp Cloud API.
 *
 * Registers under notifkit's native `channel: "whatsapp"` and sends to the
 * recipient's `phone` field (the same field the "sms" channel uses).
 *
 * Free tier: Meta's Cloud API is free for roughly the first 1,000
 * business-initiated conversations per month per WABA, with no per-message
 * SaaS markup on top.
 */
export class WhatsAppTransport implements Transport {
  readonly channel = "whatsapp" as const;
  readonly limits?: { limit: number; windowSeconds: number };
  readonly webhookPath = "/webhooks/whatsapp";

  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly apiVersion: string;
  private readonly logger?: Logger;
  private readonly verifyToken?: string;
  private readonly appSecret?: string;

  constructor({
    phoneNumberId,
    accessToken,
    apiVersion = "v21.0",
    logger,
    limits,
    verifyToken,
    appSecret,
  }: WhatsAppTransportOptions) {
    this.phoneNumberId = phoneNumberId;
    this.accessToken = accessToken;
    this.apiVersion = apiVersion;
    this.logger = logger;
    this.limits = limits;
    this.verifyToken = verifyToken;
    this.appSecret = appSecret;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    const to = normalizeToE164Digits(task.destination);
    if (!to) {
      return {
        success: false,
        error: "No phone number on recipient; cannot send WhatsApp message.",
      };
    }

    const content = task.renderedContent.content as { text?: string };
    const text = content.text;
    if (!text) {
      return {
        success: false,
        error: "Template has no 'text' content for the whatsapp channel.",
      };
    }

    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    const body = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(task.deliveryOptions?.timeoutMs ?? 10000),
      });

      const data: any = await res.json().catch(() => ({}));

      if (!res.ok) {
        const errorCode = data?.error?.code;
        // 190 = expired/invalid access token; surface it distinctly so
        // notifkit doesn't retry an auth failure like a transient one.
        const invalidToken = res.status === 401 || errorCode === 190;
        this.logger?.error({ status: res.status, error: data?.error }, "WhatsApp send failed");
        return {
          success: false,
          error: data?.error?.message ?? `HTTP ${res.status}`,
          invalidToken,
        };
      }

      return { success: true, providerMessageId: data?.messages?.[0]?.id ?? "" };
    } catch (err) {
      const error = err as Error;
      this.logger?.error({ error: error.message }, "WhatsApp send threw");
      return { success: false, error: error.message };
    }
  }

  /**
   * Answers Meta's one-time GET verification handshake for the webhook URL
   * you enter in the App Dashboard. Fails closed: no `verifyToken` configured
   * or a mismatched one both mean "reject", never "skip the check".
   */
  verifyWebhookChallenge(query: URLSearchParams): string | undefined {
    if (!this.verifyToken) {
      this.logger?.error("WhatsApp webhook verification rejected: verifyToken is not configured");
      return undefined;
    }
    if (
      query.get("hub.mode") !== "subscribe" ||
      query.get("hub.verify_token") !== this.verifyToken
    ) {
      return undefined;
    }
    return query.get("hub.challenge") ?? undefined;
  }

  /**
   * Checks `X-Hub-Signature-256` (HMAC-SHA256 of the raw body, keyed by the
   * app secret). Fail closed: no `appSecret` configured or a missing/malformed
   * header both reject the event rather than trust it unverified.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean {
    if (!this.appSecret) {
      this.logger?.error(
        "WhatsApp webhook rejected: appSecret is not configured, cannot verify signature",
      );
      return false;
    }

    const header = headers["x-hub-signature-256"];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature || !signature.startsWith("sha256=")) {
      this.logger?.warn("WhatsApp webhook rejected: missing or malformed X-Hub-Signature-256");
      return false;
    }

    const expected = createHmac("sha256", this.appSecret).update(rawBody).digest("hex");
    const provided = signature.slice("sha256=".length);

    const expectedBuffer = Buffer.from(expected, "hex");
    const providedBuffer = Buffer.from(provided, "hex");
    if (expectedBuffer.length !== providedBuffer.length) return false;
    return timingSafeEqual(expectedBuffer, providedBuffer);
  }

  /**
   * Maps Meta's message-status callbacks onto notifkit's engagement model.
   * `sent`/`delivered` have no equivalent in `WebhookEvent.status` and are
   * dropped, same as Resend drops its own `email.delivered`. `failed` maps to
   * `bounced` with `bounceType` left undefined (soft) — Meta's failure codes
   * mix transient (rate limits, session-window expiry) and permanent causes
   * without a reliable way to tell them apart here, and the conservative
   * default is to never suppress a number on a guess.
   *
   * Inbound user messages (`value.messages`) are not delivery-status events
   * and carry no `providerMessageId` to attribute them to a sent message, so
   * they are out of scope for this callback and are ignored.
   */
  async parseWebhook(body: any): Promise<WebhookEvent[]> {
    const events: WebhookEvent[] = [];

    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        for (const status of change?.value?.statuses ?? []) {
          const timestamp = status.timestamp
            ? new Date(Number(status.timestamp) * 1000)
            : new Date();

          if (status.status === "read") {
            events.push({
              providerMessageId: status.id,
              status: "opened",
              timestamp,
              ...(status.recipient_id ? { recipient: status.recipient_id } : {}),
            });
          } else if (status.status === "failed") {
            const errors = status.errors;
            events.push({
              providerMessageId: status.id,
              status: "bounced",
              timestamp,
              ...(status.recipient_id ? { recipient: status.recipient_id } : {}),
              ...(errors ? { metadata: { errors } } : {}),
            });
          }
          // "sent" and "delivered" carry no engagement/suppression signal —
          // notifkit already has "delivered" from the synchronous send() call.
        }
      }
    }

    return events;
  }
}

// Meta expects digits only (country code + number) — no "+", spaces, or dashes.
function normalizeToE164Digits(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/[^\d]/g, "");
  return digits || undefined;
}
