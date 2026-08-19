import type { WorkflowContext } from "./sdk.js";

type WorkflowHandler = (ctx: WorkflowContext) => Promise<void>;

class WorkflowRegistry {
  private workflows = new Map<string, WorkflowHandler>();

  register(name: string, handler: WorkflowHandler) {
    this.workflows.set(name, handler);
  }

  get(name: string): WorkflowHandler | undefined {
    return this.workflows.get(name);
  }
}

export const workflowRegistry = new WorkflowRegistry();

export function workflow(name: string, handler: WorkflowHandler) {
  workflowRegistry.register(name, handler);
}
