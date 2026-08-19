import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * One-click unsubscribe (RFC 8058).
 *
 * Gmail and Yahoo have required `List-Unsubscribe` + `List-Unsubscribe-Post` on
 * bulk mail since early 2024; without them bulk sends get throttled or junked,
 * and because deliverability is reputation on the *sending domain*, that
 * eventually drags transactional mail down with it.
 *
 * The link has to work from an inbox, years later, with no session — so the
 * token carries its own claim and is signed rather than looked up. Nothing is
 * stored per message, and there is no expiry: an unsubscribe link that has
 * stopped working is worse than useless, because the recipient's next move is
 * the spam button.
 */

export interface UnsubscribeClaim {
  /** Project the send belonged to. */
  projectId: string;
  /** The user's external id, as supplied by the caller. */
  userId: string;
  channel: string;
  /** The address itself — used when there is no topic to opt out of. */
  target: string;
  /** Topics the template belonged to. Empty means "suppress the address". */
  topics: string[];
}

interface WireClaim {
  p: string;
  u: string;
  c: string;
  t: string;
  k: string[];
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Sign a claim into a URL-safe token.
 *
 * The signature covers the exact encoded payload rather than a re-serialisation
 * of it, so a verifier never has to reproduce this function's JSON key order to
 * get a matching MAC.
 */
export function signUnsubscribeToken(claim: UnsubscribeClaim, secret: string): string {
  const wire: WireClaim = {
    p: claim.projectId,
    u: claim.userId,
    c: claim.channel,
    t: claim.target,
    k: claim.topics,
  };
  const payload = b64url(JSON.stringify(wire));
  const mac = b64url(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${mac}`;
}

/**
 * Verify and decode a token. Returns null for anything not signed by `secret`.
 *
 * Every failure returns the same null rather than a reason: the caller is an
 * unauthenticated endpoint, and distinguishing "malformed" from "bad signature"
 * hands an attacker a probe.
 */
export function verifyUnsubscribeToken(token: string, secret: string): UnsubscribeClaim | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;

  const payload = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = createHmac("sha256", secret).update(payload).digest();

  // timingSafeEqual throws on a length mismatch, which is itself a signal.
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  try {
    const wire = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as WireClaim;
    if (
      typeof wire.p !== "string" ||
      typeof wire.u !== "string" ||
      typeof wire.c !== "string" ||
      typeof wire.t !== "string" ||
      !Array.isArray(wire.k)
    ) {
      return null;
    }
    return {
      projectId: wire.p,
      userId: wire.u,
      channel: wire.c,
      target: wire.t,
      topics: wire.k.filter((t): t is string => typeof t === "string"),
    };
  } catch {
    return null;
  }
}

export interface UnsubscribeHeaderOptions {
  claim: UnsubscribeClaim;
  secret: string;
  /** Externally reachable base URL of the API, e.g. https://notify.example.com */
  publicUrl: string;
}

/**
 * The two headers that make an inbox render a real unsubscribe button.
 *
 * `List-Unsubscribe-Post` is what upgrades the link from "open this URL" to
 * one-click: the mail client POSTs directly and never shows the recipient a
 * landing page. Sending the URL without it means the recipient has to click
 * through and confirm, which mailbox providers do not count as compliant.
 */
export function buildUnsubscribeHeaders(options: UnsubscribeHeaderOptions): Record<string, string> {
  const token = signUnsubscribeToken(options.claim, options.secret);
  const base = options.publicUrl.replace(/\/$/, "");
  const url = `${base}/v1/unsubscribe?token=${encodeURIComponent(token)}`;
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
