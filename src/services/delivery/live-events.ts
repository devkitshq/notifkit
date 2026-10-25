import type { EventEmitter } from "node:events";
import type { Redis } from "@/redis/index.js";
import { PUBSUB_CHANNELS } from "@/contracts/index.js";

/**
 * Delivery outcomes as GET /v1/events/stream relays them. They cross from the
 * delivery worker to the API over Redis pub/sub because the two are separate
 * processes in any deployment that scales them apart; an in-process emitter
 * only ever reached an API that happened to share the delivery's process.
 */
export type LiveDeliveryEvent =
  | {
      event: "delivery:delivered";
      taskId: string;
      providerMessageId: string;
      channel: string;
      projectId: string;
    }
  | { event: "delivery:failed"; taskId: string; error: string; channel: string; projectId: string };

/**
 * How long to stop publishing after a publish nobody was subscribed to. Only
 * a fallback: an API that starts listening says so on DELIVERY_EVENTS_WANTED,
 * which ends the quiet straight away.
 */
const QUIET_MS = 5_000;

/**
 * Forwards the delivery worker's `delivery:*` events to Redis.
 *
 * The API subscribes only while a client has the stream open, so most of the
 * time a publish reaches nobody. PUBLISH says how many received it; after a 0
 * this goes quiet rather than paying a round trip per delivery for no one,
 * until an API announces it is listening.
 */
export function publishDeliveryEvents(redis: Redis, emitter: EventEmitter): () => void {
  let quietUntil = 0;
  const wanted = redis.duplicate({ enableAutoPipelining: false });
  wanted.on("message", () => (quietUntil = 0));
  wanted.subscribe(PUBSUB_CHANNELS.DELIVERY_EVENTS_WANTED).catch(() => {});

  const publish = (message: LiveDeliveryEvent) => {
    if (Date.now() < quietUntil) return;
    redis
      .publish(PUBSUB_CHANNELS.DELIVERY_EVENTS, JSON.stringify(message))
      .then((receivers) => {
        if (receivers === 0) quietUntil = Date.now() + QUIET_MS;
      })
      .catch(() => {});
  };

  const onDelivered = (
    taskId: string,
    providerMessageId: string,
    channel: string,
    projectId: string,
  ) => publish({ event: "delivery:delivered", taskId, providerMessageId, channel, projectId });
  const onFailed = (taskId: string, error: string, channel: string, projectId: string) =>
    publish({ event: "delivery:failed", taskId, error, channel, projectId });

  emitter.on("delivery:delivered", onDelivered);
  emitter.on("delivery:failed", onFailed);
  return () => {
    emitter.off("delivery:delivered", onDelivered);
    emitter.off("delivery:failed", onFailed);
    wanted.disconnect();
  };
}
