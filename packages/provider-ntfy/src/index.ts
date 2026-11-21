import type { DeliveryResult, Transport } from "notifkit";
import type { NotificationDispatchedPayload, Logger } from "notifkit";

export interface NtfyTransportOptions {
  /**
   * Base URL of the ntfy server. Defaults to https://ntfy.sh; self-hosters
   * point it at their own server.
   */
  serverUrl?: string;
  /** Access token sent as `Authorization: Bearer <token>` when set. */
  accessToken?: string;
  logger?: Logger;
}

/** ntfy topic names: 1-64 chars of letters, digits, `-` and `_`. */
const NTFY_TOPIC_PATTERN = /^[-_A-Za-z0-9]{1,64}$/;

/** ntfy Priority header (1-5) for each task priority. */
const PRIORITY_HEADER: Record<string, number> = {
  low: 2,
  normal: 3,
  high: 4,
  critical: 5,
};

export class NtfyTransport implements Transport {
  readonly channel = "push" as const;

  private readonly serverUrl: string;
  private readonly accessToken?: string;
  private readonly logger?: Logger;

  constructor({ serverUrl = "https://ntfy.sh", accessToken, logger }: NtfyTransportOptions = {}) {
    this.serverUrl = serverUrl.replace(/\/+$/, "");
    this.accessToken = accessToken;
    this.logger = logger;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    // `destination` is optional on the contract, so a malformed task can reach
    // a transport without one. Failing here costs one clear error; building
    // a URL from `undefined` costs an opaque fetch failure instead.
    const topic = task.destination;
    if (!topic) {
      return {
        success: false,
        retryable: false,
        error: "No destination (ntfy topic) on task",
      };
    }

    // The topic becomes a path segment, so it is validated before the URL is
    // built — an unvalidated destination could change the path. A malformed
    // topic is a dead destination, so the contact is deactivated rather than
    // retried.
    if (!NTFY_TOPIC_PATTERN.test(topic)) {
      this.logger?.warn({ taskId: task.taskId, destination: topic }, "Invalid ntfy topic rejected");
      return {
        success: false,
        invalidToken: true,
        retryable: false,
        error: "Invalid ntfy topic: destination must match /^[-_A-Za-z0-9]{1,64}$/",
      };
    }

    const content = task.renderedContent.content as any;
    const body = content.text || content.body || "";
    const subject =
      typeof content.subject === "string" && content.subject ? content.subject : undefined;
    const priority = PRIORITY_HEADER[task.priority] ?? 3;

    try {
      const url = `${this.serverUrl}/${topic}`;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          ...(subject ? { Title: subject } : {}),
          Priority: String(priority),
          ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body,
      });

      if (!res.ok) {
        const errorBody = await res.text();

        this.logger?.warn(
          { taskId: task.taskId, status: res.status, errorBody },
          "ntfy send failed",
        );

        return {
          success: false,
          ...(isPermanentStatus(res.status) ? { retryable: false } : {}),
          error: `ntfy error ${res.status}: ${errorBody}`,
        };
      }

      const data = (await res.json().catch(() => null)) as { id?: string } | null;
      const providerMessageId = data?.id ?? "";

      this.logger?.debug({ taskId: task.taskId, providerMessageId }, "ntfy message sent");
      return { success: true, providerMessageId };
    } catch (err) {
      const error = err as Error;
      this.logger?.error({ taskId: task.taskId, error: error.message }, "ntfy unexpected error");

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
