import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { globalEmitter } from "@/shared/index.js";
import { useInfra, waitFor } from "./support/infra.js";
import { RecordingTransport, startNotifkit, type Running } from "./support/pipeline.js";
import type { DeliveryResult } from "@/transport/index.js";

/**
 * A burst bigger than a provider's send rate, end to end (issue #36). Every
 * message must arrive, at about the provider's pace, whether notifkit holds
 * the burst back itself or the provider pushes back.
 */

const infra = useInfra();
let app: Running;

const BURST = 60;
const RATE = 10; // per second

/** Accepts RATE sends in any second and reports the rest as throttled, like SES. */
function rateLimitedProvider(): (task: unknown) => DeliveryResult {
  const accepted: number[] = [];
  return () => {
    const now = Date.now();
    while (accepted.length && accepted[0]! <= now - 1_000) accepted.shift();
    if (accepted.length >= RATE) {
      return {
        success: false,
        throttled: true,
        error: "ThrottlingException: Maximum sending rate exceeded.",
      };
    }
    accepted.push(now);
    return { success: true, providerMessageId: `pm-${now}-${accepted.length}` };
  };
}

// Knows the provider's rate, so notifkit should never exceed it.
const limited = new RecordingTransport("email", {
  behaviour: rateLimitedProvider(),
  limits: { limit: RATE, windowSeconds: 1 },
});
// Doesn't, so the provider has to push back.
const unlimited = new RecordingTransport("sms", { behaviour: rateLimitedProvider() });

const failures: string[] = [];
const onFailed = (taskId: string, error: string) => failures.push(`${taskId}: ${error}`);

beforeAll(async () => {
  globalEmitter.on("delivery:failed", onFailed);
  app = await startNotifkit(infra, {
    providers: [limited, unlimited],
    env: { RATE_LIMIT_PER_HOUR: "100000" },
  });
}, 120_000);

afterAll(async () => {
  globalEmitter.off("delivery:failed", onFailed);
  await app?.stop();
}, 60_000);

async function burst(channel: "email" | "sms") {
  const p = await app.project();
  const res = await p.api("PUT", "/v1/templates", {
    templates: [{ id: "t", channel, content: { subject: "s", text: "hi" } }],
  });
  expect(res.status).toBe(200);
  failures.length = 0;
  await Promise.all(
    Array.from({ length: BURST }, async (_, i) => {
      const user =
        channel === "email"
          ? { id: `u${i}`, email: `u${i}@x.com` }
          : { id: `u${i}`, phone: `+1555000${String(i).padStart(4, "0")}` };
      const sent = await p.api("POST", "/v1/notify", { user, template: "t", channels: [channel] });
      expect(sent.status).toBe(202);
    }),
  );
  return p;
}

describe("a burst over a provider's send rate", () => {
  it("drains at the provider's rate when its limit is set, not one window per scheduler poll", async () => {
    const p = await burst("email");

    // 60 at 10 a second is 6 s. A window per 5 s poll would take 30 s.
    await waitFor("all delivered", () => limited.for(p.id).length === BURST, 20_000);

    expect(failures).toEqual([]);
  }, 60_000);

  it("delivers every message when the provider throttles, without the breaker failing them", async () => {
    const p = await burst("sms");

    await waitFor("all delivered", () => unlimited.for(p.id).length === BURST, 40_000);

    expect(failures).toEqual([]);
  }, 60_000);
});
