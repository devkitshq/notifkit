import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError } from "ai";
import { STREAMS } from "@/contracts/index.js";
import { setAiConfig } from "@/config/index.js";
import { useInfra, waitFor, settle } from "./support/infra.js";
import { RecordingTransport, startNotifkit, type Running, type Api } from "./support/pipeline.js";

/**
 * AI-generated content, end to end. The language model is the one stand-in:
 * it is an external paid API, so a local model records every prompt it is
 * sent and answers deterministically. Everything else — engine, AI worker,
 * delivery, Redis, Postgres — is real.
 */

const infra = useInfra();
let app: Running;
const email = new RecordingTransport("email");

const prompts: string[] = [];
let failNext: Error | null = null;

const model = new MockLanguageModelV4({
  doGenerate: async (opts: any) => {
    const prompt = opts.prompt.flatMap((m: any) => m.content.map((c: any) => c.text)).join("");
    prompts.push(prompt);
    if (failNext) {
      const err = failNext;
      failNext = null;
      throw err;
    }
    return {
      content: [{ type: "text", text: `AI(${prompt})` }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    } as any;
  },
});

beforeAll(async () => {
  app = await startNotifkit(infra, {
    services: ["api", "enricher", "engine", "ai", "scheduler", "delivery", "events"],
    providers: [email],
    aiModel: model as any,
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
      { id: "digest", channel: "email", content: { subject: "Digest", text: "{{summary}}" } },
      {
        id: "smart",
        channel: "email",
        content: { subject: "{{headline}}" },
        aiPrompts: { headline: "Write a headline about {{topic}}" },
      },
    ],
  });
  return p;
}

async function notify(api: Api, body: Record<string, unknown>) {
  const res = await api("POST", "/v1/notify", body);
  expect(res.status).toBe(202);
}

describe("AI-generated notifications", () => {
  it("generates each prompt with the request's data and sends the result", async () => {
    const p = await project();
    await p.api("POST", "/v1/users", { id: "u", email: "u@x.com" });
    const marker = randomUUID().slice(0, 8);

    await notify(p.api, {
      user: "u",
      template: "digest",
      data: { name: marker },
      aiPrompts: { summary: "Summarise the week for {{name}}" },
    });

    await waitFor("delivered", () => email.for(p.id).length === 1);
    expect(prompts).toContain(`Summarise the week for ${marker}`);
    expect(email.for(p.id)[0]!.renderedContent.content).toEqual({
      subject: "Digest",
      text: `AI(Summarise the week for ${marker})`,
    });
    expect(email.for(p.id)[0]!.destination).toBe("u@x.com");
  });

  it("uses the template's own prompts", async () => {
    const p = await project();
    await p.api("POST", "/v1/users", { id: "u", email: "u@x.com" });
    const topic = randomUUID().slice(0, 8);
    await notify(p.api, { user: "u", template: "smart", data: { topic } });
    await waitFor("delivered", () => email.for(p.id).length === 1);
    expect(email.for(p.id)[0]!.renderedContent.content).toEqual({
      subject: `AI(Write a headline about ${topic})`,
    });
  });

  it("generates once per address, sending each address its own copy", async () => {
    const p = await project();
    await p.api("POST", "/v1/users", { id: "u", email: ["a@x.com", "b@x.com"] });
    await notify(p.api, { user: "u", template: "digest", aiPrompts: { summary: "hi" } });
    await waitFor("both delivered", () => email.for(p.id).length === 2);
    expect(
      email
        .for(p.id)
        .map((t) => t.destination)
        .sort(),
    ).toEqual(["a@x.com", "b@x.com"]);
  });

  it("never sends AI mail to a suppressed address", async () => {
    const p = await project();
    await p.api("POST", "/v1/suppressions", { channel: "email", target: "gone@x.com" });
    await p.api("POST", "/v1/users", { id: "u", email: "gone@x.com" });
    await p.api("POST", "/v1/users", { id: "control", email: "control@x.com" });

    await notify(p.api, { user: "u", template: "digest", aiPrompts: { summary: "hi" } });
    await notify(p.api, { user: "control", template: "digest", aiPrompts: { summary: "hi" } });

    await waitFor("control delivered", () => email.for(p.id).length === 1);
    await settle(1_000);
    expect(email.for(p.id).map((t) => t.destination)).toEqual(["control@x.com"]);
  });

  it("sends once when an AI task is replayed after a crash lost its completion marker", async () => {
    const p = await project();
    await p.api("POST", "/v1/users", { id: "u", email: "u@x.com" });
    // Entries are deleted once acked, so capture the AI task as it is written.
    const written: string[] = [];
    const monitor = await infra.redis.monitor();
    monitor.on("monitor", (_time: string, args: string[]) => {
      if (args[0]?.toLowerCase() === "xadd" && args[1] === STREAMS.AI_PENDING)
        written.push(args.at(-1)!);
    });
    try {
      await notify(p.api, { user: "u", template: "digest", aiPrompts: { summary: "once" } });
      await waitFor("delivered", () => email.for(p.id).length === 1);
    } finally {
      monitor.disconnect();
    }

    // A crash between dispatching and recording completion: the marker never
    // landed, and the pending entry is replayed.
    const entry = written.find((data) => data.includes(p.id));
    for (const key of await infra.redis.keys("notif:processed:ai:*")) await infra.redis.del(key);
    await infra.redis.xadd(STREAMS.AI_PENDING, "*", "data", entry!);

    await settle(3_000);
    expect(email.for(p.id)).toHaveLength(1);
  });

  it("fails a notification once, without retrying, when the model rejects the request", async () => {
    const p = await project();
    await p.api("POST", "/v1/users", { id: "u", email: "u@x.com" });
    const failures: unknown[][] = [];
    const on = (...a: unknown[]) => failures.push(a);
    app.server.on("notification:failed", on);
    try {
      const marker = `reject-${randomUUID().slice(0, 8)}`;
      failNext = new APICallError({
        message: "invalid prompt",
        url: "https://model",
        requestBodyValues: {},
        statusCode: 400,
      });
      await notify(p.api, { user: "u", template: "digest", aiPrompts: { summary: marker } });

      await waitFor("failure reported", () => failures.length > 0);
      await settle(1_000);
      expect(prompts.filter((pr) => pr === marker)).toHaveLength(1);
      expect(email.for(p.id)).toEqual([]);
    } finally {
      app.server.off("notification:failed", on);
    }
  });

  it("fails a notification instead of sending its prompt when no model is set", async () => {
    const p = await project();
    await p.api("POST", "/v1/users", { id: "u", email: "u@x.com" });
    const failures: unknown[][] = [];
    const on = (...a: unknown[]) => failures.push(a);
    app.server.on("notification:failed", on);
    setAiConfig({});
    try {
      await notify(p.api, { user: "u", template: "digest", aiPrompts: { summary: "secret" } });

      await waitFor("failure reported", () => failures.length > 0);
      await settle(1_000);
      expect(email.for(p.id)).toEqual([]);
    } finally {
      setAiConfig({ aiModel: model as any });
      app.server.off("notification:failed", on);
    }
  });

  it("caps the number of prompts run for one notification", async () => {
    const p = await project();
    await p.api("POST", "/v1/users", { id: "u", email: "u@x.com" });
    const tag = randomUUID().slice(0, 8);
    const aiPrompts = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`k${i}`, `${tag}-${i}`]),
    );
    await notify(p.api, { user: "u", template: "digest", aiPrompts });
    await waitFor("delivered", () => email.for(p.id).length === 1);
    expect(prompts.filter((pr) => pr.startsWith(tag))).toHaveLength(5);
  });

  it("holds a scheduled AI notification until its time", async () => {
    const p = await project();
    await p.api("POST", "/v1/users", { id: "u", email: "u@x.com" });
    await notify(p.api, {
      user: "u",
      template: "digest",
      aiPrompts: { summary: "later" },
      sendAt: new Date(Date.now() + 3_000).toISOString(),
    });
    await waitFor(
      "parked",
      async () => (await p.api("GET", "/v1/notifications/scheduled")).body.scheduled?.length === 1,
    );
    expect(email.for(p.id)).toEqual([]);
    await waitFor("sent", () => email.for(p.id).length === 1, 20_000);
  }, 30_000);
});
