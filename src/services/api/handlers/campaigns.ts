import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../http.js";
import type { RouteContext } from "../router.js";
import { eq, desc, and, lte, gte, sql, like, isNotNull } from "drizzle-orm";
import { messageLogs } from "@/db/schema.js";
import { type Deps, contains, getQueryParam, parseLimit } from "./shared.js";

export function createCampaignsHandlers(deps: Deps) {
  async function listCampaigns(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const limit = parseLimit(ctx, 20);
    const search = getQueryParam(ctx, "search")?.trim();
    const channel = getQueryParam(ctx, "channel")?.trim();
    const since = getQueryParam(ctx, "since")?.trim();
    const until = getQueryParam(ctx, "until")?.trim();
    const minMessagesParam = parseInt(getQueryParam(ctx, "minMessages") || "", 10);
    const minMessages = isNaN(minMessagesParam) ? undefined : Math.max(minMessagesParam, 1);

    const conditions = [
      eq(messageLogs.projectId, ctx.projectId!),
      isNotNull(messageLogs.campaignId),
    ];

    if (search) {
      conditions.push(like(messageLogs.campaignId, contains(search)));
    }
    if (channel) {
      conditions.push(eq(messageLogs.channel, channel as any));
    }
    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) {
        conditions.push(gte(messageLogs.timestamp, sinceDate));
      }
    }
    if (until) {
      const untilDate = new Date(until);
      if (!isNaN(untilDate.getTime())) {
        conditions.push(lte(messageLogs.timestamp, untilDate));
      }
    }

    let query = deps.db
      .select({
        campaign: messageLogs.campaignId,
        messages: sql<number>`count(distinct ${messageLogs.taskId})`,
        firstSentAt: sql<string>`min(${messageLogs.timestamp})`,
        lastActivityAt: sql<string>`max(${messageLogs.timestamp})`,
      })
      .from(messageLogs)
      .where(and(...conditions))
      .groupBy(messageLogs.campaignId)
      .orderBy(desc(sql`max(${messageLogs.timestamp})`))
      .limit(limit);

    if (minMessages !== undefined) {
      query = query.having(gte(sql`count(distinct ${messageLogs.taskId})`, minMessages)) as any;
    }

    const rows = await query;

    sendJson(res, 200, {
      campaigns: rows.map((r: any) => ({
        campaign: r.campaign,
        messages: Number(r.messages ?? 0),
        firstSentAt: r.firstSentAt,
        lastActivityAt: r.lastActivityAt,
      })),
    });
  }

  // Every figure counts distinct tasks, not rows: one task has a dispatch row,
  // an attempt row and any number of engagement rows.
  async function getCampaignStats(
    _req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const campaign = ctx.params.campaign;
    if (!campaign) return sendJson(res, 400, { error: "missing_campaign" });

    const rows = await deps.db
      .select({
        channel: messageLogs.channel,
        kind: messageLogs.kind,
        status: messageLogs.status,
        tasks: sql<number>`count(distinct ${messageLogs.taskId})`,
      })
      .from(messageLogs)
      .where(and(eq(messageLogs.projectId, ctx.projectId!), eq(messageLogs.campaignId, campaign)))
      .groupBy(messageLogs.channel, messageLogs.kind, messageLogs.status);

    if (rows.length === 0) {
      return sendJson(res, 404, {
        error: "not_found",
        message: `No messages recorded for campaign '${campaign}'`,
      });
    }

    const ENGAGEMENT = ["opened", "clicked", "bounced", "complained", "unsubscribed"] as const;
    type Engagement = (typeof ENGAGEMENT)[number];

    const blank = () => ({
      sent: 0,
      delivered: 0,
      failed: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
      complained: 0,
      unsubscribed: 0,
    });

    const byChannel = new Map<string, ReturnType<typeof blank>>();
    for (const row of rows as any[]) {
      const bucket = byChannel.get(row.channel) ?? blank();
      const n = Number(row.tasks ?? 0);

      if (ENGAGEMENT.includes(row.kind as Engagement)) {
        bucket[row.kind as Engagement] += n;
      } else if (row.kind === "dispatched") {
        // Every task that reached a provider: the denominator for bounce rate.
        bucket.sent += n;
      } else {
        if (row.status === "delivered") bucket.delivered += n;
        if (row.status === "failed") bucket.failed += n;
      }
      byChannel.set(row.channel, bucket);
    }

    const total = blank();
    for (const bucket of byChannel.values()) {
      for (const key of Object.keys(total) as (keyof ReturnType<typeof blank>)[]) {
        total[key] += bucket[key];
      }
    }

    const pct = (n: number, d: number) => (d > 0 ? Number(((n / d) * 100).toFixed(2)) : null);

    // No engagement data means untracked, not 0%: SMS, or email without a webhook.
    const channels = [...byChannel.keys()];
    const engagementCapable = channels.some((c) => c === "email");
    const sawEngagement = ENGAGEMENT.some((k) => total[k] > 0);

    const warnings: string[] = [];
    if (!engagementCapable) {
      warnings.push(
        `Opens and clicks are not reported on ${channels.join(", ")} — those figures are not tracked, not zero.`,
      );
    } else if (!sawEngagement && total.delivered > 0) {
      warnings.push(
        "No engagement events recorded. If the provider webhook is not configured, opens and clicks cannot be tracked and will stay at zero.",
      );
    }

    sendJson(res, 200, {
      campaign,
      totals: {
        ...total,
        deliveryRate: pct(total.delivered, total.sent),
        openRate: pct(total.opened, total.delivered),
        clickRate: pct(total.clicked, total.delivered),
        bounceRate: pct(total.bounced, total.sent),
        complaintRate: pct(total.complained, total.delivered),
        unsubscribeRate: pct(total.unsubscribed, total.delivered),
      },
      byChannel: Object.fromEntries(byChannel),
      engagementTracked: engagementCapable && sawEngagement,
      warnings,
    });
  }

  return {
    listCampaigns,
    getCampaignStats,
  };
}
