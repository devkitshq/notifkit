import { describe, it, expect, vi } from "vitest";

// Records the order NotifkitServer.stop() stops its services in.
const { stopped } = vi.hoisted(() => ({ stopped: [] as string[] }));

function service(name: string, cap: string) {
  return {
    [`start${cap}`]: vi.fn().mockResolvedValue(undefined),
    [`stop${cap}`]: vi.fn(async () => {
      stopped.push(name);
    }),
    [`get${cap}`]: vi.fn(() => undefined),
  };
}

vi.mock("../src/services/api/main.js", () => service("api", "ApiServer"));
vi.mock("../src/services/enricher/main.js", () => service("enricher", "EnricherWorker"));
vi.mock("../src/services/engine/main.js", () => service("engine", "EngineWorker"));
vi.mock("../src/services/delivery/main.js", () => service("delivery", "DeliveryWorker"));
vi.mock("../src/services/scheduler/main.js", () => service("scheduler", "SchedulerWorker"));
vi.mock("../src/services/ai/main.js", () => service("ai", "AiWorker"));
vi.mock("../src/services/workflow/main.js", () => service("workflow", "WorkflowWorker"));
vi.mock("../src/services/events/main.js", () => service("events", "EventWorker"));

import { NotifkitServer } from "@/server.js";

describe("NotifkitServer.stop", () => {
  it("stops services upstream first, so nothing in flight reaches a stage already shut", async () => {
    const server = new NotifkitServer({
      services: ["all"],
      redisUrl: "redis://127.0.0.1:1",
      databaseUrl: "postgres://x@127.0.0.1:1/x",
      autoMigrate: false,
      logLevel: "silent",
    });
    await server.start();
    await server.stop();

    const before = (a: string, b: string) => stopped.indexOf(a) < stopped.indexOf(b);
    expect(stopped).toHaveLength(8);
    expect(stopped[0]).toBe("api");
    // A fused pipeline runs enricher → engine → delivery inside the enricher's
    // task, so delivery's database must outlive the enricher.
    expect(before("enricher", "engine")).toBe(true);
    expect(before("engine", "delivery")).toBe(true);
    // Workflow steps publish into the enricher's stream; AI and the scheduler
    // hand work to delivery.
    expect(before("workflow", "enricher")).toBe(true);
    expect(before("ai", "delivery")).toBe(true);
    expect(before("scheduler", "delivery")).toBe(true);
    // Events records what delivery did, so it goes last.
    expect(stopped.at(-1)).toBe("events");
  });

  it("closes providers after delivery stops, so a pooled connection can't keep the process up", async () => {
    stopped.length = 0;
    const provider = {
      channel: "email" as const,
      send: vi.fn(),
      close: vi.fn(async () => {
        stopped.push("provider");
      }),
    };
    const server = new NotifkitServer({
      services: ["delivery"],
      redisUrl: "redis://127.0.0.1:1",
      databaseUrl: "postgres://x@127.0.0.1:1/x",
      autoMigrate: false,
      logLevel: "silent",
      providers: [provider, { channel: "sms", send: vi.fn() }],
    });
    await server.start();
    await server.stop();

    expect(provider.close).toHaveBeenCalledOnce();
    expect(stopped).toEqual(["delivery", "provider"]);
  });
});
