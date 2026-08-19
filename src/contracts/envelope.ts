import { z } from "zod";
import { EventMetadataSchema, type EventMetadata } from "./metadata.js";
import type { EventPayloadMap, KnownEventType } from "./registry.js";

/**
 * Wire format written to Redis Streams. The payload field is an opaque record
 * at the envelope level — use registry.parsePayload() to get a typed payload.
 */
export const EventEnvelopeSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  timestamp: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
  metadata: EventMetadataSchema,
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** Typed envelope where the payload is strongly typed via EventPayloadMap. */
export type TypedEventEnvelope<K extends KnownEventType> = Omit<
  EventEnvelope,
  "type" | "payload"
> & {
  type: K;
  payload: EventPayloadMap[K];
};

// Backward-compatible alias used by the queue / workers packages.
export type StreamEvent = EventEnvelope;
export const StreamEventSchema = EventEnvelopeSchema;
export type StreamEventMetadata = EventMetadata;
export const StreamEventMetadataSchema = EventMetadataSchema;
