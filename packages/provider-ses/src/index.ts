import { verify } from "node:crypto";
import type { DeliveryResult, Transport } from "notifkit";
import type { NotificationDispatchedPayload, Logger } from "notifkit";
import type { WebhookEvent } from "notifkit";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { SendEmailCommandInput } from "@aws-sdk/client-sesv2";

export interface SesTransportOptions {
  /**
   * Sender used for any template that does not name its own. It has to be a
   * verified SES identity. A template may override it with a `from` in its
   * content — see `send`.
   */
  from: string;
  /**
   * AWS region of the SES account, e.g. "eu-west-1". Without it the SDK reads
   * AWS_REGION or the shared config. Ignored when `client` is given.
   */
  region?: string;
  /**
   * A client you built yourself, used as is. Its retry and timeout settings
   * are yours, and `close()` leaves it open. Credentials otherwise come from
   * the SDK's default chain: env vars, the shared config, SSO, or the role of
   * the machine.
   */
  client?: SESv2Client;
  /** SES configuration set to send with, e.g. one that publishes bounce events. */
  configurationSetName?: string;
  logger?: Logger;
  /**
   * Send rate. Set it to the account's maximum send rate, e.g.
   * `{ limit: 14, windowSeconds: 1 }`, so a burst waits its turn instead of
   * being throttled. SES shows it under Sending limits on the account
   * dashboard, and `aws sesv2 get-account` returns it as
   * `SendQuota.MaxSendRate`. The sandbox rate is 1 a second.
   */
  limits: { limit: number; windowSeconds: number };
  /**
   * SNS topics the webhook accepts bounces and complaints from, e.g.
   * "arn:aws:sns:eu-west-1:123456789012:ses-feedback". A valid SNS signature
   * only proves that SNS sent a message, not whose topic it came from: anyone
   * can create a topic and subscribe this endpoint to it. So a message from
   * any other topic is rejected, and without this every webhook is rejected.
   */
  snsTopicArns?: string[];
}

// The SNS regional endpoints, including the China regions. The signing
// certificate and the subscription confirmation are only fetched from these.
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

// Signing certificates rotate rarely, so a few are enough to keep.
const MAX_CACHED_CERTIFICATES = 10;

interface SnsMessage {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  MessageId: string;
  Message: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
  Timestamp: string;
  TopicArn: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
}

// SES reports its send rate and daily quota as throttling, and some of these
// come back as a 400. They're retried whatever the status: a retry gets past a
// short spike over the send rate, though not the daily quota, which resets
// over 24 hours. The AWS SDK counts LimitExceededException as throttling too.
const THROTTLING_ERRORS = new Set([
  "Throttling",
  "ThrottlingException",
  "TooManyRequestsException",
  "LimitExceededException",
]);

export class SesTransport implements Transport {
  readonly channel = "email" as const;
  readonly webhookPath = "/webhooks/ses";
  readonly limits: { limit: number; windowSeconds: number };

  private readonly client: SESv2Client;
  private readonly ownsClient: boolean;
  private readonly from: string;
  private readonly configurationSetName?: string;
  private readonly logger?: Logger;
  private readonly snsTopicArns: ReadonlySet<string>;
  private readonly certificates = new Map<string, Promise<string>>();

