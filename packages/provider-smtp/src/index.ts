import type { DeliveryResult, Transport } from "notifkit";
import type { NotificationDispatchedPayload, Logger } from "notifkit";
import nodemailer from "nodemailer";
import type {
  NodemailerError,
  SMTPPoolOptions,
  SMTPTransportOptions,
  Transporter,
} from "nodemailer";

export interface SmtpTransportOptions {
  /**
   * Passed to nodemailer's `createTransport` as is: `host`, `port`, `secure`,
   * `auth`, and `pool: true` to keep connections open between sends. A
   * connection URL such as `smtps://user:pass@smtp.example.com` works too.
   * See https://nodemailer.com/smtp/ for every option.
   */
  smtp: SMTPTransportOptions | SMTPPoolOptions | string;
  /**
   * Sender used for any template that does not name its own. A template may
   * override it with a `from` in its content — see `send`.
   */
  from: string;
  logger?: Logger;
  /**
   * No default: an SMTP server's limits depend on who runs it. Set this to
   * the relay's sending rate, e.g. SES's per-second quota.
   */
  limits?: { limit: number; windowSeconds: number };
}

// One plain address. nodemailer parses `to` as a header value, so it doesn't
// refuse most malformed input: "alice@example.com<br>" is sent to "br", and
// "a@example.com, b@example.com" is sent to both.
const PLAIN_ADDRESS = /^[^\s@<>,;:()"]+@[^\s@<>,;:()"]+$/;

export class SmtpTransport implements Transport {
  readonly channel = "email" as const;
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly logger?: Logger;

  constructor({ smtp, from, logger, limits }: SmtpTransportOptions) {
    // One transporter for the transport's lifetime, so `pool: true` reuses
    // connections across sends instead of opening one per email.
    this.transporter = nodemailer.createTransport(smtp);
    this.from = from;
    this.logger = logger;
    this.limits = limits;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    // `destination` is optional on the contract, so a malformed task can reach
    // a transport without one. Fail here instead of opening a connection only
    // for nodemailer to refuse a message with no recipients.
    const to = task.destination;
    if (!to) {
      return {
        success: false,
        retryable: false,
        error: "No destination (recipient address) on task",
      };
    }
    if (!PLAIN_ADDRESS.test(to)) {
      return {
        success: false,
        retryable: false,
        error: "Destination is not a single email address",
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

    // Carries the List-Unsubscribe pair the engine attaches to topic-bearing
    // mail, so the inbox shows an unsubscribe button.
    const headers = task.deliveryOptions?.headers;

    try {
      const info = await this.transporter.sendMail({
        from,
        to,
        subject: subject ?? "Notification",
        // A text-only template gets an HTML part built from its text. The text
        // was rendered unescaped (it is plain text), so it is escaped here.
        html: htmlBody ?? (typeof body === "string" ? textToHtml(body) : undefined),
        text: body,
        ...(replyTo ? { replyTo } : {}),
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      });

      this.logger?.debug({ taskId: task.taskId, messageId: info.messageId }, "SMTP email sent");
      return { success: true, providerMessageId: info.messageId };
    } catch (err) {
      const error = err as NodemailerError;
      // nodemailer reads the SMTP reply class for us: `permanent` is true for
      // a 5xx (550 mailbox unavailable, 535 bad credentials), false for a 4xx,
      // and unset when no reply came back at all (connection refused, timeout).
      // 503 is the one 5xx it leaves retryable, since a new connection gets
      // past it. Only a permanent reply would be refused again.
      //
      // An envelope nodemailer refuses itself has no reply to read, and its
      // `command` is "API" because no SMTP command was sent. EENVELOPE alone
      // can't decide this: a 451 to RCPT TO carries the same code.
      const permanent =
        error.permanent === true || (error.code === "EENVELOPE" && error.command === "API");
      this.logger?.warn(
        {
          taskId: task.taskId,
          code: error.code,
          responseCode: error.responseCode,
          error: error.message,
        },
        "SMTP send failed",
      );

      return {
        success: false,
        ...(permanent ? { retryable: false } : {}),
        error: error.message,
      };
    }
  }

  /**
   * Close the transporter's connections. notifkit doesn't call this itself:
   * with `pool: true` the open sockets keep the process alive, so call it on
   * shutdown, after `server.stop()`.
   */
  close(): void {
    this.transporter.close();
  }
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
