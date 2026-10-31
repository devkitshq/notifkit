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

const ALLOWED_DISCORD_HOSTS = new Set([
  "discord.com",
  "discordapp.com",
  "ptb.discord.com",
  "canary.discord.com",
]);

export function isValidDiscordWebhookUrl(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase();
  if (!ALLOWED_DISCORD_HOSTS.has(hostname)) return false;
  if (!url.pathname.startsWith("/api/webhooks/")) return false;
  return true;
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
      return {
        success: false,
        retryable: false,
        error: "No destination (Discord webhook URL) on task",
      };
    }

    const content = task.renderedContent.content as any;
    const body = content.text || content.body;
    const subject = content.subject;
    // Discord messages have no subject line of their own, so a template that
    // renders one is bolded onto the first line rather than dropped.
    // Either part may be missing: a subject-only template must not post
    // "undefined" underneath it.
    const text = [subject ? `**${subject}**` : undefined, body]
      .filter((part) => typeof part === "string" && part)
      .join("\n");

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

      if (!isValidDiscordWebhookUrl(url)) {
        this.logger?.warn(
          { taskId: task.taskId, destination: webhookUrl },
          "Invalid Discord webhook URL rejected (SSRF protection)",
        );
        return {
          success: false,
          invalidToken: true,
          retryable: false,
          error:
            "Invalid Discord webhook URL: destination must be an https://discord.com/api/webhooks/ URL",
        };
      }

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: truncate(text, DISCORD_MAX_CONTENT),
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
          ...(isPermanentStatus(res.status) ? { retryable: false } : {}),
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

/**
 * Whether a refusal with this HTTP status is final. A 4xx says the request
 * itself is wrong, so sending it again cannot succeed; 408 and 429 are the
 * exceptions (the request was fine, the moment was not), as is every 5xx.
 */
function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** Discord rejects message content longer than this with a 400. */
const DISCORD_MAX_CONTENT = 2000;

/**
 * Cuts `text` to at most `max` UTF-16 units, ending in "…", without splitting
 * a surrogate pair. Discord refuses an over-long message outright, so a
 * truncated message beats a permanently failed one.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}
