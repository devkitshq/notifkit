import type { DeliveryResult, Transport, NotificationDispatchedPayload, Logger } from "notifkit";

export interface WhatsAppTransportOptions {
  /** WhatsApp Business phone number ID from Meta's App Dashboard > WhatsApp > API Setup. */
  phoneNumberId: string;
  accessToken: string;
  /** Graph API version. Defaults to the latest tested against. */
  apiVersion?: string;
  logger?: Logger;
  limits?: { limit: number; windowSeconds: number };
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

  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly apiVersion: string;
  private readonly logger?: Logger;

  constructor({
    phoneNumberId,
    accessToken,
    apiVersion = "v21.0",
    logger,
    limits,
  }: WhatsAppTransportOptions) {
    this.phoneNumberId = phoneNumberId;
    this.accessToken = accessToken;
    this.apiVersion = apiVersion;
    this.logger = logger;
    this.limits = limits;
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
}

// Meta expects digits only (country code + number) — no "+", spaces, or dashes.
function normalizeToE164Digits(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/[^\d]/g, "");
  return digits || undefined;
}
