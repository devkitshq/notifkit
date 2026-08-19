export const STREAMS = {
  INBOUND_CRITICAL: "notifkit:stream:inbound:critical",
  INBOUND_NORMAL: "notifkit:stream:inbound:normal",
  INBOUND_LOW: "notifkit:stream:inbound:low",
  ENRICHED_CRITICAL: "notifkit:stream:enriched:critical",
  ENRICHED_NORMAL: "notifkit:stream:enriched:normal",
  ENRICHED_LOW: "notifkit:stream:enriched:low",
  AI_PENDING: "notifkit:stream:ai:pending",
  SCHEDULED: "notifkit:stream:scheduled",
  OUTBOUND_CRITICAL: "notifkit:stream:outbound:critical",
  OUTBOUND_NORMAL: "notifkit:stream:outbound:normal",
  OUTBOUND_LOW: "notifkit:stream:outbound:low",
  DEAD_LETTER: "notifkit:stream:dlq",
  WORKFLOW_INBOUND: "notifkit:stream:workflow:inbound",
  EVENTS_INBOUND: "notifkit:stream:events:inbound",
} as const;

export const INBOUND_STREAMS = [
  STREAMS.INBOUND_CRITICAL,
  STREAMS.INBOUND_NORMAL,
  STREAMS.INBOUND_LOW,
] as const;

export const ENRICHED_STREAMS = [
  STREAMS.ENRICHED_CRITICAL,
  STREAMS.ENRICHED_NORMAL,
  STREAMS.ENRICHED_LOW,
] as const;

export const OUTBOUND_STREAMS = [
  STREAMS.OUTBOUND_CRITICAL,
  STREAMS.OUTBOUND_NORMAL,
  STREAMS.OUTBOUND_LOW,
] as const;
export type StreamName = (typeof STREAMS)[keyof typeof STREAMS];

/**
 * Redis pub/sub channels used to drop cached state across every process.
 *
 * Each cache also carries a TTL, so these only shorten the window in which a
 * worker can act on stale data — they are not the sole correctness mechanism.
 */
export const PUBSUB_CHANNELS = {
  /** Payload: `{projectId}:{templateId}`. */
  TEMPLATE_INVALIDATED: "template.invalidated",
  /** Payload: `{projectId}`. Published when project settings change. */
  PROJECT_INVALIDATED: "project.invalidated",
  /** Payload: a token hash, or `*` for the whole cache. */
  API_KEY_INVALIDATED: "apikey.invalidated",
} as const;
export type PubSubChannel = (typeof PUBSUB_CHANNELS)[keyof typeof PUBSUB_CHANNELS];

export const CONSUMER_GROUPS = {
  ENRICHER: "notifkit:group:enricher",
  ENGINE: "notifkit:group:engine",
  DELIVERY: "notifkit:group:delivery",
  SCHEDULER: "notifkit:group:scheduler",
  AI: "notifkit:group:ai",
  WORKFLOW: "notifkit:group:workflow",
  EVENTS: "notifkit:group:events",
} as const;
export type ConsumerGroup = (typeof CONSUMER_GROUPS)[keyof typeof CONSUMER_GROUPS];
