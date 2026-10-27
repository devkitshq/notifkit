import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { Redis } from "ioredis";
import { publishDeliveryEvents } from "@/services/delivery/live-events.js";
import { useInfra, waitFor, settle } from "./support/infra.js";
import { startNotifkit, type Running } from "./support/pipeline.js";

/**
 * GET /v1/events/stream when delivery runs in another process, as it does in
 * any deployment that scales the workers apart from the API. Here the server
 * runs the API alone, and the delivery side is an emitter of its own bridged
 * over Redis, which is all another process shares with it.
 */

const infra = useInfra();
let app: Running;
let deliveryRedis: Redis;
const deliveryEmitter = new EventEmitter();
let stopPublishing: () => void;

beforeAll(async () => {
  app = await startNotifkit(infra, { services: ["api"] });
  deliveryRedis = new Redis(infra.redisUrl, { maxRetriesPerRequest: null });
  stopPublishing = publishDeliveryEvents(deliveryRedis, deliveryEmitter);
}, 120_000);

afterAll(async () => {
  stopPublishing?.();
  deliveryRedis?.disconnect();
  await app?.stop();
}, 60_000);

/** Opens the stream for `apiKey`, collecting what arrives until `close()`. */
async function openStream(apiKey: string) {
  const controller = new AbortController();
  const res = await fetch(`${app.baseUrl}/v1/events/stream`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: controller.signal,
  });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const reader = res.body!.getReader();
  const stream = { text: "" };
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      stream.text += new TextDecoder().decode(value);
    }
  })().catch(() => {});
  return Object.assign(stream, {
    async close() {
      controller.abort();
      await reading;
    },
  });
}

/** Emits deliveries from the "other process" until one shows up in `stream`. */
async function deliverUntilSeen(stream: { text: string }, projectId: string, taskId: string) {
  await waitFor("delivery streamed", () => {
    deliveryEmitter.emit("delivery:delivered", taskId, "prov-1", "email", projectId);
    return stream.text.includes(taskId);
  });
}

describe("live delivery events from another process", () => {
  it("streams a delivery made by a worker outside the API process", async () => {
    const p = await app.project();
    const stream = await openStream(p.apiKey);
    await deliverUntilSeen(stream, p.id, "remote-task");
    await stream.close();
    expect(stream.text).toContain("event: delivery:delivered");
    expect(stream.text).toContain('"providerMessageId":"prov-1"');
  });

  it("streams the first delivery after a stream opens, even after a spell with nobody watching", async () => {
    const p = await app.project();
    // Delivered while no stream is open: nobody receives it, and the delivery
    // side goes quiet to stop paying for publishes no one hears.
    deliveryEmitter.emit("delivery:delivered", "unwatched", "prov-1", "email", p.id);
    await settle(200);

    const stream = await openStream(p.apiKey);
    await settle(200);
    deliveryEmitter.emit("delivery:delivered", "first-watched", "prov-1", "email", p.id);
    await waitFor("first delivery streamed", () => stream.text.includes("first-watched"), 3_000);
    await stream.close();
  });

  it("streams failures too", async () => {
    const p = await app.project();
    const stream = await openStream(p.apiKey);
    await deliverUntilSeen(stream, p.id, "warm-up");
    deliveryEmitter.emit("delivery:failed", "remote-fail", "boom", "sms", p.id);
    await waitFor("failure streamed", () => stream.text.includes("remote-fail"));
    await stream.close();
    expect(stream.text).toContain("event: delivery:failed");
    expect(stream.text).toContain('"error":"boom"');
  });

  it("sends nothing to anyone for an event that names no project", async () => {
    const p = await app.project();
    const stream = await openStream(p.apiKey);
    await deliverUntilSeen(stream, p.id, "warm-up");
    deliveryEmitter.emit("delivery:delivered", "unscoped-task", "prov-1", "email", undefined);
    deliveryEmitter.emit("delivery:failed", "unscoped-fail", "boom", "email", "");
    await deliverUntilSeen(stream, p.id, "after-unscoped");
    await settle(200);
    await stream.close();
    expect(stream.text).not.toContain("unscoped-task");
    expect(stream.text).not.toContain("unscoped-fail");
  });

  it("keeps another project's deliveries out of the stream", async () => {
    const p = await app.project();
    const other = await app.project();
    const stream = await openStream(p.apiKey);
    await deliverUntilSeen(stream, p.id, "warm-up");
    deliveryEmitter.emit("delivery:delivered", "their-task", "prov-1", "email", other.id);
    await deliverUntilSeen(stream, p.id, "after-theirs");
    await stream.close();
    expect(stream.text).not.toContain("their-task");
  });
});
