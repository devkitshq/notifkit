import type { DeliveryResult, Transport } from "notifkit";
import type { NotificationDispatchedPayload, Logger } from "notifkit";

export interface TeamsTransportOptions {
  logger?: Logger;
  limits?: { limit: number; windowSeconds: number };
}

/**
 * Host suffixes a Teams Workflows webhook URL may live on. Microsoft is
 * migrating HTTP trigger endpoints from the older `*.logic.azure.com` domain
 * to the newer `*.api.powerplatform.com` domain (the new form is
 * `<host>.environment.api.powerplatform.com`); both are live, so both are
 * accepted. The retired Office 365 connector host `webhook.office.com` is
 * deliberately not here.
 */
const ALLOWED_TEAMS_HOST_SUFFIXES = [".logic.azure.com", ".api.powerplatform.com"];

export function isValidTeamsWebhookUrl(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase();
  return ALLOWED_TEAMS_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

export class TeamsTransport implements Transport {
  readonly channel = "teams" as const;
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly logger?: Logger;

  constructor({ logger, limits }: TeamsTransportOptions = {}) {
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
        error: "No destination (Teams webhook URL) on task",
      };
    }

    const content = task.renderedContent.content as any;
    const body = content.text || content.body;
    const subject = content.subject;
    // A template may carry its own Adaptive Card, so one webhook can post
    // richer cards for different alert types; otherwise the subject (when
    // present) and body are laid out as text blocks. Either part may be
    // missing: a subject-only template must not post "undefined" underneath
    // it, and a body-only template gets no empty subject block.
    const card =
      content.card && typeof content.card === "object" && !Array.isArray(content.card)
        ? content.card
        : buildAdaptiveCard(subject, body);

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
            "Invalid Teams webhook URL: destination must be an https://*.logic.azure.com or https://*.api.powerplatform.com Workflows webhook URL",
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
      });

      if (!res.ok) {
        const errorBody = await res.text();
        // A deleted workflow answers 404 for every future request — the
        // target itself is dead, not a transient failure, so the caller
        // should deactivate the contact rather than retry it.
        const invalidToken = res.status === 404;

        this.logger?.warn(
          { taskId: task.taskId, status: res.status, errorBody },
          "Teams send failed",
        );

        return {
          success: false,
          invalidToken,
          ...(isPermanentStatus(res.status) ? { retryable: false } : {}),
          error: `Teams webhook error ${res.status}: ${errorBody}`,
        };
      }

      // Workflows answers 202 with no message id, so there is nothing to
      // record in the delivery log.
      this.logger?.debug({ taskId: task.taskId, providerMessageId: "" }, "Teams message sent");
      return { success: true, providerMessageId: "" };
    } catch (err) {
      const error = err as Error;
      this.logger?.error({ taskId: task.taskId, error: error.message }, "Teams unexpected error");

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

function buildAdaptiveCard(subject: unknown, body: unknown): Record<string, unknown> {
  const blocks: Record<string, unknown>[] = [];
  if (typeof subject === "string" && subject) {
    blocks.push({ type: "TextBlock", text: subject, weight: "Bolder", wrap: true });
  }
  if (typeof body === "string" && body) {
    blocks.push({ type: "TextBlock", text: body, wrap: true });
  }
  return {
    type: "AdaptiveCard",
    version: "1.4",
    body: blocks,
  };
}
