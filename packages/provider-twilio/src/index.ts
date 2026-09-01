import type { DeliveryResult, Transport } from "notifkit";
import type { NotificationDispatchedPayload, Logger } from "notifkit";
import type { WebhookEvent } from "notifkit";
import type { Twilio } from "twilio";

/**
 * Codes `messages.create` rejects with for a destination that is permanently
 * bad, as opposed to one that is merely temporarily rejected (rate limits,
 * account issues, Twilio outages). Only these suppress the contact — anything
 * else is worth retrying.
 * https://www.twilio.com/docs/api/errors
 */
const INVALID_DESTINATION_CODES = new Set([
  21211, // Invalid 'To' phone number
  21610, // Attempt to send to unsubscribed recipient (replied STOP)
  21612, // Message cannot be sent with this To/From combination
  21614, // 'To' number is not a valid mobile number
]);

/**
 * Delivery-time codes that arrive on an `undelivered`/`failed` status callback
 * and mean the number itself is gone, not that this one attempt lost.
 * Everything unlisted is treated as a soft bounce — an unrecognised code must
 * never suppress a number a person still uses.
 */
const HARD_BOUNCE_CODES = new Set([
  21211, // Invalid 'To' phone number
  21612, // Not reachable via SMS
  21614, // Not a valid mobile number
  30005, // Unknown destination handset — the number does not exist
  30006, // Landline or unreachable carrier
]);

/** The recipient replied STOP. An opt-out, not a delivery failure. */
const OPT_OUT_CODE = 21610;

export interface TwilioTransportOptions {
  accountSid: string;
  authToken: string;
  /**
   * Sender used for any template that does not name its own, in E.164
   * (`+15551234567`). A template may override it with a `from` in its
   * content — see `send`.
   */
  from: string;
  logger?: Logger;
  /**
   * Publicly reachable URL of this transport's status-callback route, e.g.
   * `https://api.example.com/webhooks/twilio`. Twilio signs the URL it was
   * given along with the request body, so signatures can only be checked
   * against the exact string configured here — including any query string.
   *
   * Leave it unset to send without delivery tracking; the webhook route is
   * only mounted when it is present, because an unverifiable callback is an
   * anonymous, forgeable write into delivery history.
   */
  statusCallbackUrl?: string;
  limits?: { limit: number; windowSeconds: number };
}

export class TwilioTransport implements Transport {
  readonly channel = "sms" as const;
  readonly webhookPath?: string;
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly from: string;
  private readonly logger?: Logger;
  private readonly statusCallbackUrl?: string;
  private client: Twilio | null = null;

  constructor({
    accountSid,
    authToken,
    from,
    logger,
    statusCallbackUrl,
    // Twilio queues per sender at roughly one message per second on a long
    // code, so the ceiling that matters is the sending number's, not the
    // account's. This is a conservative default for a single long code —
    // callers on a short code or a Messaging Service should raise it.
    limits = { limit: 60, windowSeconds: 60 },
  }: TwilioTransportOptions) {
    this.accountSid = accountSid;
    this.authToken = authToken;
    this.from = from;
    this.logger = logger;
    this.statusCallbackUrl = statusCallbackUrl;
    this.limits = limits;

    // Derive the mounted path from the configured callback URL rather than
    // taking both separately: the two drifting apart would mount a route
    // Twilio never calls, or verify against a URL it never signed.
    if (statusCallbackUrl) {
      try {
        this.webhookPath = new URL(statusCallbackUrl).pathname;
      } catch {
        throw new Error(
          `TwilioTransport: statusCallbackUrl is not a valid URL: ${statusCallbackUrl}`,
        );
      }
    }
  }

  /**
   * The SDK is a large module, so it is loaded on first send rather than at
   * import time — a process that registers this transport but never sends SMS
   * should not pay for it.
   */
  private async getClient(): Promise<Twilio> {
    if (this.client) return this.client;
    const { default: twilio } = await import("twilio");
    this.client = twilio(this.accountSid, this.authToken);
    return this.client;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    // `destination` is optional on the contract, so a malformed task can reach
    // a transport without one. Failing here costs one clear error; passing
    // `undefined` to Twilio costs an opaque provider rejection and a retry cycle.
    const to = task.destination;
    if (!to) {
      return { success: false, error: "No destination (recipient phone number) on task" };
    }

    const content = task.renderedContent.content as any;
    const body = content.text || content.body;
    if (!body) {
      return { success: false, error: "No message body on task" };
    }

    // A template may carry its own sender, so one transport can serve a
    // support long code and a marketing short code. Non-strings are ignored
    // rather than coerced: `from: 123` reaching Twilio as "123" would fail the
    // send with a confusing error.
    const from = typeof content.from === "string" && content.from ? content.from : this.from;

    try {
      const client = await this.getClient();
      const message = await client.messages.create({
        to,
        from,
        body,
        ...(this.statusCallbackUrl ? { statusCallback: this.statusCallbackUrl } : {}),
      });

      // Twilio accepts the message before a carrier has seen it, so `queued`
      // here is a successful handoff, not a delivery. Whether it actually
      // landed arrives later on the status callback.
      this.logger?.debug(
        { taskId: task.taskId, messageId: message.sid, status: message.status },
        "Twilio message accepted",
      );
      return { success: true, providerMessageId: message.sid };
    } catch (err) {
      const error = err as Error & { code?: number };
      const invalidToken = error.code !== undefined && INVALID_DESTINATION_CODES.has(error.code);

      this.logger?.warn(
        { taskId: task.taskId, code: error.code, error: error.message, invalidToken },
        "Twilio send failed",
      );
      return { success: false, invalidToken, error: error.message };
    }
  }

