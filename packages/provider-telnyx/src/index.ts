import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { DeliveryResult, Transport } from "notifkit";
import type { NotificationDispatchedPayload, Logger } from "notifkit";
import type { WebhookEvent } from "notifkit";

/** Telnyx Messaging API v2 — send a message. */
const TELNYX_MESSAGES_URL = "https://api.telnyx.com/v2/messages";

/**
 * How far a webhook timestamp may drift from now before the event is
 * refused as a replay. Five minutes, the same window Stripe's SDK uses for
 * its webhook verification: a cryptographically valid signature alone does
 * not expire, so without this a captured request stays replayable forever.
 */
const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

export interface TelnyxTransportOptions {
  /** Telnyx API key (v2), sent as a Bearer token. */
  apiKey: string;
  /**
   * Sender used for any template that does not name its own, in E.164
   * (`+15551234567`). A template may override it with a `from` in its
   * content — see `send`. Either `from` or `messagingProfileId` is required:
   * Telnyx sends with one or the other, never both.
   */
  from?: string;
  /**
   * Messaging profile to send with, instead of `from`. Either `from` or
   * `messagingProfileId` is required.
   */
  messagingProfileId?: string;
  logger?: Logger;
  /**
   * Publicly reachable URL of this transport's webhook route, e.g.
   * `https://api.example.com/webhooks/telnyx`. Telnyx posts `message.finalized`
   * delivery events to the URL on the messaging profile (or to the per-message
   * `webhook_url` this transport sends when this is set), so the route is only
   * mounted when it is present — an unverifiable callback is an anonymous,
   * forgeable write into delivery history.
   */
  webhookUrl?: string;
  /**
   * Base64 Ed25519 public key from the Telnyx portal (Mission Control →
   * Account Settings → Keys & Credentials → Public Key). It verifies webhook
   * signatures and is not secret, but it is not the API key either.
   */
  webhookPublicKey?: string;
  limits?: { limit: number; windowSeconds: number };
}

export class TelnyxTransport implements Transport {
  readonly channel = "sms" as const;
  readonly webhookPath?: string;
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly apiKey: string;
  private readonly from?: string;
  private readonly messagingProfileId?: string;
  private readonly logger?: Logger;
  private readonly webhookUrl?: string;
  private readonly webhookPublicKey?: string;
  private publicKeyObject: ReturnType<typeof createPublicKey> | null = null;

