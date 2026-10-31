import { eq, and } from "drizzle-orm";
import type { Db } from "@/index.js";
import { users, userTopicPreferences } from "@/db/schema.js";
import type { NotificationPreference } from "./types.js";

/** @deprecated Unused; removed in the next minor version. */
export class PreferenceRepository {
  constructor(private readonly db: Db) {}

  async isOptedIn(projectId: string, userId: string, eventType: string): Promise<boolean> {
    const prefs = await this.findByUserId(projectId, userId);
    const pref = prefs.find((p) => p.eventType === eventType);
    return pref ? pref.optedIn : true;
  }

  async findByUserId(projectId: string, userId: string): Promise<NotificationPreference[]> {
    const internalUserIdRows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.externalId, userId), eq(users.projectId, projectId)));
    const internalId = internalUserIdRows[0]?.id;
    if (!internalId) return [];

    const rows = await this.db
      .select()
      .from(userTopicPreferences)
      .where(eq(userTopicPreferences.userId, internalId));

    return rows.map((r) => ({
      userId,
      eventType: r.topic,
      optedIn: r.enabled,
    }));
  }
}
