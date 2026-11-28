import type { DeliveryResult, Transport } from "notifkit";
import type { NotificationDispatchedPayload, Logger } from "notifkit";
import { createHash } from "node:crypto";
import { initializeApp, getApp, cert, type App } from "firebase-admin/app";
import { getMessaging, type Messaging } from "firebase-admin/messaging";

export interface FcmTransportOptions {
  serviceAccountJson: string;
  logger?: Logger;
  limits?: { limit: number; windowSeconds: number };
}

export class FcmTransport implements Transport {
  readonly channel = "push" as const;
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly serviceAccountJson: string;
  private readonly logger?: Logger;
  private messaging: Messaging | null = null;

  constructor({
    serviceAccountJson,
    logger,
    limits = { limit: 1000, windowSeconds: 60 },
  }: FcmTransportOptions) {
    this.serviceAccountJson = serviceAccountJson;
    this.logger = logger;
    this.limits = limits;
  }

  private getMessaging(): Messaging {
    if (this.messaging) return this.messaging;

    // One app per service account: a shared name would hand a second
    // transport the first one's credentials.
    const appName = `notifkit-${createHash("sha256").update(this.serviceAccountJson).digest("hex").slice(0, 16)}`;
    let app: App;
    try {
      app = getApp(appName);
    } catch {
      const serviceAccount = JSON.parse(this.serviceAccountJson) as Record<string, unknown>;
      app = initializeApp({ credential: cert(serviceAccount) }, appName);
    }

    this.messaging = getMessaging(app);
    return this.messaging;
  }

  /**
   * Not another push provider's address: FCM answers one with invalid-argument,
   * which reads as a dead token and would deactivate a working contact. A Web
   * Push subscription is JSON; an ntfy topic or a OneSignal subscription id
   * (a UUID) is at most 64 of `[-_A-Za-z0-9]`. Real FCM tokens are longer and
   * have a ':'.
   */
  accepts(destination: string): boolean {
    return !destination.trimStart().startsWith("{") && !/^[-_A-Za-z0-9]{1,64}$/.test(destination);
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    // `destination` is optional on the contract, so a malformed task can reach
    // a transport without one. Failing here costs one clear error; passing
    // `undefined` to FCM costs an opaque provider rejection and a retry cycle.
    const token = task.destination;
    if (!token) {
      return {
        success: false,
        retryable: false,
        error: "No destination (FCM registration token) on task",
      };
    }

    const content = task.renderedContent.content as any;
    const body = content.text || content.body;
    // Push templates, like the one `create-notifkit` scaffolds, name the
    // header `title`; email-style templates name it `subject`.
    const title = content.title || content.subject;
    const htmlBody = content.htmlBody || content.html;

    try {
      // Inside the try: a malformed service account must fail this send, not
      // throw out of the transport.
      const messageId = await this.getMessaging().send({
        token,
        notification: {
          title: title ?? "",
          body,
        },
        data: {
          eventId: task.enrichedEventId,
          taskId: task.taskId,
          ...(htmlBody ? { htmlBody } : {}),
        },
        android: {
          priority: task.priority === "critical" || task.priority === "high" ? "high" : "normal",
        },
        apns: {
          payload: {
            aps: {
              sound: "default",
              badge: 1,
            },
          },
        },
      });

      this.logger?.debug({ taskId: task.taskId, messageId }, "FCM message sent");
      return { success: true, providerMessageId: messageId };
    } catch (err) {
      const error = err as { code?: string; message?: string };
      const invalidTokenCodes = [
        "messaging/invalid-registration-token",
        "messaging/registration-token-not-registered",
        "messaging/invalid-argument",
      ];
      const isInvalidToken = invalidTokenCodes.includes(error.code ?? "");
      // FCM reports by code, not status. A `messaging/` code is FCM's answer
      // to this message, final unless it is a rate limit or an outage; any
      // other error (the network, the SDK) never reached that answer.
      const permanent =
        isInvalidToken ||
        (error.code?.startsWith("messaging/") === true && !RETRYABLE_CODES.has(error.code));

      this.logger?.warn(
        { taskId: task.taskId, code: error.code, invalidToken: isInvalidToken },
        "FCM send failed",
      );

      return {
        success: false,
        invalidToken: isInvalidToken,
        ...(permanent ? { retryable: false } : {}),
        ...(RATE_LIMIT_CODES.has(error.code ?? "") ? { throttled: true } : {}),
        error: error.message ?? "FCM error",
      };
    }
  }
}

/** Quota and rate limits: FCM is up but wants fewer sends. */
const RATE_LIMIT_CODES = new Set([
  "messaging/quota-exceeded",
  "messaging/message-rate-exceeded",
  "messaging/device-message-rate-exceeded",
  "messaging/topics-message-rate-exceeded",
]);

/**
 * The `messaging/` errors a later attempt can get past: quota and rate limits,
 * and FCM's own failures.
 * https://firebase.google.com/docs/cloud-messaging/send/admin-sdk#admin
 */
const RETRYABLE_CODES = new Set([
  ...RATE_LIMIT_CODES,
  "messaging/internal-error",
  "messaging/server-unavailable",
  "messaging/unavailable",
  "messaging/unknown-error",
]);
