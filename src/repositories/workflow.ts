import { eq, and, inArray, desc } from "drizzle-orm";
import type { Db } from "@/index.js";
import {
  workflowInstances,
  workflowSteps,
  workflowWaiters,
  workflowDefinitions,
} from "@/db/schema.js";

export class WorkflowRepository {
  constructor(private readonly db: Db) {}

  async listDefinitions(projectId: string): Promise<any[]> {
    return this.db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.projectId, projectId))
      .orderBy(desc(workflowDefinitions.createdAt));
  }

  async getInstance(projectId: string, instanceId: string): Promise<any | null> {
    const instances = await this.db
      .select()
      .from(workflowInstances)
      .where(and(eq(workflowInstances.id, instanceId), eq(workflowInstances.projectId, projectId)))
      .limit(1);
    if (!instances[0]) return null;

    const steps = await this.db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.instanceId, instanceId))
      .orderBy(workflowSteps.createdAt);
    const waiters = await this.db
      .select()
      .from(workflowWaiters)
      .where(eq(workflowWaiters.instanceId, instanceId));

    return {
      ...instances[0],
      steps,
      waiters,
    };
  }

  async cancelInstance(projectId: string, instanceId: string): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      const result = await tx
        .update(workflowInstances)
        .set({ status: "canceled" })
        .where(
          and(
            eq(workflowInstances.id, instanceId),
            eq(workflowInstances.projectId, projectId),
            inArray(workflowInstances.status, ["pending", "running"]),
          ),
        )
        .returning();
      if (result.length === 0) return false;
      await tx.delete(workflowWaiters).where(eq(workflowWaiters.instanceId, instanceId));
      return true;
    });
  }
}
