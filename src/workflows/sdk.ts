import type { WorkflowNotifyInput } from "@/contracts/sdk.js";
import type {
  NotificationRequestedPayload,
  NotificationTarget,
} from "@/contracts/events/notification-requested.js";

export class SuspendExecutionError extends Error {
  constructor(
    public reason: "wait" | "waitForEvent",
    public payload: any,
  ) {
    super(`Execution suspended for ${reason}`);
    this.name = "SuspendExecutionError";
  }
}

export interface WorkflowEvent {
  user: { id: string };
  [key: string]: any;
}

export interface WorkflowContext {
  step: WorkflowStepContext;
  event: WorkflowEvent;
}

/** What a completed `step.notify()` records and returns. */
export interface WorkflowNotifyResult {
  success: boolean;
  messageId: string;
  notificationId: string;
}

export interface WorkflowStepContext {
  notify(payload: WorkflowNotifyInput): Promise<WorkflowNotifyResult>;
  wait(duration: string): Promise<void>;
  waitForEvent(
    eventName: string,
    options?: { timeout?: string; match?: Record<string, any> },
  ): Promise<any | null>;
  run<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
}

/**
 * Works out who a `step.notify()` call is for.
 *
 * A target named in the step payload wins. Only when the step names none does
 * the notification fall back to the instance's own user — the common case, and
 * the reason most steps carry no target at all.
 */
export function resolveStepTarget(
  args: WorkflowNotifyInput,
  instanceInput: unknown,
): NotificationTarget {
  if (args.segment !== undefined) return { type: "segment", segment: args.segment };
  if (args.topic !== undefined) return { type: "topic", topic: args.topic };

  if (args.user !== undefined) {
    if (Array.isArray(args.user)) {
      throw new Error(
        "step.notify() takes a single `user`. To reach several people from one workflow, " +
          "use one notify step each, or target a `segment`.",
      );
    }
    return {
      type: "user",
      userId: typeof args.user === "string" ? args.user : args.user.id,
    };
  }

  const inherited = (instanceInput as { user?: { id?: string } } | null)?.user?.id;
  if (!inherited) {
    throw new Error(
      "step.notify() has no target: the step payload names no `user`, `segment` or `topic`, " +
        "and the workflow instance was triggered without `input.user.id`.",
    );
  }
  return { type: "user", userId: inherited };
}

/**
 * Maps a `step.notify()` payload onto the wire event the pipeline consumes.
 *
 * The field names differ either side of the boundary — `template` becomes
 * `templateId`, `sendAt` becomes `scheduledAt` — so this translation is
 * deliberate rather than a spread, and the return type keeps it honest.
 */
export function buildStepNotifyPayload(
  args: WorkflowNotifyInput,
  instanceInput: unknown,
  projectId: string,
  idempotencyKey?: string,
): NotificationRequestedPayload {
  return {
    projectId,
    target: resolveStepTarget(args, instanceInput),
    templateId: args.template,
    priority: args.priority ?? "normal",
    channels: args.channels,
    data: args.data ?? {},
    aiPrompts: args.aiPrompts,
    fallback: args.fallback ?? false,
    scheduledAt: args.sendAt,
    idempotencyKey,
  };
}
