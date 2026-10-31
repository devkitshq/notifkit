import { eq, and, desc } from "drizzle-orm";
import type { Db } from "@/index.js";
import {
  users,
  projects,
  workflowInstances,
  workflowDefinitions,
  projectApiKeys,
  suppressions,
  messageLogs,
} from "@/db/schema.js";

export class ProjectRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<any[]> {
    return this.db
      .select({
        id: projects.id,
        name: projects.name,
        rateLimitRpm: projects.rateLimitRpm,
        throttleLimit: projects.throttleLimit,
        throttleWindowHours: projects.throttleWindowHours,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .orderBy(desc(projects.createdAt));
  }

  async delete(id: string): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      // Contacts, segments, preferences and quiet hours cascade on users.id.
      await tx.delete(users).where(eq(users.projectId, id));
      await tx.delete(suppressions).where(eq(suppressions.projectId, id));
      await tx.delete(messageLogs).where(eq(messageLogs.projectId, id));
      await tx.delete(workflowInstances).where(eq(workflowInstances.projectId, id));
      await tx.delete(workflowDefinitions).where(eq(workflowDefinitions.projectId, id));

      const result = await tx.delete(projects).where(eq(projects.id, id)).returning();
      return result.length > 0;
    });
  }

  /**
   * Throttle overrides only. Kept narrow because the engine calls this once per
   * notification (behind a cache) and has no use for the rest of the row.
   */
  async findThrottleSettings(
    id: string,
  ): Promise<{ throttleLimit: number | null; throttleWindowHours: number | null } | null> {
    const rows = await this.db
      .select({
        throttleLimit: projects.throttleLimit,
        throttleWindowHours: projects.throttleWindowHours,
      })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);

    return rows[0] ?? null;
  }

  async updateSettings(
    id: string,
    settings: {
      rateLimitRpm?: number | null;
      throttleLimit?: number | null;
      throttleWindowHours?: number | null;
    },
  ): Promise<boolean> {
    const result = await this.db
      .update(projects)
      .set(settings)
      .where(eq(projects.id, id))
      .returning();
    return result.length > 0;
  }

  async createApiKey(
    projectId: string,
    keyHash: string,
    role: "admin" | "read_only" = "admin",
  ): Promise<{ id: string }> {
    const result = await this.db
      .insert(projectApiKeys)
      .values({ projectId, keyHash, role })
      .returning();
    return { id: result[0]!.id };
  }

  async listApiKeys(projectId: string): Promise<any[]> {
    return this.db
      .select({
        id: projectApiKeys.id,
        role: projectApiKeys.role,
        createdAt: projectApiKeys.createdAt,
      })
      .from(projectApiKeys)
      .where(eq(projectApiKeys.projectId, projectId))
      .orderBy(desc(projectApiKeys.createdAt));
  }

  async deleteApiKey(projectId: string, keyId: string): Promise<boolean> {
    const result = await this.db
      .delete(projectApiKeys)
      .where(and(eq(projectApiKeys.id, keyId), eq(projectApiKeys.projectId, projectId)))
      .returning();
    return result.length > 0;
  }
}
