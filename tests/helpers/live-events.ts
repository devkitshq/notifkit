import type { LiveDeliveryEvents, LiveDeliveryListener } from "@/services/api/live-events.js";
import type { LiveDeliveryEvent } from "@/services/delivery/live-events.js";

/** An in-memory stand-in for the Redis relay behind GET /v1/events/stream. */
export function fakeLiveEvents(): LiveDeliveryEvents & {
  emit(event: LiveDeliveryEvent): void;
  listening(): number;
} {
  const listeners = new Set<LiveDeliveryListener>();
  return {
    async listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    listening: () => listeners.size,
  };
}
