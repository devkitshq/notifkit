import type {
  DeliveryResult,
  Logger,
  NotificationDispatchedPayload,
  Transport,
} from "notifkit";

export interface NtfyTransportOptions {
  /** Base URL of the ntfy server (defaults to `https://ntfy.sh`). */
  serverUrl?: string;
  /** Optional Bearer access token for protected topics. */
  accessToken?: string;
  logger?: Logger;
  limits?: { limit: number; windowSeconds: number };
}

const DEFAULT_SERVER_URL = "https://ntfy.sh";
const VALID_TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;

const PRIORITY_MAP: Record<string, string> = {
  low: "2",
  normal: "3",
  high: "4",
  critical: "5",
};

export class NtfyTransport implements Transport {
  readonly channel = "push" as const;
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly serverUrl: string;
  private readonly accessToken?: string;
  private readonly logger?: Logger;

  constructor({
    serverUrl = DEFAULT_SERVER_URL,
    accessToken,
    logger,
    limits = { limit: 1000, windowSeconds: 10 },
  }: NtfyTransportOptions = {}) {
    this.serverUrl = serverUrl.replace(/\/+$/, "");
    this.accessToken = accessToken;
    this.logger = logger;
    this.limits = limits;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    const topic = task.destination;
    if (!topic) {
      return {
        success: false,
        retryable: false,
        error: "No destination (ntfy topic) on task",
      };
    }

    if (!VALID_TOPIC_RE.test(topic)) {
      return {
        success: false,
        retryable: false,
        error: `Invalid ntfy topic "${topic}": must match ${VALID_TOPIC_RE.source}`,
      };
    }

    const content = task.renderedContent.content as Record<string, unknown>;
    const body =
      typeof content.text === "string"
        ? content.text
        : typeof content.body === "string"
          ? content.body
          : "";
    const subject = typeof content.subject === "string" ? content.subject : undefined;
    const title =
      typeof content.title === "string" && content.title ? content.title : subject;

    const taskPriority = (task as { priority?: string }).priority;
    const ntfyPriority = taskPriority ? PRIORITY_MAP[taskPriority] : undefined;

    const headers: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
    };
    if (title) headers["Title"] = title;
    if (ntfyPriority) headers["Priority"] = ntfyPriority;
    if (this.accessToken) headers["Authorization"] = `Bearer ${this.accessToken}`;

    const url = `${this.serverUrl}/${topic}`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const message = errorText || `ntfy API error (HTTP ${response.status})`;

        this.logger?.warn(
          { taskId: task.taskId, status: response.status, error: message },
          "ntfy send failed",
        );

        if (response.status === 429) {
          return {
            success: false,
            throttled: true,
            error: message,
          };
        }

        return {
          success: false,
          ...(isPermanentStatus(response.status) ? { retryable: false } : {}),
          error: message,
        };
      }

      const data = (await response.json().catch(() => null)) as { id?: string } | null;
      const providerMessageId = typeof data?.id === "string" ? data.id : "";
      this.logger?.debug({ taskId: task.taskId, messageId: providerMessageId }, "ntfy push sent");
      return { success: true, providerMessageId };
    } catch (err) {
      const error = err as Error;
      this.logger?.error({ taskId: task.taskId, error: error.message }, "ntfy unexpected error");
      return {
        success: false,
        error: error.message,
      };
    }
  }
}

function isPermanentStatus(status: number | null | undefined): boolean {
  return (
    typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429
  );
}
