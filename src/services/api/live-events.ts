import type { Redis } from "@/redis/index.js";
import type { Logger } from "@/logger/index.js";
import { PUBSUB_CHANNELS } from "@/contracts/index.js";
import type { LiveDeliveryEvent } from "@/services/delivery/live-events.js";

export type LiveDeliveryListener = (event: LiveDeliveryEvent) => void;

/** What getEventsStream needs: somewhere to listen for delivery outcomes. */
export interface LiveDeliveryEvents {
  /** Starts calling `listener` for every outcome; the returned function stops it. */
  listen(listener: LiveDeliveryListener): Promise<() => void>;
}

/**
 * Relays delivery outcomes published by delivery workers (in this process or
 * any other) to the API's open event streams.
 *
 * Holds the Redis subscription only while at least one stream is open: the
 * delivery side stops publishing when nobody is subscribed, so an idle API
 * costs the send path nothing.
 */
export class RedisLiveDeliveryEvents implements LiveDeliveryEvents {
  private subscriber: Redis | null = null;
  private readonly listeners = new Set<LiveDeliveryListener>();
  private subscribed: Promise<unknown> | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly logger?: Logger,
  ) {}

  async listen(listener: LiveDeliveryListener): Promise<() => void> {
    this.listeners.add(listener);
    if (!this.subscribed) this.subscribed = this.subscribe();
    await this.subscribed;
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0) return;
      this.subscribed = null;
      this.subscriber?.unsubscribe(PUBSUB_CHANNELS.DELIVERY_EVENTS).catch(() => {});
    };
  }

  private async subscribe(): Promise<void> {
    if (!this.subscriber) {
      this.subscriber = this.redis.duplicate({ enableAutoPipelining: false });
      this.subscriber.on("message", (_channel: string, raw: string) => {
        let event: LiveDeliveryEvent;
        try {
          event = JSON.parse(raw);
        } catch {
          return;
        }
        for (const listener of this.listeners) listener(event);
      });
    }
    try {
      await this.subscriber.subscribe(PUBSUB_CHANNELS.DELIVERY_EVENTS);
      // Delivery workers that found nobody listening have gone quiet; wake
      // them now that someone is, so the next outcome is not missed.
      await this.redis.publish(PUBSUB_CHANNELS.DELIVERY_EVENTS_WANTED, "1");
    } catch (err) {
      // The stream stays open and simply carries nothing until a retry.
      this.subscribed = null;
      this.logger?.warn({ err }, "could not subscribe to live delivery events");
    }
  }

  async close(): Promise<void> {
    this.listeners.clear();
    this.subscribed = null;
    this.subscriber?.disconnect();
    this.subscriber = null;
  }
}
