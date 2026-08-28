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
 * notifkit has no native "whatsapp" channel — the channel enum is fixed
 * across its schemas and DB layer — so this transport registers under
 * `channel: "sms"` and sends WhatsApp messages to the recipient's existing
 * `phone` field instead. Register it in place of an SMS transport, not
 * alongside one; the two can't coexist on the same channel slot.
 *
 * Free tier: Meta's Cloud API is free for roughly the first 1,000
 * business-initiated conversations per month per WABA, with no per-message
 * SaaS markup on top.
 */
export class WhatsAppTransport implements Transport {
  readonly channel = "sms" as const;
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
        error: "Template has no 'text' content for the sms/WhatsApp channel.",
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
