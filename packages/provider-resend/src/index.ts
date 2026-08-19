import type { DeliveryResult, Transport } from "notifkit";
import type { NotificationDispatchedPayload, Logger } from "notifkit";
import type { WebhookEvent } from "notifkit";
import { Resend } from "resend";
import { Webhook } from "svix";

export interface ResendTransportOptions {
  apiKey: string;
  /**
   * Sender used for any template that does not name its own. A template may
   * override it with a `from` in its content — see `send`.
   */
  from: string;
  logger?: Logger;
  webhookSecret?: string;
  limits?: { limit: number; windowSeconds: number };
}

export class ResendTransport implements Transport {
  readonly channel = "email" as const;
  readonly webhookPath = "/webhooks/resend";
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly resend: Resend;
  private readonly from: string;
  private readonly logger?: Logger;
  private readonly webhookSecret?: string;

  constructor({
    apiKey,
    from,
    logger,
    webhookSecret,
    limits = { limit: 1000, windowSeconds: 10 },
  }: ResendTransportOptions) {
    this.resend = new Resend(apiKey);
    this.from = from;
    this.logger = logger;
    this.webhookSecret = webhookSecret;
    this.limits = limits;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    // `destination` is optional on the contract, so a malformed task can reach
    // a transport without one. Failing here costs one clear error; passing
    // `undefined` to Resend costs an opaque provider rejection and a retry cycle.
    const to = task.destination;
    if (!to) {
      return { success: false, error: "No destination (recipient address) on task" };
    }

    const content = task.renderedContent.content as any;
    const body = content.text || content.body;
    const subject = content.subject;
    const htmlBody = content.htmlBody || content.html;

    // A template may carry its own sender, so one transport can serve
    // no-reply@ for receipts and marketing@ for campaigns. Both fields are
    // header fields to the renderer, which strips CR/LF from interpolated
    // values — a template naming neither falls back to the constructor's.
    // Non-strings are ignored rather than coerced: `from: 123` reaching the
    // provider as "123" would fail the send with a confusing error.
    const from = typeof content.from === "string" && content.from ? content.from : this.from;
    const replyTo =
      typeof content.replyTo === "string" && content.replyTo ? content.replyTo : undefined;

    // Carries the List-Unsubscribe pair the engine attaches to topic-bearing
    // mail. Passing them through is what makes the inbox render a real
    // unsubscribe button instead of leaving the recipient the spam key.
    const headers = task.deliveryOptions?.headers;

    try {
      const { data, error } = await this.resend.emails.send({
        from,
        to,
        subject: subject ?? "Notification",
        html: htmlBody ?? `<p>${body}</p>`,
        text: body,
        ...(replyTo ? { replyTo } : {}),
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      });

      if (error) {
        this.logger?.warn({ taskId: task.taskId, error: error.message }, "Resend send failed");
        return {
          success: false,
          error: error.message,
        };
      }

      this.logger?.debug({ taskId: task.taskId, messageId: data?.id }, "Resend email sent");
      return { success: true, providerMessageId: data?.id ?? "" };
    } catch (err) {
      const error = err as Error;
      this.logger?.error({ taskId: task.taskId, error: error.message }, "Resend unexpected error");

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Check the svix signature and return the verified payload, or null.
   *
   * Fail closed. An unverified webhook is an anonymous, forgeable write into
   * delivery history, so a missing secret or missing request data is a reason
   * to drop the event — never a reason to trust it.
   */
  private verifySignature(
    rawBody: string | undefined,
    headers: Record<string, string | string[] | undefined> | undefined,
  ): any | null {
    if (!this.webhookSecret) {
      this.logger?.error(
        "Resend webhook rejected: webhookSecret is not configured, cannot verify signature",
      );
      return null;
    }

    if (!rawBody || !headers) {
      this.logger?.warn(
        "Resend webhook rejected: raw body or headers unavailable for verification",
      );
      return null;
    }

    const svixHeaders: Record<string, string> = {};
    for (const [key, val] of Object.entries(headers)) {
      if (Array.isArray(val)) svixHeaders[key] = val.join(",");
      else if (val) svixHeaders[key] = val;
    }

    try {
      return new Webhook(this.webhookSecret).verify(rawBody, svixHeaders);
    } catch (err: any) {
      this.logger?.warn({ error: err.message }, "Resend webhook signature verification failed");
      return null;
    }
  }

  /**
   * Signature gate for the route the API mounts at `webhookPath`.
   *
   * Required, not optional: the mounted route answers 501 for a transport that
   * omits it, so without this `parseWebhook` is never reached at all.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean {
    return this.verifySignature(rawBody, headers) !== null;
  }

  async parseWebhook(
    body: any,
    rawBody?: string,
    headers?: Record<string, string | string[] | undefined>,
  ): Promise<WebhookEvent[]> {
    // Verify again rather than trusting the caller's parse of the body. This
    // method is public and may be called directly, and the payload svix returns
    // is the only one worth acting on.
    const verified = this.verifySignature(rawBody, headers);
    if (verified === null) return [];
    body = verified;

    this.logger?.debug(
      { bodyType: body?.type, bodyId: body?.data?.email_id },
      "Resend webhook received",
    );

    if (!body || !body.type || !body.data || !body.data.email_id) {
      this.logger?.warn("Resend webhook payload malformed or missing email_id");
      return [];
    }

    let status: WebhookEvent["status"] | null = null;
    switch (body.type) {
      case "email.opened":
        status = "opened";
        break;
      case "email.clicked":
        status = "clicked";
        break;
      case "email.bounced":
        status = "bounced";
        break;
      case "email.complained":
        status = "complained";
        break;
      case "email.delivery_delayed":
      case "email.delivered":
      default:
        this.logger?.debug({ type: body.type }, "Resend webhook ignored (untracked event type)");
        return [];
    }

    if (status) {
      this.logger?.info(
        { providerMessageId: body.data.email_id, status, type: body.type },
        "Resend webhook mapped to notifkit status",
      );

      // `to` is an array; a bounce or complaint concerns the first recipient.
      const recipient = Array.isArray(body.data.to) ? body.data.to[0] : body.data.to;

      // Resend reports bounce severity under `bounce.type`, using its own
      // vocabulary. Anything not explicitly permanent is treated as soft, so an
      // unrecognised value never suppresses a working address.
      const rawBounceType: string | undefined = body.data.bounce?.type ?? body.data.bounce_type;
      const bounceType =
        status === "bounced"
          ? /permanent|hard/i.test(rawBounceType ?? "")
            ? ("hard" as const)
            : ("soft" as const)
          : undefined;

      const metadata: Record<string, unknown> = {};
      if (status === "clicked" && body.data.click?.link) metadata["url"] = body.data.click.link;
      if (rawBounceType) metadata["bounceType"] = rawBounceType;
      if (body.data.bounce?.message) metadata["bounceMessage"] = body.data.bounce.message;

      return [
        {
          providerMessageId: body.data.email_id,
          status,
          timestamp: body.created_at ? new Date(body.created_at) : new Date(),
          ...(recipient ? { recipient } : {}),
          ...(bounceType ? { bounceType } : {}),
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        },
      ];
    }
    return [];
  }
}
