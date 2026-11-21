import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { workflow } from "@/workflows/index.js";
import { STREAMS, buildStreamEvent } from "@/contracts/index.js";
import { useInfra, waitFor, settle } from "./support/infra.js";
import { RecordingTransport, startNotifkit, type Running, type Api } from "./support/pipeline.js";

/**
 * Workflows end to end: definitions and triggers go in through the API, steps
 * run in the workflow worker, events come back through the events worker, and
 * the assertions are on what was delivered and on the instance's recorded state.
 */

const infra = useInfra();
let app: Running;
const email = new RecordingTransport("email");

// Code-defined workflows, registered before the server starts.
const runs: Record<string, number> = {};
workflow("onboarding", async ({ step, event }) => {
  await step.notify({ template: "hello", data: { name: event.user.id } });
  const paid = await step.waitForEvent("order.paid", {
    timeout: "1h",
    match: { userId: event.user.id },
  });
  await step.run("record", () => ({ paidAmount: paid?.amount ?? null }));
  await step.notify({ template: "thanks" });
});
workflow("sleepy", async ({ step, event }) => {
  await step.run("count", () => {
    runs[event.tag] = (runs[event.tag] ?? 0) + 1;
    return runs[event.tag];
  });
  await step.wait("2s");
  await step.notify({ template: "hello" });
});
workflow("impatient", async ({ step }) => {
  const got = await step.waitForEvent("never.happens", { timeout: "1s" });
  await step.run("outcome", () => ({ timedOut: got === null }));
});
workflow("waits-an-hour", async ({ step }) => {
  await step.wait("1h");
  await step.notify({ template: "hello" });
});
workflow("broken", async ({ step }) => {
  await step.run("explode", () => {
    throw new Error("handler bug");
  });
});
workflow("await-go", async ({ step }) => {
  const r = await step.waitForEvent("go", { timeout: "1h" });
  await step.run("after", () => ({ got: r }));
});
workflow("quick-nap", async ({ step }) => {
  await step.wait("500ms");
  await step.run("woke", () => true);
});
workflow("fractional-wait", async ({ step }) => {
  await step.wait("1.5h");
});
workflow("fractional-nap", async ({ step }) => {
  await step.wait("0.5s");
  await step.run("woke", () => true);
});
workflow("vague-wait", async ({ step }) => {
  await step.wait("soon");
});
workflow("pays-twice", async ({ step }) => {
  await step.waitForEvent("order.paid", { timeout: "3s" });
  const second = await step.waitForEvent("order.paid", { timeout: "1h" });
  await step.run("after", () => ({ second }));
});

// Holds the handler mid-run until the test lets it go.
const gates = new Map<string, () => void>();
const gateReached = new Set<string>();
workflow("gated", async ({ step, event }) => {
  await step.run("hold", async () => {
    gateReached.add(event.tag);
    await new Promise<void>((resolve) => gates.set(event.tag, resolve));
    return true;
  });
  await step.notify({ template: "hello" });
});

beforeAll(async () => {
  app = await startNotifkit(infra, {
    services: ["api", "enricher", "engine", "delivery", "scheduler", "events", "workflow"],
    providers: [email],
    env: { RATE_LIMIT_PER_HOUR: "100000" },
  });
}, 120_000);

afterAll(async () => {
  await app?.stop();
}, 60_000);

async function project() {
  const p = await app.project();
  await p.api("PUT", "/v1/templates", {
    templates: [
      { id: "hello", channel: "email", content: { subject: "Hello {{name}}" } },
      { id: "thanks", channel: "email", content: { subject: "Thanks" } },
    ],
  });
  for (const id of ["alice", "bob"]) {
    await p.api("POST", "/v1/users", { id, email: `${id}@x.com` });
  }
  return p;
}

async function trigger(api: Api, body: Record<string, unknown>) {
  const res = await api("POST", "/v1/workflows/trigger", body);
  expect(res.status).toBe(202);
  return res.body.instanceId as string;
}

async function instance(api: Api, id: string) {
  const res = await api("GET", `/v1/workflows/instances/${id}`);
  return res.status === 200 ? res.body : null;
}

async function waitForStatus(api: Api, id: string, status: string, timeoutMs = 20_000) {
  await waitFor(
    `instance ${status}`,
    async () => (await instance(api, id))?.status === status,
    timeoutMs,
  );
}

async function sendEvent(api: Api, name: string, properties: Record<string, unknown>) {
  const res = await api("POST", "/v1/events", { name, properties });
  expect(res.status).toBe(202);
}

