// Core building blocks
export * from "./common.js";
export * from "./metadata.js";
export * from "./registry.js";
export * from "./envelope.js";
export * from "./streams.js";
export * from "./helpers.js";
export * from "./sdk.js";

// Event payload schemas and types
export * from "./events/notification-requested.js";
export * from "./events/notification-created.js";
export * from "./events/notification-enriched.js";
export * from "./events/notification-scheduled.js";
export * from "./events/notification-dispatched.js";
export * from "./events/notification-delivered.js";
export * from "./events/notification-failed.js";
export * from "./events/notification-skipped.js";
export * from "./events/notification-canceled.js";
export * from "./events/notification-ai-pending.js";

// Register all built-in event schemas in the global registry.
// This runs once at module load time; call registry.define() in your own
// module to add new event types without modifying this file.
import { registry } from "./registry.js";
import { NotificationRequestedPayloadSchema } from "./events/notification-requested.js";
import { NotificationCreatedPayloadSchema } from "./events/notification-created.js";
import { NotificationEnrichedPayloadSchema } from "./events/notification-enriched.js";
import { NotificationScheduledPayloadSchema } from "./events/notification-scheduled.js";
import { NotificationDispatchedPayloadSchema } from "./events/notification-dispatched.js";
import { NotificationDeliveredPayloadSchema } from "./events/notification-delivered.js";
import { NotificationFailedPayloadSchema } from "./events/notification-failed.js";
import { NotificationSkippedPayloadSchema } from "./events/notification-skipped.js";
import { NotificationCanceledPayloadSchema } from "./events/notification-canceled.js";
import { NotificationAiPendingPayloadSchema } from "./events/notification-ai-pending.js";

registry.define("notification.requested", NotificationRequestedPayloadSchema);
registry.define("notification.created", NotificationCreatedPayloadSchema);
registry.define("notification.enriched", NotificationEnrichedPayloadSchema);
registry.define("notification.scheduled", NotificationScheduledPayloadSchema);
registry.define("notification.dispatched", NotificationDispatchedPayloadSchema);
registry.define("notification.delivered", NotificationDeliveredPayloadSchema);
registry.define("notification.failed", NotificationFailedPayloadSchema);
registry.define("notification.skipped", NotificationSkippedPayloadSchema);
registry.define("notification.canceled", NotificationCanceledPayloadSchema);
registry.define("notification.ai_pending", NotificationAiPendingPayloadSchema);
