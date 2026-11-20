import type { DeliveryResult, Transport } from "notifkit";
import type { NotificationDispatchedPayload, Logger } from "notifkit";
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
  readonly limits: { limit: number; windowSeconds: number };

  private readonly client: SESv2Client;
  private readonly ownsClient: boolean;
  private readonly from: string;
  private readonly configurationSetName?: string;
  private readonly logger?: Logger;

  constructor({ from, region, client, configurationSetName, logger, limits }: SesTransportOptions) {
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