  /**
   * Signature gate for the route the API mounts at `webhookPath`.
   *
   * Required, not optional: the mounted route answers 501 for a transport that
   * omits it, so without this `parseWebhook` is never reached at all.
   *
   * Fail closed. Twilio posts status callbacks as `application/x-www-form-
   * urlencoded`, so the signature covers the callback URL plus the sorted form
   * fields — a missing signature or an unconfigured URL is a reason to drop
   * the event, never a reason to trust it.
   */
  async verifyWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    if (!this.statusCallbackUrl) {
      this.logger?.error(
        "Twilio webhook rejected: statusCallbackUrl is not configured, cannot verify signature",
      );
      return false;
    }

    const raw = headers["x-twilio-signature"];
    const signature = Array.isArray(raw) ? raw[0] : raw;
    if (!signature) {
      this.logger?.warn("Twilio webhook rejected: missing x-twilio-signature header");
      return false;
    }

    const { default: twilio } = await import("twilio");
    const valid = twilio.validateRequest(
      this.authToken,
      signature,
      this.statusCallbackUrl,
      parseFormBody(rawBody),
    );
    if (!valid) {
      this.logger?.warn("Twilio webhook signature verification failed");
    }
    return valid;
  }

  async parseWebhook(
    _body: any,
    rawBody?: string,
    headers?: Record<string, string | string[] | undefined>,
  ): Promise<WebhookEvent[]> {
    // Verify again rather than trusting the caller. This method is public and
    // may be called directly, and an unverified callback is a forgeable write
    // into delivery history.
    if (rawBody === undefined || !headers || !(await this.verifyWebhook(rawBody, headers))) {
      return [];
    }

    // The mounted route JSON-parses the body before handing it over, which
    // yields nothing for a form-encoded post — so read the raw body instead.
    const params = parseFormBody(rawBody);
    const providerMessageId = params["MessageSid"] ?? params["SmsSid"];
    const messageStatus = params["MessageStatus"] ?? params["SmsStatus"];

    this.logger?.debug({ providerMessageId, messageStatus }, "Twilio status callback received");

    if (!providerMessageId || !messageStatus) {
      this.logger?.warn("Twilio status callback malformed or missing MessageSid");
      return [];
    }

    const recipient = params["To"];
    const errorCode = params["ErrorCode"] ? Number(params["ErrorCode"]) : undefined;

    let status: WebhookEvent["status"];
    let bounceType: WebhookEvent["bounceType"] | undefined;

    switch (messageStatus) {
      case "failed":
      case "undelivered":
        // A STOP reply is a withdrawal of consent, not a broken number, and
        // the two want different handling: one should never be messaged
        // again, the other may come back when the handset does.
        if (errorCode === OPT_OUT_CODE) {
          status = "unsubscribed";
        } else {
          status = "bounced";
          bounceType =
            errorCode !== undefined && HARD_BOUNCE_CODES.has(errorCode) ? "hard" : "soft";
        }
        break;
      case "read":
        // RCS and WhatsApp report a read receipt; SMS never does.
        status = "opened";
        break;
      default:
        // queued, sending, sent, delivered, accepted, scheduled, canceled —
        // progress reports the delivery log already knows how to infer.
        this.logger?.debug(
          { messageStatus },
          "Twilio status callback ignored (untracked message status)",
        );
        return [];
    }

    this.logger?.info(
      { providerMessageId, status, messageStatus, errorCode },
      "Twilio status callback mapped to notifkit status",
    );

    const metadata: Record<string, unknown> = { messageStatus };
    if (errorCode !== undefined) metadata["errorCode"] = errorCode;
    if (params["ChannelStatusMessage"]) {
      metadata["channelStatusMessage"] = params["ChannelStatusMessage"];
    }

    return [
      {
        providerMessageId,
        status,
        timestamp: new Date(),
        ...(recipient ? { recipient } : {}),
        ...(bounceType ? { bounceType } : {}),
        metadata,
      },
    ];
  }
}

/**
 * Twilio posts status callbacks form-encoded, and signs every field it sent —
 * including ones added after this was written — so collect all of them rather
 * than only the ones read below, or verification fails on Twilio's next
 * addition.
 */
function parseFormBody(rawBody: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(rawBody)) {
    params[key] = value;
  }
  return params;
}
