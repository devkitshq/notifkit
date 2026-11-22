export * from "./types.js";
export * from "./user.js";
export * from "./preference.js";
export * from "./contact.js";
export * from "./template.js";
export * from "./project.js";
export * from "./workflow.js";
export * from "./segment.js";
export * from "./admin-user.js";

/** Applies a `users.invalidated` message to the caches of these repositories. */
export function dropCachedUsers(
  message: string,
  repos: { invalidate(projectId: string, userId: string): void }[],
): void {
  try {
    const { projectId, userIds } = JSON.parse(message) as { projectId: string; userIds: string[] };
    for (const userId of userIds) for (const repo of repos) repo.invalidate(projectId, userId);
  } catch {
    // Only notifkit publishes here; a malformed message has nothing to drop.
  }
}
