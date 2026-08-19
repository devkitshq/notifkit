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
}

export class ConsoleTransport implements Transport {
  readonly channel: NotificationChannel;
  readonly limits?: { limit: number; windowSeconds: number };
  private readonly logger?: Logger;

  constructor({ channel = "push", logger, limits }: ConsoleTransportOptions = {}) {
    this.channel = channel;
    this.logger = logger;
    this.limits = limits;
  }

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
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
