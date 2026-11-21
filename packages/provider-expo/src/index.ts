import type { DeliveryResult, Transport } from "notifkit";
import type { NotificationDispatchedPayload, Logger } from "notifkit";

export interface ExpoTransportOptions {
  /**
   * Access token for Expo's enhanced push security. Leave it unset unless the
   * project turned that setting on: then every send needs it, and a send
   * without it fails with `UNAUTHORIZED`.
   */
  accessToken?: string;
  logger?: Logger;
  /**
   * Expo accepts up to 600 notifications a second per project, and the
   * default stays at that ceiling. Lower it if other services send through
   * the same Expo project.
   */
  limits?: { limit: number; windowSeconds: number };
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** The two spellings Expo issues push tokens in. */
const EXPO_PUSH_TOKEN = /^Expo(nent)?PushToken\[.+\]$/;

interface ExpoPushTicket {
  status?: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

interface ExpoPushResponse {
  data?: ExpoPushTicket | ExpoPushTicket[];
  errors?: { code?: string; message?: string }[];
}

export class ExpoTransport implements Transport {
  readonly channel = "push" as const;
  readonly limits?: { limit: number; windowSeconds: number };

  private readonly accessToken?: string;
  private readonly logger?: Logger;

  constructor({
    accessToken,
    logger,
    limits = { limit: 600, windowSeconds: 1 },
  }: ExpoTransportOptions = {}) {
    this.accessToken = accessToken;
    this.logger = logger;
    this.limits = limits;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    // `destination` is optional on the contract, so a malformed task can reach
    // a transport without one. Failing here costs one clear error; passing
    // `undefined` to Expo costs an opaque provider rejection and a retry cycle.
    const token = task.destination;
    if (!token) {
      return {
        success: false,
        retryable: false,
        error: "No destination (Expo push token) on task",
      };
    }
    // An FCM or APNs device token in a push contact can't be delivered through
    // Expo, so the contact is dead for this transport.
    if (!EXPO_PUSH_TOKEN.test(token)) {
      return {
        success: false,
        invalidToken: true,
        retryable: false,
        error:
          "Destination is not an Expo push token (ExponentPushToken[...] or ExpoPushToken[...])",
      };
    }

    const content = task.renderedContent.content as any;
    const body = content.text || content.body;
    const title = content.subject;

    // Delivery aborts this signal when the send outlives its timeout, which
    // also cancels the HTTP request. Called on its own, a send gets the same
    // timeout.
    const signal =
      (task as { signal?: AbortSignal }).signal ??
      AbortSignal.timeout(task.deliveryOptions?.timeoutMs ?? 10_000);

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify({
          to: token,
          title,
          body,
          data: { eventId: task.enrichedEventId, taskId: task.taskId },
        }),
      });

      // A proxy or gateway in front of Expo can answer with a page that isn't
      // JSON; the status still says what happened.
      const payload = (await res.json().catch(() => undefined)) as ExpoPushResponse | undefined;

      if (!res.ok) {
        // The whole request was refused, before any ticket was issued.
        const requestError = payload?.errors?.[0];
        this.logger?.warn(
          { taskId: task.taskId, status: res.status, code: requestError?.code },
          "Expo push request failed",
        );
        return {
          success: false,
          ...(isPermanentStatus(res.status) ? { retryable: false } : {}),
          // Over Expo's per-project rate: delivery waits for capacity instead
          // of spending a retry.
          ...(res.status === 429 ? { throttled: true } : {}),
          error: requestError?.message ?? `Expo push API error ${res.status}`,
        };
      }

      // One message in, one ticket out: `data` is the ticket itself, not an array.
      const ticket = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;

      if (ticket?.status === "ok") {
        const providerMessageId = ticket.id ?? "";
        this.logger?.debug({ taskId: task.taskId, providerMessageId }, "Expo push sent");
        return { success: true, providerMessageId };
      }

      if (ticket?.status === "error") {
        const code = ticket.details?.error;
        const invalidToken = code === "DeviceNotRegistered";
        this.logger?.warn({ taskId: task.taskId, code, invalidToken }, "Expo push failed");
        return {
          success: false,
          invalidToken,
          ...(invalidToken || PERMANENT_TICKET_ERRORS.has(code ?? "") ? { retryable: false } : {}),
          // Too many sends to this device; like FCM's device rate limit, it is
          // waited out rather than counted as a failed attempt.
          ...(code === "MessageRateExceeded" ? { throttled: true } : {}),
          error: ticket.message ?? `Expo push error ${code ?? "unknown"}`,
        };
      }

      // A 2xx without a ticket says nothing about the message, so it's retried.
      this.logger?.warn(
        { taskId: task.taskId, status: res.status },
        "Expo push response had no ticket",
      );
      return { success: false, error: "Expo push response had no ticket" };
    } catch (err) {
      const error = err as Error;
      this.logger?.error(
        { taskId: task.taskId, error: error.message },
        "Expo push unexpected error",
      );
      return { success: false, error: error.message };
    }
  }
}

/**
 * Ticket errors a later attempt can't get past: the message is over Expo's
 * 4096-byte limit, or the project's push credentials are wrong. Sending the
 * same message again fails the same way until someone fixes the message or
 * the credentials. `MessageRateExceeded` is waited out and unknown codes are
 * retried.
 * https://docs.expo.dev/push-notifications/sending-notifications/
 */
const PERMANENT_TICKET_ERRORS = new Set([
  "MessageTooBig",
  "InvalidCredentials",
  "MismatchSenderId",
  "InvalidProviderToken",
]);

/**
 * Whether a refusal with this HTTP status is final. A 4xx says the request
 * itself is wrong, so sending it again cannot succeed; 408 and 429 are the
 * exceptions (the request was fine, the moment was not), as is every 5xx.
 */
function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