describe("code-defined workflows", () => {
  it("notifies, sleeps on an event that matches its user, then carries on", async () => {
    const p = await project();
    const id = await trigger(p.api, { name: "onboarding", user: "alice" });

    await waitFor("welcome sent", () => email.for(p.id).length === 1);
    expect(email.for(p.id)[0]!.renderedContent.content).toEqual({ subject: "Hello alice" });
    await waitForStatus(p.api, id, "pending");

    // Someone else's payment must not wake alice's workflow.
    await sendEvent(p.api, "order.paid", { userId: "bob", amount: 1 });
    await settle(1_500);
    expect(email.for(p.id)).toHaveLength(1);

    await sendEvent(p.api, "order.paid", { userId: "alice", amount: 42 });
    await waitForStatus(p.api, id, "completed");
    await waitFor("thanks sent", () => email.for(p.id).length === 2);

    const inst = await instance(p.api, id);
    expect(inst.steps.map((s: any) => s.action)).toEqual([
      "notify",
      "waitForEvent",
      "run",
      "notify",
    ]);
    expect(inst.steps[2].output).toEqual({ paidAmount: 42 });
    expect(inst.waiters).toEqual([]);
  });

  it("records a notify step's ids as the notification that was actually sent", async () => {
    const p = await project();
    const id = await trigger(p.api, { name: "onboarding", user: "alice" });
    await waitFor("sent", () => email.for(p.id).length === 1);
    await waitFor("step recorded", async () => (await instance(p.api, id))?.steps.length >= 1);

    const notifyStep = (await instance(p.api, id)).steps[0];
    const task = email.for(p.id)[0]!;
    // The engine derives task ids from the id of the request event.
    expect(task.taskId.startsWith(`${notifyStep.output.notificationId}:`)).toBe(true);
  });

  it("files a step's delivery under its workflow instance, so the log can be filtered by it", async () => {
    const p = await project();
    const id = await trigger(p.api, { name: "onboarding", user: "alice" });
    await waitFor("sent", () => email.for(p.id).length === 1);

    const byInstance = async () =>
      (await p.api("GET", `/v1/notifications/logs?workflowInstanceId=${id}`)).body.logs as any[];
    await waitFor("logged under the instance", async () => (await byInstance()).length === 1);
    expect((await byInstance())[0]).toMatchObject({
      taskId: email.for(p.id)[0]!.taskId,
      status: "delivered",
    });

    // Another instance's filter must not pick it up.
    const other = (await p.api("GET", `/v1/notifications/logs?workflowInstanceId=${randomUUID()}`))
      .body.logs;
    expect(other).toEqual([]);
  });

  it("wakes after a wait, without re-running completed steps", async () => {
    const p = await project();
    const tag = randomUUID();
    const id = await trigger(p.api, { name: "sleepy", user: "alice", input: { tag } });

    await waitForStatus(p.api, id, "pending");
    expect(email.for(p.id)).toEqual([]);
    await waitForStatus(p.api, id, "completed", 30_000);
    await waitFor("sent after waking", () => email.for(p.id).length === 1);
    expect(runs[tag]).toBe(1);
  }, 40_000);

  it("resumes with null when an awaited event times out", async () => {
    const p = await project();
    const id = await trigger(p.api, { name: "impatient", user: "alice" });
    await waitForStatus(p.api, id, "completed", 30_000);
    const inst = await instance(p.api, id);
    expect(inst.steps.find((s: any) => s.action === "run").output).toEqual({ timedOut: true });
  }, 40_000);

  it("does not cut a wait short when a stray resume arrives", async () => {
    const p = await project();
    const id = await trigger(p.api, { name: "waits-an-hour", user: "alice" });
    await waitForStatus(p.api, id, "pending");

    await infra.redis.xadd(
      STREAMS.WORKFLOW_INBOUND,
      "*",
      "data",
      JSON.stringify({
        ...buildStreamEvent(
          "workflow.resumed",
          {
            projectId: p.id,
            instanceId: id,
            name: "waits-an-hour",
            input: { user: { id: "alice" } },
          },
          "test",
        ),
        id: randomUUID(),
        timestamp: new Date().toISOString(),
      }),
    );
    await settle(2_000);

    expect((await instance(p.api, id)).status).toBe("pending");
    expect(email.for(p.id)).toEqual([]);
  });

  it("marks an instance failed when its handler throws", async () => {
    const p = await project();
    const id = await trigger(p.api, { name: "broken", user: "alice" });
    await waitForStatus(p.api, id, "failed");
  });

  it("does not lose a resume that arrives while the instance is still suspending", async () => {
    const p = await project();
    // The interleaving under test: another process holds the instance (it is
    // mid-way through suspending on waitForEvent) when the events worker has
    // already matched the event, filled the step in, and published the resume.
    const [row] = await infra.sql`
      INSERT INTO workflow_instances (project_id, name, status, input)
      VALUES (${p.id}, 'await-go', 'running', ${JSON.stringify({ user: { id: "alice" } })}::jsonb) RETURNING id`;
    const id = row!.id as string;
    await infra.sql`
      INSERT INTO workflow_steps (project_id, instance_id, step_index, action, output)
      VALUES (${p.id}, ${id}, '0', 'waitForEvent', ${JSON.stringify({ orderId: "o1" })}::jsonb)`;
    await infra.redis.set(`lock:workflow:${id}`, "other-process", "EX", 60);

    await infra.redis.xadd(
      STREAMS.WORKFLOW_INBOUND,
      "*",
      "data",
      JSON.stringify({
        ...buildStreamEvent(
          "workflow.resumed",
          { projectId: p.id, instanceId: id, name: "await-go", input: { user: { id: "alice" } } },
          "events",
        ),
        id: randomUUID(),
        timestamp: new Date().toISOString(),
      }),
    );
    await settle(500);

    // The other process finishes suspending and lets go.
    await infra.sql`UPDATE workflow_instances SET status = 'pending' WHERE id = ${id}`;
    await infra.redis.del(`lock:workflow:${id}`);

    await waitForStatus(p.api, id, "completed", 20_000);
    const inst = await instance(p.api, id);
    expect(inst.steps.find((s: any) => s.action === "run").output).toEqual({
      got: { orderId: "o1" },
    });
  }, 30_000);

  it("can be canceled while it sleeps, and then never resumes", async () => {
    const p = await project();
    const id = await trigger(p.api, {
      name: "sleepy",
      user: "alice",
      input: { tag: randomUUID() },
    });
    await waitForStatus(p.api, id, "pending");

    const res = await p.api("DELETE", `/v1/workflows/instances/${id}`);
    expect(res.status).toBe(204);
    expect((await p.api("DELETE", `/v1/workflows/instances/${id}`)).status).toBe(400);

    await settle(8_000);
    expect((await instance(p.api, id)).status).toBe("canceled");
    expect(email.for(p.id)).toEqual([]);
  }, 20_000);

  it("stays canceled when canceled mid-run, and runs no further steps", async () => {
    const p = await project();
    const tag = randomUUID();
    const id = await trigger(p.api, { name: "gated", user: "alice", input: { tag } });
    await waitFor("handler mid-run", () => gateReached.has(tag));

    expect((await p.api("DELETE", `/v1/workflows/instances/${id}`)).status).toBe(204);
    gates.get(tag)!();

    await settle(3_000);
    expect((await instance(p.api, id)).status).toBe("canceled");
    expect(email.for(p.id)).toEqual([]);
  }, 20_000);

  it("does not let an answered wait's timeout fire on a later wait for the same event", async () => {
    const p = await project();
    const id = await trigger(p.api, { name: "pays-twice", user: "alice" });
    await waitForStatus(p.api, id, "pending");

    // Answer the first wait; the workflow moves on to the second.
    await sendEvent(p.api, "order.paid", { n: 1 });
    await waitFor(
      "suspended on the second wait",
      async () => (await instance(p.api, id))?.steps.length === 2,
    );
    await waitForStatus(p.api, id, "pending");

    // Past the first wait's 3s deadline plus a timer poll.
    await settle(9_000);
    const inst = await instance(p.api, id);
    expect(inst.status).toBe("pending");
    expect(inst.steps[1].output).toBeNull();
    expect(inst.waiters).toHaveLength(1);
  }, 40_000);

  it("keeps a long sleep's wake-up when a resume is deferred for a busy instance", async () => {
    const p = await project();
    const id = await trigger(p.api, { name: "waits-an-hour", user: "alice" });
    await waitForStatus(p.api, id, "pending");

    // A duplicate resume finds the instance locked by another process.
    await infra.redis.set(`lock:workflow:${id}`, "other-process", "EX", 60);
    await infra.redis.xadd(
      STREAMS.WORKFLOW_INBOUND,
      "*",
      "data",
      JSON.stringify({
        ...buildStreamEvent(
          "workflow.resumed",
          {
            projectId: p.id,
            instanceId: id,
            name: "waits-an-hour",
            input: { user: { id: "alice" } },
          },
          "test",
        ),
        id: randomUUID(),
        timestamp: new Date().toISOString(),
      }),
    );
    await settle(1_500);
    await infra.redis.del(`lock:workflow:${id}`);

    const timers = await infra.redis.zrange("notif:workflow:timers", "0", "-1", "WITHSCORES");
    const scores: number[] = [];
    for (let i = 0; i < timers.length; i += 2) {
      if (timers[i]!.includes(id)) scores.push(Number(timers[i + 1]));
    }
    expect(Math.max(...scores)).toBeGreaterThan(Date.now() + 30 * 60_000);
  }, 20_000);

  it("reads a millisecond wait as milliseconds", async () => {
    const p = await project();
    const id = await trigger(p.api, { name: "quick-nap", user: "alice" });
    // One timer poll (5s) is enough; "500ms" once meant 500 seconds.
    await waitForStatus(p.api, id, "completed", 12_000);
  }, 20_000);

  it("reads a fractional duration exactly: 1.5h sleeps 90 minutes, not 1 hour", async () => {
    const p = await project();
    const id = await trigger(p.api, { name: "fractional-wait", user: "alice" });
    // Not waitForStatus("pending"): a new instance is pending before it has run.
    await waitFor("wait step recorded", async () =>
      Boolean((await instance(p.api, id))?.steps.some((s: any) => s.action === "wait")),
    );
    const wait = (await instance(p.api, id)).steps.find((s: any) => s.action === "wait");
    const sleptMs = wait.output.scheduledAt - Date.parse(wait.createdAt);
    expect(Math.abs(sleptMs - 90 * 60_000)).toBeLessThan(60_000);
  });

  it("wakes from a fractional wait in a small unit", async () => {
    const p = await project();
    const id = await trigger(p.api, { name: "fractional-nap", user: "alice" });
    await waitForStatus(p.api, id, "completed", 12_000);
  }, 20_000);

  it("fails a wait whose duration is not a duration at all", async () => {
    const p = await project();
    const id = await trigger(p.api, { name: "vague-wait", user: "alice" });
    await waitForStatus(p.api, id, "failed");
  });

  it("does nothing for a workflow nobody defined", async () => {
    const p = await project();
    const id = await trigger(p.api, { name: "no-such-workflow", user: "alice" });
    await settle(1_000);
    expect(await instance(p.api, id)).toBeNull();
  });

  it("keeps instances private to their project", async () => {
    const p = await project();
    const other = await project();
    const id = await trigger(p.api, { name: "broken", user: "alice" });
    await waitForStatus(p.api, id, "failed");
    expect((await other.api("GET", `/v1/workflows/instances/${id}`)).status).toBe(404);
    expect((await other.api("DELETE", `/v1/workflows/instances/${id}`)).status).toBe(400);
  });
});

