import { createTemplatesHandlers } from "./handlers/templates.js";
import { createUsersHandlers } from "./handlers/users.js";
import { createNotificationsHandlers } from "./handlers/notifications.js";
import { createWorkflowsHandlers } from "./handlers/workflows.js";
import { createEventsHandlers } from "./handlers/events.js";
import { createProjectsHandlers } from "./handlers/projects.js";
import { createSystemHandlers } from "./handlers/system.js";
import { createUnsubscribeHandlers } from "./handlers/unsubscribe.js";
import { createCampaignsHandlers } from "./handlers/campaigns.js";
import { createSuppressionsHandlers } from "./handlers/suppressions.js";
import { createAuthHandlers } from "./handlers/auth.js";
import type { Deps } from "./handlers/shared.js";

export type { Deps };

export function createHandlers(deps: Deps) {
  return {
    ...createTemplatesHandlers(deps),
    ...createUsersHandlers(deps),
    ...createNotificationsHandlers(deps),
    ...createWorkflowsHandlers(deps),
    ...createEventsHandlers(deps),
    ...createProjectsHandlers(deps),
    ...createSystemHandlers(deps),
    ...createUnsubscribeHandlers(deps),
    ...createCampaignsHandlers(deps),
    ...createSuppressionsHandlers(deps),
    ...createAuthHandlers(deps),
  };
}
