import type { DeliveryResult, Transport } from "notifkit";
import type { NotificationDispatchedPayload, Logger } from "notifkit";

export interface TelegramTransportOptions {
  /** Bot token from @BotFather, e.g. "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11". */
  botToken: string;
  /**
   * Formatting mode applied to every message unless a template's content
   * names its own `parseMode`. Left unset, Telegram renders plain text —
   * the safe default, since HTML/MarkdownV2 both reject malformed markup
   * with a 400 rather than falling back to plain text.
   */
  parseMode?: "HTML" | "MarkdownV2" | "Markdown";
  logger?: Logger;
  /**
   * Telegram enforces ~30 messages/sec bot-wide and 1/sec per chat. The
   * default throttles to the bot-wide ceiling; tighten it if most sends
   * land in a handful of chats.
   */
  limits?: { limit: number; windowSeconds: number };
}

export class TelegramTransport implements Transport {
  readonly channel = "telegram" as const;
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly botToken: string;
  private readonly parseMode?: string;
  private readonly logger?: Logger;

  constructor({
    botToken,
    parseMode,
    logger,
    limits = { limit: 30, windowSeconds: 1 },
  }: TelegramTransportOptions) {
    this.botToken = botToken;
    this.parseMode = parseMode;
    this.logger = logger;
    this.limits = limits;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    // `destination` is optional on the contract, so a malformed task can reach
    // a transport without one. Failing here costs one clear error; passing
    // `undefined` to the Bot API costs an opaque provider rejection and a
    // retry cycle.
    const chatId = task.destination;
    if (!chatId) {
      return { success: false, error: "No destination (Telegram chat id) on task" };
    }

    const content = task.renderedContent.content as any;
    const body = content.text || content.body;
    const subject = content.subject;
    // Telegram messages have no subject line of their own, so a template
    // that renders one gets folded into the first line rather than dropped.
    const text = subject ? `${subject}\n\n${body}` : body;
    const parseMode = typeof content.parseMode === "string" ? content.parseMode : this.parseMode;

    try {
      const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          ...(parseMode ? { parse_mode: parseMode } : {}),
          ...(content.disableWebPagePreview ? { link_preview_options: { is_disabled: true } } : {}),
          ...(content.disableNotification ? { disable_notification: true } : {}),
        }),
      });

      const data = (await res.json()) as {
        ok: boolean;
        result?: { message_id: number };
        error_code?: number;
        description?: string;
      };

      if (!data.ok) {
        // The bot was blocked/kicked, or the chat id no longer resolves to
        // anything — the target itself is dead, not a transient failure, so
        // the caller should deactivate the contact rather than retry it.
        const invalidToken =
          data.error_code === 403 ||
          (data.error_code === 400 &&
            /chat not found|user is deactivated/i.test(data.description ?? ""));

        this.logger?.warn(
          { taskId: task.taskId, errorCode: data.error_code, description: data.description },
          "Telegram send failed",
        );

        return {
          success: false,
          invalidToken,
          error: data.description ?? `Telegram API error ${data.error_code ?? "unknown"}`,
        };
      }

      const providerMessageId = String(data.result?.message_id ?? "");
      this.logger?.debug({ taskId: task.taskId, providerMessageId }, "Telegram message sent");
      return { success: true, providerMessageId };
    } catch (err) {
      const error = err as Error;
      this.logger?.error(
        { taskId: task.taskId, error: error.message },
        "Telegram unexpected error",
      );

      return { success: false, error: error.message };
    }
  }
}
