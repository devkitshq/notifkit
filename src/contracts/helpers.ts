import { randomUUID } from "node:crypto";
import { type EventEnvelope } from "./envelope.js";

// Legacy factory helpers — backward compatible with the queue package's publish() API,
// which accepts Omit<StreamEvent, "id" | "timestamp">.
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