  constructor({
    from,
    region,
    client,
    configurationSetName,
    logger,
    limits,
    snsTopicArns,
  }: SesTransportOptions) {
    // Send rates differ from one account to the next, so no default fits. With
    // none, SES throttles a burst and the circuit breaker fails the rest
    // without trying them.
    if (!limits || !(limits.limit > 0) || !(limits.windowSeconds > 0)) {
      throw new Error(
        "SesTransport: limits is required. Set it to the account's maximum send rate, e.g. { limit: 14, windowSeconds: 1 }",
      );
    }

    // notifkit already retries a failed send with backoff, so the SDK's own
    // three attempts would multiply that and outlast delivery's send timeout.
    this.client = client ?? new SESv2Client({ ...(region ? { region } : {}), maxAttempts: 1 });
    this.ownsClient = !client;
    this.from = from;
    this.configurationSetName = configurationSetName;
    this.logger = logger;
    this.limits = limits;
    this.snsTopicArns = new Set(snsTopicArns ?? []);
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    // `destination` is optional on the contract, so a malformed task can reach
    // a transport without one. Fail here instead of an SES BadRequest.
    const to = task.destination;
    if (!to) {
      return {
        success: false,
        retryable: false,
        error: "No destination (recipient address) on task",
      };
    }

    const content = task.renderedContent.content as any;
    const body = content.text || content.body;
    const subject = content.subject;
    const htmlBody = content.htmlBody || content.html;

    // A template may carry its own sender and reply-to, the same as in
    // provider-resend. Non-strings are ignored rather than coerced.
    const from = typeof content.from === "string" && content.from ? content.from : this.from;
    const replyTo =
      typeof content.replyTo === "string" && content.replyTo ? content.replyTo : undefined;

    // A text-only template gets an HTML part built from its text. The text was
    // rendered unescaped (it is plain text), so it is escaped here.
    const html = htmlBody ?? (typeof body === "string" ? textToHtml(body) : undefined);

    // Carries the List-Unsubscribe pair the engine attaches to topic-bearing
    // mail, so the inbox shows an unsubscribe button.
    const headers = Object.entries(task.deliveryOptions?.headers ?? {}).map(([Name, Value]) => ({
      Name,
      Value,
    }));

    const input: SendEmailCommandInput = {
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
      Content: {
        Simple: {
          Subject: { Data: subject ?? "Notification", Charset: "UTF-8" },
          Body: {
            ...(typeof body === "string" ? { Text: { Data: body, Charset: "UTF-8" } } : {}),
            ...(html ? { Html: { Data: html, Charset: "UTF-8" } } : {}),
          },
          ...(headers.length > 0 ? { Headers: headers } : {}),
        },
      },
      ...(this.configurationSetName ? { ConfigurationSetName: this.configurationSetName } : {}),
    };

    // Delivery aborts this signal when the send outlives its timeout, which
    // also cancels the HTTP request. Called on its own, a send gets the same
    // timeout.
    const abortSignal =
      (task as { signal?: AbortSignal }).signal ??
      AbortSignal.timeout(task.deliveryOptions?.timeoutMs ?? 10_000);

    try {
      const res = await this.client.send(new SendEmailCommand(input), { abortSignal });

      this.logger?.debug({ taskId: task.taskId, messageId: res.MessageId }, "SES email sent");
      return { success: true, providerMessageId: res.MessageId ?? "" };
    } catch (err) {
      const error = err as Error & { $metadata?: { httpStatusCode?: number } };
      const status = error.$metadata?.httpStatusCode;
      this.logger?.warn(
        { taskId: task.taskId, name: error.name, status, error: error.message },
        "SES send failed",
      );

      return {
        success: false,
        ...(isPermanent(error.name, status) ? { retryable: false } : {}),
        error: `${error.name}: ${error.message}`,
      };
    }
  }

  /**
   * Close the client's connections. `server.stop()` calls this. A client
   * passed in through the options is left open for its owner to close.
   */
  close(): void {
    if (this.ownsClient) this.client.destroy();
  }

  /**
   * Signature gate for the route the API mounts at `webhookPath`. SES reports
   * bounces and complaints through SNS, which signs each message.
   */
  async verifyWebhook(rawBody: string): Promise<boolean> {
    return (await this.verifiedMessage(rawBody)) !== null;
  }

  async parseWebhook(_body: unknown, rawBody?: string): Promise<WebhookEvent[]> {
    // Verify again rather than trusting the caller. This method is public and
    // may be called directly, and only a verified message is worth acting on.
    const message = await this.verifiedMessage(rawBody);
    if (message === null) return [];

    switch (message.Type) {
      case "SubscriptionConfirmation":
        await this.confirmSubscription(message);
        return [];
      case "UnsubscribeConfirmation":
        this.logger?.info({ topicArn: message.TopicArn }, "SNS subscription to SES feedback ended");
        return [];
      default:
        return this.feedbackEvents(message.Message);
    }
  }

