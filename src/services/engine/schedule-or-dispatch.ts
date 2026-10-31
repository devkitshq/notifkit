import { randomUUID } from "node:crypto";
import type { Logger } from "@/index.js";
import { buildStreamEvent, type DispatchedTaskPayload, type StreamEvent } from "@/index.js";
import { scheduledPayloads } from "@/db/schema.js";
import { getPriorityBucket } from "@/shared/index.js";

export interface ScheduleOrDispatchDeps {
  db: any;
  scheduledProducer: any;
  outboundProducers: any;
  logger: Logger;
  /** Delivery in this process, when the pipeline is fused. */
  inlineNext?: ((event: StreamEvent) => Promise<void>) | null;
}

export interface ScheduleOrDispatchOptions {
  source: string;
  scheduledAt?: string;
  messageId: string;
  traceId?: string;
  logLevel: "debug" | "info";
  scheduledMessage: string;
  dispatchedMessage: string;
}

/**
 * Caches the payload and publishes `notification.scheduled` when the task is due
 * later, otherwise publishes `notification.dispatched` to the outbound stream
 * for its priority (or hands it to the fused delivery worker).
 */
export async function scheduleOrDispatch(
  deps: ScheduleOrDispatchDeps,
  taskPayload: DispatchedTaskPayload,
  opts: ScheduleOrDispatchOptions,
): Promise<void> {
  const { taskId } = taskPayload;
  const envelope = buildStreamEvent(
    "notification.dispatched",
    taskPayload as Record<string, unknown>,
    opts.source,
    opts.traceId,
  );

  // Route by scheduledAt
  const now = Date.now();
  const scheduledAt = opts.scheduledAt ? new Date(opts.scheduledAt).getTime() : now;

  if (scheduledAt > now) {
    await deps.db
      .insert(scheduledPayloads)
      .values({
        taskId,
        // The send time rides in the payload so the scheduler can re-queue
        // this from Postgres if Redis loses its data.
        payload: { ...taskPayload, scheduledAt: opts.scheduledAt },
      })
      .onConflictDoNothing();

    const scheduledEnvelope = buildStreamEvent(
      "notification.scheduled",
      {
        projectId: taskPayload.projectId,
        enrichedEventId: taskPayload.enrichedEventId,
        taskId,
        scheduledAt: opts.scheduledAt!,
      },
      opts.source,
      opts.traceId,
    );

    await deps.scheduledProducer.publish(scheduledEnvelope);
    deps.logger[opts.logLevel](
      {
        messageId: opts.messageId,
        taskId,
        scheduledAt: opts.scheduledAt,
        traceId: opts.traceId,
      },
      opts.scheduledMessage,
    );
  } else {
    const p = getPriorityBucket(taskPayload.priority);
    const outboundProducer = deps.outboundProducers[p] ?? deps.outboundProducers["normal"]!;

    if (deps.inlineNext) {
      await deps.inlineNext({
        ...envelope,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
      } as StreamEvent);
    } else {
      await outboundProducer.publish(envelope);
    }
    deps.logger[opts.logLevel](
      {
        messageId: opts.messageId,
        taskId,
        recipientId: taskPayload.recipientId,
        traceId: opts.traceId,
      },
      opts.dispatchedMessage,
    );
  }
}
