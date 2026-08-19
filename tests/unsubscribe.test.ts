import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  buildUnsubscribeHeaders,
  type UnsubscribeClaim,
} from "@/unsubscribe/index.js";
import { normaliseTarget } from "@/shared/index.js";

const SECRET = "a-secret-at-least-16-chars";

const claim: UnsubscribeClaim = {
  projectId: "123e4567-e89b-12d3-a456-426614174000",
  userId: "usr_1",
  channel: "email",
  target: "alice@example.com",
  topics: ["marketing"],
};

describe("unsubscribe tokens", () => {
  it("round-trips a claim through sign and verify", () => {
    const token = signUnsubscribeToken(claim, SECRET);
    expect(verifyUnsubscribeToken(token, SECRET)).toEqual(claim);
  });

  it("round-trips an empty topic list, which means 'suppress the address'", () => {
    const token = signUnsubscribeToken({ ...claim, topics: [] }, SECRET);
    expect(verifyUnsubscribeToken(token, SECRET)?.topics).toEqual([]);
  });

  it("produces a URL-safe token", () => {
    const token = signUnsubscribeToken(
      { ...claim, userId: "usr/+=1", target: "a+b@example.com" },
      SECRET,
    );
    // base64url alphabet plus the separator, so it survives a query string
    // without escaping — the header carries it verbatim into a mail client.
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("rejects a token signed with a different secret", () => {
    const token = signUnsubscribeToken(claim, SECRET);
    expect(verifyUnsubscribeToken(token, "another-secret-16-chars")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = signUnsubscribeToken(claim, SECRET);
    const [payload, mac] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ p: claim.projectId, u: "usr_2", c: "email", t: "bob@example.com", k: [] }),
    ).toString("base64url");
    expect(forged).not.toBe(payload);
    expect(verifyUnsubscribeToken(`${forged}.${mac}`, SECRET)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = signUnsubscribeToken(claim, SECRET);
    const [payload] = token.split(".");
    const otherMac = signUnsubscribeToken({ ...claim, userId: "usr_2" }, SECRET).split(".")[1];
    expect(verifyUnsubscribeToken(`${payload}.${otherMac}`, SECRET)).toBeNull();
  });

  it("rejects a signature of the wrong length without throwing", () => {
    const token = signUnsubscribeToken(claim, SECRET);
    const [payload, mac] = token.split(".");
    // timingSafeEqual throws on a length mismatch, so this must be caught
    // before it gets there.
    expect(() => verifyUnsubscribeToken(`${payload}.${mac!.slice(0, 10)}`, SECRET)).not.toThrow();
    expect(verifyUnsubscribeToken(`${payload}.${mac!.slice(0, 10)}`, SECRET)).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["no separator", "justonesegment"],
    ["leading separator", ".abc"],
    ["trailing separator", "abc."],
    ["separator only", "."],
    ["not base64", "!!!.???"],
  ])("rejects a malformed token (%s)", (_name, token) => {
    expect(verifyUnsubscribeToken(token, SECRET)).toBeNull();
  });

  it("rejects a correctly signed payload that is not a claim", () => {
    // A valid MAC over the wrong shape: signing is not the only gate, because
    // the payload is parsed and trusted downstream.
    const payload = Buffer.from(JSON.stringify({ p: 1, u: null })).toString("base64url");
    const mac = createHmac("sha256", SECRET).update(payload).digest().toString("base64url");
    expect(verifyUnsubscribeToken(`${payload}.${mac}`, SECRET)).toBeNull();
  });

  it("rejects a correctly signed payload whose topics are not an array", () => {
    const payload = Buffer.from(
      JSON.stringify({ p: "p", u: "u", c: "email", t: "a@b.com", k: "marketing" }),
    ).toString("base64url");
    const mac = createHmac("sha256", SECRET).update(payload).digest().toString("base64url");
    expect(verifyUnsubscribeToken(`${payload}.${mac}`, SECRET)).toBeNull();
  });

  it("drops non-string entries from topics rather than failing", () => {
    const payload = Buffer.from(
      JSON.stringify({ p: "p", u: "u", c: "email", t: "a@b.com", k: ["marketing", 7, null] }),
    ).toString("base64url");
    const mac = createHmac("sha256", SECRET).update(payload).digest().toString("base64url");
    expect(verifyUnsubscribeToken(`${payload}.${mac}`, SECRET)?.topics).toEqual(["marketing"]);
  });

  it("does not expire — a link in an old inbox still works", () => {
    // The module documents this deliberately: a dead unsubscribe link sends the
    // recipient to the spam button instead. Encoded here so a later change that
    // adds an expiry has to change a test that says why.
    const token = signUnsubscribeToken(claim, SECRET);
    expect(token).not.toMatch(/exp/i);
    const decoded = JSON.parse(
      Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(decoded).sort()).toEqual(["c", "k", "p", "t", "u"]);
  });

  it("is deterministic, so the same claim yields the same token", () => {
    expect(signUnsubscribeToken(claim, SECRET)).toBe(signUnsubscribeToken(claim, SECRET));
  });
});

describe("buildUnsubscribeHeaders", () => {
  it("returns both RFC 8058 headers", () => {
    const headers = buildUnsubscribeHeaders({
      claim,
      secret: SECRET,
      publicUrl: "https://notify.example.com",
    });

    expect(Object.keys(headers).sort()).toEqual(["List-Unsubscribe", "List-Unsubscribe-Post"]);
    // Without the -Post header the link is not one-click, and mailbox providers
    // do not count it as compliant.
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("wraps the URL in angle brackets, as the header syntax requires", () => {
    const headers = buildUnsubscribeHeaders({
      claim,
      secret: SECRET,
      publicUrl: "https://notify.example.com",
    });
    expect(headers["List-Unsubscribe"]).toMatch(/^<https:\/\/notify\.example\.com\/v1\/.+>$/);
  });

  it("embeds a token the verifier accepts", () => {
    const headers = buildUnsubscribeHeaders({
      claim,
      secret: SECRET,
      publicUrl: "https://notify.example.com",
    });
    const url = new URL(headers["List-Unsubscribe"]!.slice(1, -1));

    expect(url.pathname).toBe("/v1/unsubscribe");
    expect(verifyUnsubscribeToken(url.searchParams.get("token")!, SECRET)).toEqual(claim);
  });

  it("does not double the slash when publicUrl has a trailing one", () => {
    const headers = buildUnsubscribeHeaders({
      claim,
      secret: SECRET,
      publicUrl: "https://notify.example.com/",
    });
    expect(headers["List-Unsubscribe"]).toContain("https://notify.example.com/v1/unsubscribe?");
    expect(headers["List-Unsubscribe"]).not.toContain("com//v1");
  });

  it("keeps a base path from publicUrl", () => {
    const headers = buildUnsubscribeHeaders({
      claim,
      secret: SECRET,
      publicUrl: "https://example.com/notify",
    });
    expect(headers["List-Unsubscribe"]).toContain("https://example.com/notify/v1/unsubscribe?");
  });
});

describe("normaliseTarget", () => {
  it("lowercases an email address, since mailboxes are case-insensitive", () => {
    expect(normaliseTarget("Alice@Example.COM")).toBe("alice@example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(normaliseTarget("  alice@example.com \n")).toBe("alice@example.com");
  });

  it("leaves a non-email target's case alone", () => {
    // A push token is case-sensitive; lowercasing it would suppress nothing and
    // silently fail to stop the sends.
    expect(normaliseTarget("AbC123-DeviceToken")).toBe("AbC123-DeviceToken");
    expect(normaliseTarget(" +1987654321 ")).toBe("+1987654321");
  });

  it("is idempotent, so a re-suppressed address still collides on conflict", () => {
    const once = normaliseTarget(" Alice@Example.com ");
    expect(normaliseTarget(once)).toBe(once);
  });
});