describe("JSON-defined workflows", () => {
  it("runs notify, wait and waitForEvent steps defined through the API", async () => {
    const p = await project();
    const created = await p.api("POST", "/v1/workflows", {
      name: "json-flow",
      steps: [
        { action: "notify", payload: { template: "hello", data: { name: "json" } } },
        {
          action: "waitForEvent",
          event: "signup.done",
          options: { timeout: "1h", match: { userId: "alice" } },
        },
        { action: "notify", payload: { template: "thanks", user: "bob" } },
      ],
    });
    expect(created.status).toBe(201);
    expect((await p.api("GET", "/v1/workflows")).body.workflows.map((w: any) => w.name)).toEqual([
      "json-flow",
    ]);

    const id = await trigger(p.api, { name: "json-flow", user: "alice" });
    await waitFor("first notify", () => email.for(p.id).length === 1);
    expect(email.for(p.id)[0]!.recipientId).toBe("alice");
    await waitForStatus(p.api, id, "pending");

    await sendEvent(p.api, "signup.done", { userId: "someone-else" });
    await settle(1_500);
    expect((await instance(p.api, id)).status).toBe("pending");

    await sendEvent(p.api, "signup.done", { userId: "alice" });
    await waitForStatus(p.api, id, "completed");
    await waitFor("second notify, to the step's own target", () => email.for(p.id).length === 2);
    expect(email.for(p.id)[1]!.recipientId).toBe("bob");
  });

  it("redefining a workflow replaces its steps", async () => {
    const p = await project();
    await p.api("POST", "/v1/workflows", {
      name: "v",
      steps: [{ action: "notify", payload: { template: "hello" } }],
    });
    await p.api("POST", "/v1/workflows", {
      name: "v",
      steps: [{ action: "notify", payload: { template: "thanks" } }],
    });
    const id = await trigger(p.api, { name: "v", user: "alice" });
    await waitForStatus(p.api, id, "completed");
    await waitFor("sent", () => email.for(p.id).length === 1);
    expect(email.for(p.id)[0]!.templateId).toBe("thanks");
  });

  it("rejects an invalid definition", async () => {
    const p = await project();
    const res = await p.api("POST", "/v1/workflows", {
      name: "bad",
      steps: [{ action: "teleport" }],
    });
    expect(res.status).toBe(400);
  });
});