  /**
   * Check an SNS message the way AWS documents it and return it, or null.
   *
   * Fail closed: a forged bounce or complaint suppresses a real address, so
   * anything that can't be verified is dropped, never trusted.
   */
  private async verifiedMessage(rawBody: string | undefined): Promise<SnsMessage | null> {
    if (this.snsTopicArns.size === 0) {
      this.logger?.error("SES webhook rejected: snsTopicArns is not configured");
      return null;
    }

    let message: unknown;
    try {
      message = JSON.parse(rawBody ?? "");
    } catch {
      this.logger?.warn("SES webhook rejected: body is not JSON");
      return null;
    }
    // With raw message delivery turned on, SNS sends the SES payload without
    // its envelope and signature, so it lands here too.
    if (!isSnsMessage(message)) {
      this.logger?.warn("SES webhook rejected: not a signed SNS message");
      return null;
    }
    if (!this.snsTopicArns.has(message.TopicArn)) {
      this.logger?.warn({ topicArn: message.TopicArn }, "SES webhook rejected: unexpected topic");
      return null;
    }

    const algorithm =
      message.SignatureVersion === "1"
        ? "sha1"
        : message.SignatureVersion === "2"
          ? "sha256"
          : undefined;
    const certUrl = snsUrl(message.SigningCertURL);
    if (!algorithm || !certUrl || !certUrl.pathname.endsWith(".pem")) {
      this.logger?.warn(
        { signatureVersion: message.SignatureVersion, signingCertUrl: message.SigningCertURL },
        "SES webhook rejected: unsupported signature version or signing certificate URL",
      );
      return null;
    }

    try {
      const certificate = await this.certificate(certUrl.href);
      const valid = verify(
        algorithm,
        Buffer.from(stringToSign(message), "utf8"),
        certificate,
        Buffer.from(message.Signature, "base64"),
      );
      if (!valid) {
        this.logger?.warn({ messageId: message.MessageId }, "SES webhook rejected: bad signature");
        return null;
      }
    } catch (err) {
      this.logger?.warn(
        { messageId: message.MessageId, error: (err as Error).message },
        "SES webhook rejected: signature could not be checked",
      );
      return null;
    }

    return message;
  }

