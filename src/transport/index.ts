import type { NotificationChannel, NotificationDispatchedPayload } from "@/index.js";

// ─── Core interface ──────────────────────────────────────────────────────────
//
// Implement this interface to add a new channel (Email, SMS, APNS, Web Push …).
// Register the implementation with transportRegistry at app startup.

export interface DeliveryResult {
  success: boolean;
  providerMessageId?: string;
  invalidToken?: boolean;
  error?: string;
}

export interface WebhookEvent {
  providerMessageId: string;
  status: "opened" | "clicked" | "bounced" | "complained" | "unsubscribed";
  timestamp?: Date;
  /**
   * The address the event concerns. Required to suppress it — without this a
   * bounce or unsubscribe can be logged but not acted on, because the delivery
   * log records the message, not the destination.
   */
  recipient?: string;
  /**
   * Whether a bounce is permanent. Only hard bounces suppress; a soft bounce is
   * a full mailbox or a temporary outage and the address is still good. Left
   * undefined by providers that do not distinguish them, which is treated as
   * soft — the conservative reading, since wrongly suppressing a live address
   * silently stops mail the person still wants.
   */
  bounceType?: "hard" | "soft";
  /** Provider detail worth keeping: the clicked URL, the bounce description. */
  metadata?: Record<string, unknown>;
}

export interface Transport {
  readonly channel: NotificationChannel;
  readonly limits?: { limit: number; windowSeconds: number };
  send(task: NotificationDispatchedPayload): Promise<DeliveryResult>;

  webhookPath?: string;
  /**
   * Handles the one-time GET verification handshake some providers require
   * before they'll start POSTing to a webhook URL (e.g. Meta's hub.challenge
   * subscribe flow). Return the raw challenge string to echo back, or
   * undefined to reject the request. Providers that don't require this
   * (Resend, etc.) simply omit it.
   */
  verifyWebhookChallenge?: (
    query: URLSearchParams,
  ) => Promise<string | undefined> | string | undefined;
  verifyWebhook?: (
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ) => Promise<boolean> | boolean;
  parseWebhook?: (
    body: any,
    rawBody?: string,
    headers?: Record<string, string | string[] | undefined>,
  ) => Promise<WebhookEvent[]>;
}

// ─── TransportRegistry ───────────────────────────────────────────────────────

class TransportRegistry {
  private readonly transports = new Map<string, { transport: Transport; priority: number }[]>();

  register(transport: Transport, priority: number = 0): void {
    const list = this.transports.get(transport.channel) || [];
    list.push({ transport, priority });
    // Sort descending so higher priority is first
    list.sort((a, b) => b.priority - a.priority);
    this.transports.set(transport.channel, list);
  }

  get(channel: NotificationChannel): Transport | undefined {
    const list = this.transports.get(channel);
    return list && list.length > 0 ? list[0]?.transport : undefined;
  }

  getAll(channel: NotificationChannel): Transport[] {
    const list = this.transports.get(channel);
    return list ? list.map((item) => item.transport) : [];
  }

  registeredChannels(): string[] {
    return [...this.transports.keys()];
  }
}

export const transportRegistry = new TransportRegistry();

export function registerTransport(transport: Transport, priority: number = 0): void {
  transportRegistry.register(transport, priority);
}
