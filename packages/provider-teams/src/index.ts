import type { DeliveryResult, Logger, NotificationDispatchedPayload, Transport } from "notifkit";

export interface TeamsTransportOptions {
  logger?: Logger;
  limits?: { limit: number; windowSeconds: number };
}

const ALLOWED_TEAMS_SUFFIXES = [".logic.azure.com", ".api.powerplatform.com"];

/**
 * Accepts HTTPS Microsoft Teams Workflows hosts (`*.logic.azure.com` and
 * `*.api.powerplatform.com`) to prevent SSRF via arbitrary contact URLs.
 */
export function isValidTeamsWebhookUrl(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname.startsWith(".")) return false;
  return ALLOWED_TEAMS_SUFFIXES.some(
    (suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length,
  );
}

export class TeamsTransport implements Transport {
  readonly channel = "teams" as const;
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly logger?: Logger;

  constructor({ logger, limits = { limit: 4, windowSeconds: 1 } }: TeamsTransportOptions = {}) {
    this.logger = logger;
    this.limits = limits;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    const webhookUrl = task.destination;
    if (!webhookUrl) {
      return {
        success: false,
        retryable: false,
        error: "No destination (Microsoft Teams webhook URL) on task",
      };
    }

    const content = task.renderedContent.content as Record<string, unknown>;
    const customCard =
      content.card && typeof content.card === "object" && !Array.isArray(content.card)
        ? content.card
        : undefined;
    const subject = typeof content.subject === "string" ? content.subject : "";
    const body =
      typeof content.text === "string" && content.text
        ? content.text
        : typeof content.body === "string"
          ? content.body
          : "";

    const blocks: Record<string, unknown>[] = [];
    if (subject) {
      blocks.push({ type: "TextBlock", text: subject, weight: "Bolder", wrap: true });
    }
    if (body) {
      blocks.push({ type: "TextBlock", text: body, wrap: true });
    }

    const card = customCard ?? {
      type: "AdaptiveCard",
      version: "1.4",
      body: blocks,
    };

    try {
      const url = new URL(webhookUrl);
      if (!isValidTeamsWebhookUrl(url)) {
        this.logger?.warn(
          { taskId: task.taskId, destination: webhookUrl },
          "Invalid Teams webhook URL rejected (SSRF protection)",
        );
        return {
          success: false,
          invalidToken: true,
          retryable: false,
          error:
            "Invalid Microsoft Teams webhook URL: destination must be an https:// *.logic.azure.com or *.api.powerplatform.com URL",
        };
      }

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "message",
          attachments: [
            {
              contentType: "application/vnd.microsoft.card.adaptive",
              content: card,
            },
          ],
        }),
        signal: (task as { signal?: AbortSignal }).signal,
      });

      if (!res.ok) {
        const errorBody = await res.text();
        // Teams Workflows answers 404 when a workflow has been deleted.
        const invalidToken = res.status === 404;

        this.logger?.warn(
          { taskId: task.taskId, status: res.status, errorBody },
          "Teams send failed",
        );

        return {
          success: false,
          invalidToken,
          ...(isPermanentStatus(res.status) ? { retryable: false } : {}),
          ...(res.status === 429 ? { throttled: true } : {}),
          error: `Teams webhook error ${res.status}: ${errorBody}`,
        };
      }

      const data = (await res.json().catch(() => null)) as { id?: string } | null;
      const providerMessageId = data?.id ?? "";

      this.logger?.debug({ taskId: task.taskId, providerMessageId }, "Teams message sent");
      return { success: true, providerMessageId };
    } catch (err) {
      const error = err as Error;
      this.logger?.error({ taskId: task.taskId, error: error.message }, "Teams unexpected error");

      return { success: false, error: error.message };
    }
  }
}

function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
