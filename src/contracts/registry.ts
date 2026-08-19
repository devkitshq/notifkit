import { z, type ZodTypeAny, type ZodError } from "zod";
import type { NotificationRequestedPayload } from "./events/notification-requested.js";
import type { NotificationCreatedPayload } from "./events/notification-created.js";
import type { NotificationEnrichedPayload } from "./events/notification-enriched.js";
import type { NotificationScheduledPayload } from "./events/notification-scheduled.js";
import type { NotificationDispatchedPayload } from "./events/notification-dispatched.js";
import type { NotificationDeliveredPayload } from "./events/notification-delivered.js";
import type { NotificationFailedPayload } from "./events/notification-failed.js";
import type { NotificationSkippedPayload } from "./events/notification-skipped.js";
import type { NotificationCanceledPayload } from "./events/notification-canceled.js";
import type { NotificationAiPendingPayload } from "./events/notification-ai-pending.js";
/**
 * Built-in event payload types.
 * External packages extend this interface via declaration merging:
 *
 *   declare module "../index.js" {
 *     interface EventPayloadMap {
 *       "my.custom.event": { field: string };
 *     }
 *   }
 *
 * Then call registry.define("my.custom.event", MySchema) at app startup.
 */
export interface EventPayloadMap {
  "notification.requested": NotificationRequestedPayload;
  "notification.created": NotificationCreatedPayload;
  "notification.enriched": NotificationEnrichedPayload;
  "notification.scheduled": NotificationScheduledPayload;
  "notification.dispatched": NotificationDispatchedPayload;
  "notification.delivered": NotificationDeliveredPayload;
  "notification.failed": NotificationFailedPayload;
  "notification.skipped": NotificationSkippedPayload;
  "notification.canceled": NotificationCanceledPayload;
  "notification.ai_pending": NotificationAiPendingPayload;
}

export type KnownEventType = keyof EventPayloadMap & string;

export type ParseResult<T> = { success: true; data: T } | { success: false; error: ZodError };

export class EventRegistry {
  private readonly schemas = new Map<string, ZodTypeAny>();

  define(type: string, schema: ZodTypeAny): void {
    if (this.schemas.has(type)) {
      throw new Error(`Event type "${type}" is already registered`);
    }
    this.schemas.set(type, schema);
  }

  getSchema(type: string): ZodTypeAny | undefined {
    return this.schemas.get(type);
  }

  has(type: string): boolean {
    return this.schemas.has(type);
  }

  types(): string[] {
    return [...this.schemas.keys()];
  }

  parsePayload<K extends KnownEventType>(type: K, payload: unknown): EventPayloadMap[K] {
    const schema = this.schemas.get(type);
    if (!schema) throw new Error(`Unknown event type: "${type}"`);
    return schema.parse(payload) as EventPayloadMap[K];
  }

  safeParsePayload<K extends KnownEventType>(
    type: K,
    payload: unknown,
  ): ParseResult<EventPayloadMap[K]> {
    const schema = this.schemas.get(type);
    if (!schema) {
      return {
        success: false,
        error: new z.ZodError([
          { code: "custom", message: `Unknown event type: "${type}"`, path: [] },
        ]),
      };
    }
    const result = schema.safeParse(payload);
    if (result.success) return { success: true, data: result.data as EventPayloadMap[K] };
    return { success: false, error: result.error };
  }
}

export const registry = new EventRegistry();
