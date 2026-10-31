import type { Logger, RedisClient, StreamProducer } from "@/index.js";
import { buildStreamEvent } from "@/index.js";
import { workflowInstances, workflowSteps, workflowWaiters } from "@/db/schema.js";
import { eq, and } from "drizzle-orm";

/** How long a claimed workflow timer stays invisible to other pollers. */
const WORKFLOW_TIMER_VISIBILITY_MS = 60_000;
/** Wake-ups for sleeping instances: waits, event timeouts, deferred resumes. */
export const WORKFLOW_TIMERS_KEY = "notif:workflow:timers";

export interface WorkflowTimerDeps {
  redis: RedisClient;
  db: any;
  logger: Logger;
  workflowProducer: StreamProducer;
}

/** Resumes instances whose wait, event timeout or deferred resume is due. */
export async function pollWorkflowTimers({
  redis,
  db,
  logger,
  workflowProducer,
}: WorkflowTimerDeps): Promise<void> {
  try {
    const now = Date.now();
    const tasks = await redis.native.schedulerPoll(
      WORKFLOW_TIMERS_KEY,
      now,
      100,
      WORKFLOW_TIMER_VISIBILITY_MS,
    );

    for (const taskStr of tasks) {
      const task = JSON.parse(taskStr);

      // Check if workflow is already completed/failed
      const inst = (
        await db
          .select()
          .from(workflowInstances)
          .where(eq(workflowInstances.id, task.instanceId))
          .limit(1)
      )[0];
      if (
        !inst ||
        inst.status === "completed" ||
        inst.status === "failed" ||
        inst.status === "canceled"
      ) {
        await redis.native.zrem(WORKFLOW_TIMERS_KEY, taskStr);
        continue;
      }
      // A timer can be observed while the worker is still persisting the
      // corresponding suspension. Leave the claimed member in place; its
      // visibility timeout will make it eligible once the instance becomes
      // pending instead of losing the wake-up signal.
      if (inst.status === "running") continue;

      if (task.isEventTimeout) {
        // A timeout for one waitForEvent step. If that step already has an
        // output the event came first and this timer is stale; acting on it
        // would time out a later wait on the same event name.
        if (task.stepId !== undefined) {
          const [own] = await db
            .select({ output: workflowSteps.output })
            .from(workflowSteps)
            .where(
              and(
                eq(workflowSteps.instanceId, task.instanceId),
                eq(workflowSteps.stepIndex, String(task.stepId)),
              ),
            )
            .limit(1);
          if (!own || own.output !== null) {
            await redis.native.zrem(WORKFLOW_TIMERS_KEY, taskStr);
            continue;
          }
        }

        // Clean up only this step's waiter
        const deleted = await db
          .delete(workflowWaiters)
          .where(
            and(
              eq(workflowWaiters.instanceId, task.instanceId),
              eq(workflowWaiters.eventName, task.eventName),
            ),
          )
          .returning();

        // If the waiter was already deleted (by EventWorker when event arrived before timeout),
        // this timer is stale. Clean up from Redis and skip re-resuming the workflow.
        if (deleted.length === 0) {
          await redis.native.zrem(WORKFLOW_TIMERS_KEY, taskStr);
          continue;
        }

        // Record timedOut state on the pending waitForEvent step
        const steps = await db
          .select()
          .from(workflowSteps)
          .where(
            and(
              eq(workflowSteps.instanceId, task.instanceId),
              eq(workflowSteps.action, "waitForEvent"),
            ),
          );
        const pendingStep =
          task.stepId !== undefined
            ? steps.find((s: any) => s.stepIndex === String(task.stepId) && s.output === null)
            : steps.find((s: any) => s.output === null);
        if (pendingStep) {
          await db
            .update(workflowSteps)
            .set({ output: { timedOut: true } })
            .where(eq(workflowSteps.id, pendingStep.id));
        }
      }

      await workflowProducer.publish(
        buildStreamEvent("workflow.resumed", task, "scheduler", undefined),
      );
      await redis.native.zrem(WORKFLOW_TIMERS_KEY, taskStr);
      logger.info({ instanceId: task.instanceId }, "Workflow resumed from timer");
    }
  } catch (err) {
    logger.error({ err }, "error in workflow polling loop");
  }
}

/** Sets `running` instances whose lock has expired back to `pending`. */
export async function reapStuckInstances({
  redis,
  db,
  logger,
}: Omit<WorkflowTimerDeps, "workflowProducer">): Promise<void> {
  try {
    const runningInstances = await db
      .select({ id: workflowInstances.id })
      .from(workflowInstances)
      .where(eq(workflowInstances.status, "running"));
    for (const inst of runningInstances) {
      const lockKey = `lock:workflow:${inst.id}`;
      const hasLock = await redis.native.exists(lockKey);
      if (!hasLock) {
        await db
          .update(workflowInstances)
          .set({ status: "pending" })
          .where(eq(workflowInstances.id, inst.id));
        logger.info({ instanceId: inst.id }, "Reaped stuck workflow instance (lock expired)");
      }
    }
  } catch (err) {
    logger.error({ err }, "error in stuck workflow reaper");
  }
}
