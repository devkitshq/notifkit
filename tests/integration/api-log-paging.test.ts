import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NotifkitClient } from "@/client.js";
import { useInfra } from "./support/infra.js";
import { startNotifkit, type Running } from "./support/pipeline.js";

const infra = useInfra();
let app: Running;

beforeAll(async () => {
  app = await startNotifkit(infra, { services: ["api"] });
}, 120_000);

afterAll(async () => {
  await app?.stop();
}, 60_000);

describe("GET /v1/notifications/logs paging", () => {
  it("lists every task exactly once when tasks share a timestamp", async () => {
    const p = await app.project();
    const client = new NotifkitClient({ baseUrl: app.baseUrl, apiKey: p.apiKey });
    // One batch insert gives every row the same now(), which a timestamp-only cursor cannot split.
    await infra.sql`
      INSERT INTO message_logs (project_id, task_id, channel, attempt, status)
      VALUES (${p.id}, 'task-a', 'email', 1, 'delivered'),
             (${p.id}, 'task-b', 'email', 1, 'delivered'),
             (${p.id}, 'task-c', 'email', 1, 'delivered')`;

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await client.getNotificationLogs({ limit: 1, cursor });
      seen.push(...res.logs.map((l) => l.taskId));
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }

    expect(seen.sort()).toEqual(["task-a", "task-b", "task-c"]);
  });
});
