import { randomUUID } from "node:crypto";
import { type EventEnvelope } from "./envelope.js";

// Builds the event shape `StreamProducer.publish()` takes.
export function buildStreamEvent(
  type: string,
  payload: Record<string, unknown>,
  source: string,
  traceId?: string,
): Omit<EventEnvelope, "id" | "timestamp"> {
  return {
    type,
    payload,
    metadata: {
      traceId: traceId ?? randomUUID(),
      source,
      retryCount: 0,
    },
  };
}
