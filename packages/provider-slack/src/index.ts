import type { DeliveryResult, Transport } from "notifkit";
import type { NotificationDispatchedPayload, Logger } from "notifkit";

const WEB_API_URL = "https://slack.com/api/chat.postMessage";
const INCOMING_WEBHOOK_PREFIX = "https://hooks.slack.com/";

// Errors chat.postMessage returns for a destination that is dead, not one
// that is merely temporarily rejected (rate limits, auth hiccups). Only these
// suppress the contact — anything else is worth retrying.
// https://api.slack.com/methods/chat.postMessage#errors
const INVALID_DESTINATION_ERRORS = new Set([
  "channel_not_found",
  "is_archived",
  "channel_is_archived",
  "user_not_found",
  "account_inactive",
  "not_in_channel",
]);

// Incoming webhooks report the same class of failure as plain-text response
// bodies rather than a JSON error code.
// https://api.slack.com/messaging/webhooks#handling_errors
const INVALID_WEBHOOK_BODIES = new Set(["channel_not_found", "channel_is_archived", "no_service"]);

export interface SlackTransportOptions {
  /**
   * Bot token (xoxb-...) used for chat.postMessage. Required unless every
   * recipient's destination is a full Incoming Webhook URL, which needs no
   * token at all.
   */
  botToken?: string;
  logger?: Logger;
  limits?: { limit: number; windowSeconds: number };
}

export class SlackTransport implements Transport {
  readonly channel = "webhook" as const;
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly botToken?: string;
  private readonly logger?: Logger;

  constructor({
    botToken,
    logger,
    // Slack's own guidance for chat.postMessage is roughly one message per
    // second per channel; this is a conservative workspace-wide default, not
    // a promise, so callers on a higher app tier should raise it.
    limits = { limit: 50, windowSeconds: 60 },
  }: SlackTransportOptions = {}) {
    this.botToken = botToken;
    this.logger = logger;
    this.limits = limits;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    // `destination` is optional on the contract, so a malformed task can
    // reach a transport without one. Failing here costs one clear error;
    // reaching Slack without one costs an opaque provider rejection.
    const content = task.renderedContent.content as any;

    // A template may pin its own channel (e.g. a shared "system-alerts" room)
    // the same way ResendTransport lets a template pin its own `from` —
    // one transport can then serve both per-recipient DMs and fixed rooms.
    const destination =
      (typeof content.channel === "string" && content.channel) || task.destination;
    if (!destination) {
      return {
        success: false,
        error: "No destination (Slack channel/user ID, or webhook URL) on task",
      };
    }

    const text = content.text || content.body;
    const blocks = Array.isArray(content.blocks) ? content.blocks : undefined;
    // Slack always needs `text` for notification previews and accessibility,
    // even when the visible message is carried entirely by `blocks`.
    const fallbackText = text || content.subject || "New notification";

    if (destination.startsWith(INCOMING_WEBHOOK_PREFIX)) {
      return this.sendViaIncomingWebhook(destination, fallbackText, blocks, task);
    }

    if (!this.botToken) {
      return {
        success: false,
        error: "Destination is a Slack channel/user ID but no botToken is configured",
      };
    }

    return this.sendViaWebApi(destination, fallbackText, blocks, task);
  }

  private async sendViaWebApi(
    channel: string,
    text: string,
    blocks: unknown[] | undefined,
    task: NotificationDispatchedPayload,
  ): Promise<DeliveryResult> {
    try {
      const response = await fetch(WEB_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.botToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ channel, text, ...(blocks ? { blocks } : {}) }),
      });

      const body = (await response.json()) as {
        ok: boolean;
        ts?: string;
        channel?: string;
        error?: string;
      };

      if (!body.ok) {
        const invalidToken = INVALID_DESTINATION_ERRORS.has(body.error ?? "");
        this.logger?.warn(
          { taskId: task.taskId, error: body.error, invalidToken },
          "Slack chat.postMessage failed",
        );
        return { success: false, invalidToken, error: body.error ?? "Slack API error" };
      }

      const providerMessageId = body.ts ? `${body.channel ?? channel}:${body.ts}` : undefined;
      this.logger?.debug({ taskId: task.taskId, providerMessageId }, "Slack message sent");
      return { success: true, providerMessageId };
    } catch (err) {
      const error = err as Error;
      this.logger?.error({ taskId: task.taskId, error: error.message }, "Slack unexpected error");
      return { success: false, error: error.message };
    }
  }

  private async sendViaIncomingWebhook(
    url: string,
    text: string,
    blocks: unknown[] | undefined,
    task: NotificationDispatchedPayload,
  ): Promise<DeliveryResult> {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ text, ...(blocks ? { blocks } : {}) }),
      });

      const body = await response.text();

      if (!response.ok || body.trim() !== "ok") {
        const invalidToken = INVALID_WEBHOOK_BODIES.has(body.trim());
        this.logger?.warn(
          { taskId: task.taskId, status: response.status, body, invalidToken },
          "Slack incoming webhook failed",
        );
        return { success: false, invalidToken, error: body || `HTTP ${response.status}` };
      }

      const providerMessageId = `slack-webhook-${task.taskId}`;
      this.logger?.debug({ taskId: task.taskId, providerMessageId }, "Slack webhook message sent");
      return { success: true, providerMessageId };
    } catch (err) {
      const error = err as Error;
      this.logger?.error({ taskId: task.taskId, error: error.message }, "Slack unexpected error");
      return { success: false, error: error.message };
    }
  }
}
