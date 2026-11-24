import webpush from "web-push";
import type {
  DeliveryResult,
  Logger,
  NotificationDispatchedPayload,
  Transport,
} from "notifkit";

export interface WebPushTransportOptions {
  /** VAPID `mailto:` or `https://` contact subject. */
  subject: string;
  /** VAPID URL-safe base64 public key. */
  publicKey: string;
  /** VAPID URL-safe base64 private key. */
  privateKey: string;
  logger?: Logger;
  limits?: { limit: number; windowSeconds: number };
}

const MAX_PAYLOAD_BYTES = 4096;

export class WebPushTransport implements Transport {
  readonly channel = "push" as const;
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly logger?: Logger;

  constructor({
    subject,
    publicKey,
    privateKey,
    logger,
    limits = { limit: 1000, windowSeconds: 10 },
  }: WebPushTransportOptions) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    this.logger = logger;
    this.limits = limits;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    const rawSubscription = task.destination;
    if (!rawSubscription) {
      return {
        success: false,
        retryable: false,
        error: "No destination (JSON-encoded PushSubscription) on task",
      };
    }

    let subscription: webpush.PushSubscription;
    try {
      const parsed = JSON.parse(rawSubscription);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.endpoint !== "string" ||
        !parsed.keys ||
        typeof parsed.keys.p256dh !== "string" ||
        typeof parsed.keys.auth !== "string"
      ) {
        return {
          success: false,
          invalidToken: true,
          retryable: false,
          error: "Invalid PushSubscription JSON: missing endpoint or keys",
        };
      }
      subscription = parsed as webpush.PushSubscription;
    } catch {
      return {
        success: false,
        invalidToken: true,
        retryable: false,
        error: "Invalid PushSubscription JSON",
      };
    }

    const content = task.renderedContent.content as Record<string, unknown>;
    const body =
      typeof content.text === "string"
        ? content.text
        : typeof content.body === "string"
          ? content.body
          : "";
    const title =
      typeof content.title === "string" && content.title
        ? content.title
        : typeof content.subject === "string"
          ? content.subject
          : undefined;
    const data = content.data && typeof content.data === "object" ? content.data : undefined;

    const payload = JSON.stringify({
      ...(title !== undefined ? { title } : {}),
      body,
      ...(data !== undefined ? { data } : {}),
    });

    if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
      return {
        success: false,
        retryable: false,
        error: `Web Push payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
      };
    }

    try {
      const result = await webpush.sendNotification(subscription, payload);
      this.logger?.debug(
        { taskId: task.taskId, statusCode: result.statusCode },
        "Web Push notification sent",
      );
      return { success: true, providerMessageId: task.taskId };
    } catch (err: any) {
      const statusCode = typeof err?.statusCode === "number" ? err.statusCode : undefined;
      const message = typeof err?.message === "string" ? err.message : "Web Push send failed";

      this.logger?.warn({ taskId: task.taskId, statusCode, error: message }, "Web Push send failed");

      if (statusCode === 404 || statusCode === 410) {
        return {
          success: false,
          invalidToken: true,
          retryable: false,
          error: message,
        };
      }

      if (statusCode === 429) {
        return {
          success: false,
          throttled: true,
          error: message,
        };
      }

      return {
        success: false,
        ...(isPermanentStatus(statusCode) ? { retryable: false } : {}),
        error: message,
      };
    }
  }
}

function isPermanentStatus(status: number | undefined): boolean {
  return (
    typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429
  );
}
