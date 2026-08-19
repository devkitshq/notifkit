import type { DeliveryResult, Transport } from "notifkit";
import type { NotificationDispatchedPayload, Logger } from "notifkit";
import type { App } from "firebase-admin/app";
import type { Messaging } from "firebase-admin/messaging";

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

  private async getMessaging(): Promise<Messaging> {
    if (this.messaging) return this.messaging;

    const { initializeApp, getApp, cert } = await import("firebase-admin/app");
    const { getMessaging } = await import("firebase-admin/messaging");

    let app: App;
    try {
      app = getApp("notifkit");
    } catch {
      const serviceAccount = JSON.parse(this.serviceAccountJson) as Record<string, unknown>;
      app = initializeApp({ credential: cert(serviceAccount) }, "notifkit");
    }

    this.messaging = getMessaging(app);
    return this.messaging;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    // `destination` is optional on the contract, so a malformed task can reach
    // a transport without one. Failing here costs one clear error; passing
    // `undefined` to FCM costs an opaque provider rejection and a retry cycle.
    const token = task.destination;
    if (!token) {
      return { success: false, error: "No destination (FCM registration token) on task" };
    }

    const messaging = await this.getMessaging();
    const content = task.renderedContent.content as any;
    const body = content.text || content.body;
    const subject = content.subject;
    const htmlBody = content.htmlBody || content.html;

    try {
      const messageId = await messaging.send({
        token,
        notification: {
          title: subject ?? "",
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

      this.logger?.warn(
        { taskId: task.taskId, code: error.code, invalidToken: isInvalidToken },
        "FCM send failed",
      );

      return {
        success: false,
        invalidToken: isInvalidToken,
        error: error.message ?? "FCM error",
      };
    }
  }
}
