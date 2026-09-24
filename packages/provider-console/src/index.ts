import type {
  Transport,
  NotificationDispatchedPayload,
  DeliveryResult,
  NotificationChannel,
  Logger,
} from "notifkit";

export interface ConsoleTransportOptions {
  channel?: NotificationChannel;
  logger?: Logger;
  limits?: { limit: number; windowSeconds: number };
  latencyMs?: number | string;
}

export class ConsoleTransport implements Transport {
  readonly channel: NotificationChannel;
  readonly limits?: { limit: number; windowSeconds: number };
  readonly latencyMs?: number | string;
  private readonly logger?: Logger;

  constructor({ channel = "push", logger, limits, latencyMs }: ConsoleTransportOptions = {}) {
    this.channel = channel;
    this.logger = logger;
    this.limits = limits;
    this.latencyMs = latencyMs;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    if (this.latencyMs) {
      let delay = 0;
      if (typeof this.latencyMs === "number" && this.latencyMs > 0) {
        delay = this.latencyMs;
      } else if (typeof this.latencyMs === "string" && this.latencyMs.includes("-")) {
        const [minStr, maxStr] = this.latencyMs.split("-");
        const min = parseInt(minStr!, 10) || 0;
        const max = parseInt(maxStr!, 10) || min;
        delay = min === max ? min : Math.floor(Math.random() * (max - min + 1)) + min;
      } else if (typeof this.latencyMs === "string") {
        delay = parseInt(this.latencyMs, 10) || 0;
      }
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    const providerMessageId = `console-${Date.now()}`;

    console.log(
      [
        "",
        "┌─────────────────  📲  PUSH NOTIFICATION  ─────────────────",
        `│ to token : ${task.destination}`,
        `│ recipient: ${task.recipientId}`,
        `│ priority : ${task.priority}`,
        `│ content  : ${JSON.stringify(task.renderedContent.content)}`,
        `│ taskId   : ${task.taskId}`,
        "└───────────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );

    this.logger?.info(
      {
        taskId: task.taskId,
        channel: this.channel,
        destination: task.destination,
        providerMessageId,
      },
      "push delivered (console transport)",
    );

    return { success: true, providerMessageId };
  }
}
