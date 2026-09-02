import type { DeliveryResult, Transport } from "notifkit";
import type { NotificationDispatchedPayload, Logger } from "notifkit";

export interface DiscordTransportOptions {
  /**
   * Default sender name shown on messages, overridable per template via
   * `content.username`. Left unset, Discord uses the webhook's own name.
   */
  username?: string;
  /** Default avatar URL, overridable per template via `content.avatarUrl`. */
  avatarUrl?: string;
  logger?: Logger;
  /**
   * Discord enforces roughly 5 requests / 2 seconds per webhook. Tighten
   * this if several templates share one webhook and could burst together.
   */
  limits?: { limit: number; windowSeconds: number };
}

export class DiscordTransport implements Transport {
  readonly channel = "discord" as const;
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly username?: string;
  private readonly avatarUrl?: string;
  private readonly logger?: Logger;

  constructor({
    username,
    avatarUrl,
    logger,
    limits = { limit: 5, windowSeconds: 2 },
  }: DiscordTransportOptions = {}) {
    this.username = username;
    this.avatarUrl = avatarUrl;
    this.logger = logger;
    this.limits = limits;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    // `destination` is optional on the contract, so a malformed task can reach
    // a transport without one. Failing here costs one clear error; passing
    // `undefined` as the webhook URL costs an opaque fetch failure instead.
    const webhookUrl = task.destination;
    if (!webhookUrl) {
      return { success: false, error: "No destination (Discord webhook URL) on task" };
    }

    const content = task.renderedContent.content as any;
    const body = content.text || content.body;
    const subject = content.subject;
    // Discord messages have no subject line of their own, so a template that
    // renders one is bolded onto the first line rather than dropped.
    const text = subject ? `**${subject}**\n${body}` : body;

    // A template may carry its own sender, so one webhook can post as
    // different bots for different alert types.
    const username =
      typeof content.username === "string" && content.username ? content.username : this.username;
    const avatarUrl =
      typeof content.avatarUrl === "string" && content.avatarUrl
        ? content.avatarUrl
        : this.avatarUrl;
    const embeds = Array.isArray(content.embeds) ? content.embeds : undefined;

    try {
      // `wait=true` makes Discord return the created message (with its id)
      // in the response body instead of an empty 204 — without it there is
      // no providerMessageId to record in the delivery log.
      const url = new URL(webhookUrl);
      url.searchParams.set("wait", "true");

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: text,
          ...(username ? { username } : {}),
          ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
          ...(embeds ? { embeds } : {}),
        }),
      });

      if (!res.ok) {
        const errorBody = await res.text();
        // A deleted or regenerated webhook answers 404/401 for every future
        // request — the target itself is dead, not a transient failure, so
        // the caller should deactivate the contact rather than retry it.
        const invalidToken = res.status === 404 || res.status === 401;

        this.logger?.warn(
          { taskId: task.taskId, status: res.status, errorBody },
          "Discord send failed",
        );

        return {
          success: false,
          invalidToken,
          error: `Discord webhook error ${res.status}: ${errorBody}`,
        };
      }

      const data = (await res.json().catch(() => null)) as { id?: string } | null;
      const providerMessageId = data?.id ?? "";

      this.logger?.debug({ taskId: task.taskId, providerMessageId }, "Discord message sent");
      return { success: true, providerMessageId };
    } catch (err) {
      const error = err as Error;
      this.logger?.error({ taskId: task.taskId, error: error.message }, "Discord unexpected error");

      return { success: false, error: error.message };
    }
  }
}