  /** Fetch a signing certificate once, and again only if that fetch failed. */
  private certificate(url: string): Promise<string> {
    let pending = this.certificates.get(url);
    if (!pending) {
      pending = fetch(url, { signal: AbortSignal.timeout(5_000), redirect: "error" }).then(
        async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status} for the signing certificate`);
          return res.text();
        },
      );
      pending.catch(() => this.certificates.delete(url));
      if (this.certificates.size >= MAX_CACHED_CERTIFICATES) {
        this.certificates.delete(this.certificates.keys().next().value!);
      }
      this.certificates.set(url, pending);
    }
    return pending;
  }

  /**
   * SNS sends this once, when the topic subscribes the endpoint. Visiting
   * SubscribeURL confirms it. A failure throws, so the route answers 500 and
   * SNS sends the confirmation again.
   */
  private async confirmSubscription(message: SnsMessage): Promise<void> {
    const url = snsUrl(message.SubscribeURL ?? "");
    if (!url) {
      this.logger?.warn(
        { subscribeUrl: message.SubscribeURL },
        "SNS subscription not confirmed: SubscribeURL is not an SNS endpoint",
      );
      return;
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: "error" });
    if (!res.ok) throw new Error(`SNS subscription confirmation failed with HTTP ${res.status}`);
    this.logger?.info({ topicArn: message.TopicArn }, "SNS subscription to SES feedback confirmed");
  }

  /**
   * Map an SES bounce or complaint to one event per recipient. Both the
   * identity notifications (`notificationType`) and configuration-set event
   * publishing (`eventType`) use this shape.
   */
  private feedbackEvents(text: string): WebhookEvent[] {
    let feedback: any;
    try {
      feedback = JSON.parse(text);
    } catch {
      this.logger?.warn("SES webhook ignored: the SNS message is not SES JSON");
      return [];
    }

    const type = feedback?.notificationType ?? feedback?.eventType;
    const providerMessageId = feedback?.mail?.messageId;
    if (typeof providerMessageId !== "string" || !providerMessageId) return [];

    if (type === "Bounce") {
      const bounce = feedback.bounce ?? {};
      // Only Permanent suppresses. Transient and Undetermined bounces may
      // clear, and wrongly suppressing a live address stops wanted mail.
      const bounceType = bounce.bounceType === "Permanent" ? ("hard" as const) : ("soft" as const);
      return recipients(bounce.bouncedRecipients).map(({ emailAddress, diagnosticCode }) => ({
        providerMessageId,
        status: "bounced" as const,
        timestamp: toDate(bounce.timestamp),
        recipient: emailAddress,
        bounceType,
        metadata: compact({
          bounceType: bounce.bounceType,
          bounceSubType: bounce.bounceSubType,
          diagnosticCode,
        }),
      }));
    }

    if (type === "Complaint") {
      const complaint = feedback.complaint ?? {};
      // A "not-spam" report says the mail was wanted, so it suppresses nothing.
      if (complaint.complaintFeedbackType === "not-spam") return [];
      return recipients(complaint.complainedRecipients).map(({ emailAddress }) => ({
        providerMessageId,
        status: "complained" as const,
        timestamp: toDate(complaint.timestamp),
        recipient: emailAddress,
        metadata: compact({
          complaintFeedbackType: complaint.complaintFeedbackType,
          complaintSubType: complaint.complaintSubType,
        }),
      }));
    }

    this.logger?.debug({ type }, "SES webhook ignored (untracked notification type)");
    return [];
  }
}

function isSnsMessage(value: unknown): value is SnsMessage {
  const m = value as Record<string, unknown> | null;
  const isString = (key: string) => typeof m?.[key] === "string";
  const required = ["Type", "MessageId", "Message", "Timestamp", "TopicArn"];
  if (![...required, "SignatureVersion", "Signature", "SigningCertURL"].every(isString))
    return false;
  if (m!.Type === "Notification") return m!.Subject === undefined || isString("Subject");
  if (m!.Type === "SubscriptionConfirmation" || m!.Type === "UnsubscribeConfirmation") {
    return isString("SubscribeURL") && isString("Token");
  }
  return false;
}

/**
 * The fields SNS signs, in the documented order, each as `Name\nvalue\n`.
 * Subject is part of it only when the message has one.
 */
function stringToSign(message: SnsMessage): string {
  const fields =
    message.Type === "Notification"
      ? (["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const)
      : ([
          "Message",
          "MessageId",
          "SubscribeURL",
          "Timestamp",
          "Token",
          "TopicArn",
          "Type",
        ] as const);
  return fields
    .filter((field) => typeof message[field] === "string")
    .map((field) => `${field}\n${message[field]}\n`)
    .join("");
}

/** The URL, if it's plain HTTPS to an SNS endpoint, or null. */
function snsUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const plain = url.protocol === "https:" && !url.port && !url.username && !url.password;
  return plain && SNS_HOST.test(url.hostname) ? url : null;
}

function recipients(list: unknown): { emailAddress: string; diagnosticCode?: string }[] {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (r): r is { emailAddress: string; diagnosticCode?: string } =>
      typeof r?.emailAddress === "string" && r.emailAddress !== "",
  );
}

function toDate(value: unknown): Date {
  const date = typeof value === "string" ? new Date(value) : new Date(NaN);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function compact(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined && v !== null),
  );
}

/**
 * Whether SES refused the email for good: a bad address, an unverified
 * sender, a rejected message, a paused account. Those come back as a 4xx;
 * 408, 429 and throttling are the exceptions, the same as a 5xx or a request
 * that never got an answer (a timeout, a dropped connection).
 */
function isPermanent(name: string, status: number | undefined): boolean {
  if (THROTTLING_ERRORS.has(name)) return false;
  return (
    typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429
  );
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
