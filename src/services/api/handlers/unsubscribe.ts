import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../router.js";
import { normaliseTarget } from "@/shared/index.js";
import { eq, and, sql } from "drizzle-orm";
import { suppressions, users as dbUsers, userTopicPreferences } from "@/db/schema.js";
import { readBaseConfig } from "@/config/index.js";
import { verifyUnsubscribeToken } from "@/unsubscribe/index.js";
import { type Deps } from "./shared.js";

export function createUnsubscribeHandlers(deps: Deps) {
  const { logger } = deps;

  // Both routes are public; the signed token in the URL is the credential.

  function sendHtml(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      // Nothing here should be cached by an inbox proxy or shared cache.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(body);
  }

  function escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function page(title: string, message: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#111}
h1{font-size:1.4rem;margin:0 0 .75rem}p{margin:0 0 1rem;color:#444}
button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:6px;background:#111;color:#fff;cursor:pointer}
code{background:#f4f4f5;padding:.1rem .35rem;border-radius:4px}</style>
</head><body><h1>${escapeHtml(title)}</h1>${message}</body></html>`;
  }

  // GET only shows a confirm page: mail scanners GET every link in a message.
  async function unsubscribePage(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const cfg = readBaseConfig();
    const token = ctx.query.get("token") ?? "";
    if (!cfg.UNSUBSCRIBE_SECRET) {
      deps.logger.warn(
        "UNSUBSCRIBE_SECRET is not configured — unable to verify unsubscribe tokens",
      );
    }
    const claim = cfg.UNSUBSCRIBE_SECRET
      ? verifyUnsubscribeToken(token, cfg.UNSUBSCRIBE_SECRET)
      : null;

    if (!claim) {
      return sendHtml(
        res,
        400,
        page(
          "This link is not valid",
          "<p>It may have been altered in transit, or this server may have been reconfigured since the message was sent. Replying to the message and asking to be removed will still work.</p>",
        ),
      );
    }

    const what =
      claim.topics.length > 0
        ? `<code>${claim.topics.map(escapeHtml).join("</code>, <code>")}</code> messages`
        : "all messages";

    sendHtml(
      res,
      200,
      page(
        "Unsubscribe",
        `<p>Stop sending ${what} to <code>${escapeHtml(claim.target)}</code>?</p>
<form method="post" action="/v1/unsubscribe?token=${encodeURIComponent(token)}">
<button type="submit">Unsubscribe</button></form>`,
      ),
    );
  }

  // POST serves RFC 8058 one-click and the form above. Neither can carry a CSRF
  // token, so the signed token is the whole authorisation.
  async function unsubscribe(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    // Nothing in the body is needed, but unread bytes would stay on a keep-alive socket.
    req.resume();

    const cfg = readBaseConfig();
    const token = ctx.query.get("token") ?? "";
    if (!cfg.UNSUBSCRIBE_SECRET) {
      deps.logger.warn(
        "UNSUBSCRIBE_SECRET is not configured — unable to verify unsubscribe tokens",
      );
    }
    const claim = cfg.UNSUBSCRIBE_SECRET
      ? verifyUnsubscribeToken(token, cfg.UNSUBSCRIBE_SECRET)
      : null;

    if (!claim) {
      return sendHtml(
        res,
        400,
        page(
          "This link is not valid",
          "<p>It may have been altered in transit, or this server may have been reconfigured since the message was sent.</p>",
        ),
      );
    }

    const target = normaliseTarget(claim.target);

    try {
      const userRows = await deps.db
        .select({ id: dbUsers.id })
        .from(dbUsers)
        .where(and(eq(dbUsers.projectId, claim.projectId), eq(dbUsers.externalId, claim.userId)))
        .limit(1);
      const internalId = userRows[0]?.id;

      if (claim.topics.length > 0 && internalId) {
        // Scoped opt-out: transactional mail keeps working.
        await deps.db
          .insert(userTopicPreferences)
          .values(claim.topics.map((topic) => ({ userId: internalId, topic, enabled: false })))
          .onConflictDoUpdate({
            target: [userTopicPreferences.userId, userTopicPreferences.topic],
            set: { enabled: sql`excluded.enabled` },
          });
      } else {
        // No topic, or the user is gone: suppress the address outright.
        await deps.db
          .insert(suppressions)
          .values({
            projectId: claim.projectId,
            channel: claim.channel as any,
            target,
            reason: "unsubscribed",
            source: "unsubscribe-link",
          })
          .onConflictDoNothing();
      }

      logger.info(
        {
          projectId: claim.projectId,
          channel: claim.channel,
          topics: claim.topics,
          scoped: claim.topics.length > 0 && Boolean(internalId),
        },
        "unsubscribe honoured",
      );
    } catch (err) {
      logger.error({ err, projectId: claim.projectId }, "unsubscribe failed to apply");
      return sendHtml(
        res,
        500,
        page(
          "Something went wrong",
          "<p>We could not record that just now. Please try again in a moment.</p>",
        ),
      );
    }

    sendHtml(
      res,
      200,
      page(
        "You're unsubscribed",
        `<p>We've stopped sending ${
          claim.topics.length > 0 ? "these messages" : "messages"
        } to <code>${escapeHtml(claim.target)}</code>. It may take a few minutes to take effect for mail already on its way.</p>`,
      ),
    );
  }

  return {
    unsubscribePage,
    unsubscribe,
  };
}
