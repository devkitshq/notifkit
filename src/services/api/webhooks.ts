import type { IncomingMessage, ServerResponse } from "node:http";
import { inArray } from "drizzle-orm";
import type { Db } from "@/db/index.js";
import type { Logger } from "@/logger/index.js";
import type { Transport } from "@/transport/index.js";
import { messageLogs, suppressions } from "@/db/schema.js";
import { normaliseTarget } from "@/shared/index.js";
import { readRawBody, sendJson } from "./http.js";

export function createWebhookHandler(
  transport: Transport,
  channel: string,
  deps: { db: Db; logger: Logger },
) {
  const { db, logger } = deps;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let deadline: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => {
          const rawBody = await readRawBody(req);
          if (!transport.verifyWebhook) {
            if (!res.headersSent)
              sendJson(res, 501, {
                error: "not_implemented",
                message: "Webhook signature verification is not implemented for this provider",
              });
            return;
          }

          const isValid = await transport.verifyWebhook(rawBody, req.headers);
          if (!isValid) {
            if (!res.headersSent)
              sendJson(res, 401, {
                error: "unauthorized",
                message: "Invalid webhook signature",
              });
            return;
          }
          let body;
          try {
            body = rawBody ? JSON.parse(rawBody) : {};
          } catch {
            body = {};
          }
          const events = await transport.parseWebhook!(body, rawBody, req.headers);

          if (events.length > 0) {
            const providerIds = events.map((e) => e.providerMessageId).filter(Boolean) as string[];
            const logsToProject = new Map<string, string>();
            const logsToTask = new Map<string, string>();
            const logsToCampaign = new Map<string, string | null>();
            if (providerIds.length > 0) {
              const existing = await db
                .select({
                  providerMessageId: messageLogs.providerMessageId,
                  projectId: messageLogs.projectId,
                  taskId: messageLogs.taskId,
                  campaignId: messageLogs.campaignId,
                })
                .from(messageLogs)
                .where(inArray(messageLogs.providerMessageId, providerIds));
              for (const row of existing) {
                if (row.providerMessageId) {
                  logsToProject.set(row.providerMessageId, row.projectId);
                  logsToTask.set(row.providerMessageId, row.taskId);
                  // So an open counts toward the campaign of the send it is about.
                  logsToCampaign.set(row.providerMessageId, row.campaignId);
                }
              }
            }

            // Unattributable events are dropped: there is no project to store them under.
            const attributable = events.filter(
              (e) => e.providerMessageId && logsToProject.has(e.providerMessageId),
            );

            const rows = attributable.map((e) => ({
              projectId: logsToProject.get(e.providerMessageId)!,
              taskId: logsToTask.get(e.providerMessageId)!,
              providerMessageId: e.providerMessageId,
              channel: transport.channel,
              // Engagement events are not delivery attempts.
              attempt: 0,
              kind: e.status,
              status: e.status,
              campaignId: logsToCampaign.get(e.providerMessageId) ?? null,
              metadata: e.metadata ?? null,
            }));

            const skipped = events.length - rows.length;
            if (skipped > 0) {
              logger.warn(
                { channel, skipped },
                "webhook events skipped: unknown providerMessageId",
              );
            }

            if (rows.length > 0) {
              // Providers redeliver on any non-2xx; a repeat must be a no-op.
              await db.insert(messageLogs).values(rows).onConflictDoNothing();
            }

            // Stop future sends on unsubscribes, complaints and hard bounces (not soft ones).
            const suppressionRows = attributable
              .filter(
                (e) =>
                  e.recipient &&
                  (e.status === "unsubscribed" ||
                    e.status === "complained" ||
                    (e.status === "bounced" && e.bounceType === "hard")),
              )
              .map((e) => ({
                projectId: logsToProject.get(e.providerMessageId)!,
                channel: transport.channel,
                target: normaliseTarget(e.recipient!),
                reason: e.status,
                source: channel,
                taskId: logsToTask.get(e.providerMessageId)!,
              }));

            if (suppressionRows.length > 0) {
              // First reason wins: a later bounce must not hide an unsubscribe.
              await db.insert(suppressions).values(suppressionRows).onConflictDoNothing();
              logger.info(
                { channel, count: suppressionRows.length },
                "addresses suppressed from provider webhook",
              );
            }

            const unsuppressable = attributable.filter(
              (e) =>
                !e.recipient &&
                (e.status === "unsubscribed" ||
                  e.status === "complained" ||
                  e.status === "bounced"),
            ).length;
            if (unsuppressable > 0) {
              logger.warn(
                { channel, count: unsuppressable },
                "suppression events carried no recipient address — transport must set WebhookEvent.recipient",
              );
            }
          }
          if (!res.headersSent) sendJson(res, 200, { success: true });
        })(),
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("Webhook processing timeout")), 15000);
        }),
      ]);
    } catch (err) {
      // No detail in the body: providers keep response bodies in their logs.
      logger.error({ err, channel }, "webhook processing error or timeout");
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error" });
      }
    } finally {
      clearTimeout(deadline);
    }
  };
}