  constructor({
    apiKey,
    from,
    messagingProfileId,
    logger,
    webhookUrl,
    webhookPublicKey,
    // Telnyx queues per sender at roughly one message per second on a long
    // code, so the ceiling that matters is the sending number's, not the
    // account's. This is a conservative default for a single long code —
    // callers on a short code or a Messaging Service should raise it.
    limits = { limit: 60, windowSeconds: 60 },
  }: TelnyxTransportOptions) {
    if (!from && !messagingProfileId) {
      throw new Error(
        "TelnyxTransport: one of `from` or `messagingProfileId` is required — Telnyx sends with a sender number or a messaging profile",
      );
    }
    this.apiKey = apiKey;
    this.from = from;
    this.messagingProfileId = messagingProfileId;
    this.logger = logger;
    this.webhookUrl = webhookUrl;
    this.webhookPublicKey = webhookPublicKey;
    this.limits = limits;

    // Derive the mounted path from the configured webhook URL rather than
    // taking both separately: the two drifting apart would mount a route
    // Telnyx never calls, or verify against a URL it never signed.
    if (webhookUrl) {
      try {
        this.webhookPath = new URL(webhookUrl).pathname;
      } catch {
        throw new Error(`TelnyxTransport: webhookUrl is not a valid URL: ${webhookUrl}`);
      }
    }
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    // `destination` is optional on the contract, so a malformed task can reach
    // a transport without one. Failing here costs one clear error; passing
    // `undefined` to Telnyx costs an opaque provider rejection and a retry cycle.
    const to = task.destination;
    if (!to) {
      return {
        success: false,
        retryable: false,
        error: "No destination (recipient phone number) on task",
      };
    }

    const content = task.renderedContent.content as any;
    const body = content.text || content.body;
    if (!body) {
      return { success: false, retryable: false, error: "No message body on task" };
    }

    // A template may carry its own sender, so one transport can serve a
    // support long code and a marketing short code. Non-strings are ignored
    // rather than coerced: `from: 123` reaching Telnyx as "123" would fail the
    // send with a confusing error. A template sender wins over a messaging
    // profile: Telnyx takes one or the other, never both.
    const from =
      typeof content.from === "string" && content.from ? content.from : this.from;
    const messagingProfileId =
      typeof content.messagingProfileId === "string" && content.messagingProfileId
        ? content.messagingProfileId
        : this.messagingProfileId;
    const sender = from
      ? { from }
      : { messaging_profile_id: messagingProfileId };

    try {
      const res = await fetch(TELNYX_MESSAGES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          ...sender,
          to,
          text: body,
          ...(this.webhookUrl ? { webhook_url: this.webhookUrl } : {}),
        }),
      });

      if (!res.ok) {
        const errorBody = await res.text();
        const detail = telnyxErrorDetail(errorBody);
        // Telnyx reports a validation failure as 422 with the offending field
        // in `errors[].source.parameter`. A 422 pointing at `to` means the
        // destination itself is dead — the number is malformed or not a
        // mobile — so the contact should be deactivated rather than retried.
        const invalidToken =
          res.status === 422 && telnyxErrorTargetsField(errorBody, "to");
        const permanent = isPermanentStatus(res.status);

        this.logger?.warn(
          { taskId: task.taskId, status: res.status, errorBody, invalidToken },
          "Telnyx send failed",
        );
        return {
          success: false,
          invalidToken,
          ...(permanent ? { retryable: false } : {}),
          error: `Telnyx error ${res.status}${detail ? `: ${detail}` : ""}`,
        };
      }

      const data = (await res.json().catch(() => null)) as { data?: { id?: string } } | null;
      const providerMessageId = data?.data?.id ?? "";

      this.logger?.debug({ taskId: task.taskId, providerMessageId }, "Telnyx message sent");
      return { success: true, providerMessageId };
    } catch (err) {
      const error = err as Error;
      this.logger?.error({ taskId: task.taskId, error: error.message }, "Telnyx unexpected error");

      return { success: false, error: error.message };
    }
  }

  /**
   * Signature gate for the route the API mounts at `webhookPath`.
   *
   * Required, not optional: the mounted route answers 501 for a transport that
   * omits it, so without this `parseWebhook` is never reached at all.
   *
   * Fail closed. Telnyx signs every webhook with Ed25519: the
   * `telnyx-signature-ed25519` header holds a base64 signature over
   * `${telnyx-timestamp}|${rawBody}`, checked against the public key from the
   * portal, and the timestamp must be within five minutes of now or the event
   * is refused as a replay. A missing signature, a stale timestamp, or an
   * unconfigured public key is a reason to drop the event, never a reason to
   * trust it.
   */
  async verifyWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    if (!this.webhookPublicKey) {
      this.logger?.error(
        "Telnyx webhook rejected: webhookPublicKey is not configured, cannot verify signature",
      );
      return false;
    }

    const signatureRaw = headers["telnyx-signature-ed25519"];
    const signature = Array.isArray(signatureRaw) ? signatureRaw[0] : signatureRaw;
    const timestampRaw = headers["telnyx-timestamp"];
    const timestamp = Array.isArray(timestampRaw) ? timestampRaw[0] : timestampRaw;
    if (!signature || !timestamp) {
      this.logger?.warn(
        "Telnyx webhook rejected: missing telnyx-signature-ed25519 or telnyx-timestamp header",
      );
      return false;
    }

    // Unix seconds, not milliseconds: a millisecond value would read as a
    // date tens of thousands of years out and fail the freshness check below
    // rather than slipping through.
    const timestampSeconds = Number(timestamp);
    if (
      !Number.isFinite(timestampSeconds) ||
      Math.abs(Date.now() / 1000 - timestampSeconds) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
    ) {
      this.logger?.warn(
        { timestamp },
        "Telnyx webhook rejected: telnyx-timestamp is missing or too old",
      );
      return false;
    }

    try {
      const keyObject = this.getPublicKeyObject();
      // Node has no streaming verify for Ed25519 — createVerify('ed25519')
      // throws — so the one-shot verify() takes the whole signed payload at
      // once, with the algorithm as null. The portal key is standard base64
      // over the raw 32 bytes; a JWK is the only form createPublicKey accepts
      // a bare key in, so it is converted to base64url here.
      const valid = verifySignature(
        null,
        Buffer.from(`${timestamp}|${rawBody}`, "utf8"),
        keyObject,
        Buffer.from(signature, "base64"),
      );
      if (!valid) {
        this.logger?.warn("Telnyx webhook signature verification failed");
      }
      return valid;
    } catch (err) {
      const error = err as Error;
      this.logger?.warn(
        { error: error.message },
        "Telnyx webhook signature verification failed",
      );
      return false;
    }
  }

  async parseWebhook(
    body: any,
    rawBody?: string,
    headers?: Record<string, string | string[] | undefined>,
  ): Promise<WebhookEvent[]> {
    // Verify again rather than trusting the caller. This method is public and
    // may be called directly, and an unverified callback is a forgeable write
    // into delivery history.
    if (rawBody === undefined || !headers || !(await this.verifyWebhook(rawBody, headers))) {
      return [];
    }

    const data = body?.data;
    if (!data || typeof data !== "object" || data.event_type !== "message.finalized") {
      this.logger?.debug(
        { eventType: data?.event_type },
        "Telnyx webhook ignored (not a message.finalized event)",
      );
      return [];
    }

    const payload = data.payload;
    const firstRecipient = Array.isArray(payload?.to) ? payload.to[0] : undefined;
    const status = firstRecipient?.status;
    const providerMessageId = typeof data.id === "string" ? data.id : undefined;
    if (!providerMessageId || typeof status !== "string") {
      this.logger?.warn("Telnyx webhook event missing message id or delivery status");
      return [];
    }

    // Only the two terminal failure statuses map to a bounce. `delivered` and
    // the other progress statuses are reports the delivery log already knows
    // how to infer, and there is no notifkit status for them.
    if (status !== "delivery_failed" && status !== "sending_failed") {
      this.logger?.debug(
        { providerMessageId, status },
        "Telnyx webhook ignored (untracked delivery status)",
      );
      return [];
    }

    // Telnyx attaches no permanent-vs-transient code to these statuses, so
    // the bounce type is left unset rather than guessed: an unset type is
    // treated as soft, and wrongly suppressing a live number silently stops
    // messages someone still wants.
    const recipient =
      typeof firstRecipient.to === "string" ? firstRecipient.to : undefined;
    const timestamp =
      typeof data.occurred_at === "string" ? new Date(data.occurred_at) : new Date();

    this.logger?.info(
      { providerMessageId, status },
      "Telnyx webhook mapped to notifkit status",
    );

    return [
      {
        providerMessageId,
        status: "bounced",
        timestamp,
        ...(recipient ? { recipient } : {}),
        metadata: { telnyxStatus: status, eventType: data.event_type },
      },
    ];
  }

  /**
   * Builds the Ed25519 public key object from the portal's base64 key, once.
   * The portal key is the raw 32-byte public key; anything else is a
   * configuration error, surfaced by the caller as a failed verification.
   */
  private getPublicKeyObject(): ReturnType<typeof createPublicKey> {
    if (this.publicKeyObject) return this.publicKeyObject;
    const keyBytes = Buffer.from(this.webhookPublicKey!, "base64");
    if (keyBytes.length !== 32) {
      throw new Error(
        "Telnyx webhookPublicKey is not a 32-byte Ed25519 public key (base64)",
      );
    }
    this.publicKeyObject = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: keyBytes.toString("base64url") },
      format: "jwk",
    });
    return this.publicKeyObject;
  }
}

/**
 * Whether a refusal with this HTTP status is final. A 4xx says the request
 * itself is wrong, so sending it again cannot succeed; 408 and 429 are the
 * exceptions (the request was fine, the moment was not), as is every 5xx.
 */
function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * The human-readable detail of a Telnyx error response, if it parses as one.
 * Telnyx answers failures as `{ errors: [{ title, detail, ... }] }`.
 */
function telnyxErrorDetail(errorBody: string): string | undefined {
  try {
    const parsed = JSON.parse(errorBody) as {
      errors?: Array<{ title?: string; detail?: string }>;
    };
    const first = parsed?.errors?.[0];
    return first?.detail || first?.title || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a Telnyx error response points at the named request field. Telnyx
 * reports validation failures as 422 with the offending field in
 * `errors[].source.parameter` (e.g. `to` for a bad destination number).
 */
function telnyxErrorTargetsField(errorBody: string, field: string): boolean {
  try {
    const parsed = JSON.parse(errorBody) as {
      errors?: Array<{ source?: { parameter?: string } }>;
    };
    return (parsed?.errors ?? []).some((entry) => entry?.source?.parameter === field);
  } catch {
    return false;
  }
}
