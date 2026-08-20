import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHandlers } from "@/services/api/handlers.js";
import { globalEmitter } from "@/shared/index.js";
import { signUnsubscribeToken } from "@/unsubscribe/index.js";
import { suppressions, userTopicPreferences, scheduledPayloads } from "@/db/schema.js";
import { createMockDb, type MockDb } from "./helpers/mock-db.js";

/**
 * The compliance surface: suppressions, campaign reporting, unsubscribe, and
 * cancellation. Everything here is either a promise not to contact somebody or
 * the number an operator makes a decision from, so the assertions are about
 * exact values rather than "it responded".
 */

const SECRET = "unsubscribe-test-secret-key";

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    writeHead: vi.fn((code: number, headers?: any) => {
      res.statusCode = code;
      Object.assign(res.headers, headers || {});
      return res;
    }),
    setHeader: vi.fn((k: string, v: string) => {
      res.headers[k] = v;
    }),
    write: vi.fn(() => true),
    end: vi.fn((data?: string) => {
      if (data) res.body = data;
    }),
  } as any;
  return res;
}

function createMockReq(body?: any) {
  return {
    on: vi.fn((event: string, cb: any) => {
      if (event === "data" && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
      if (event === "end") cb();
    }),
    resume: vi.fn(),
    headers: {},
  } as any;
}

const ctx = (over: any = {}) =>
  ({
    projectId: "proj_1",
    params: {},
    query: new URLSearchParams(),
    ...over,
  }) as any;

const parse = (res: any) => JSON.parse(res.body);

describe("API compliance handlers", () => {
  let deps: any;
  let handlers: ReturnType<typeof createHandlers>;
  let mockDb: MockDb;
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.UNSUBSCRIBE_SECRET;
    process.env.UNSUBSCRIBE_SECRET = SECRET;

    mockDb = createMockDb();
    deps = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      producers: { normal: { publish: vi.fn(), publishBatch: vi.fn() } },
      userRepo: {},
      contactRepo: {},
      templateRepo: {},
      projectRepo: {},
      workflowRepo: {},
      segmentRepo: {},
      db: mockDb.db,
      redis: { native: { publish: vi.fn() } },
    };
    handlers = createHandlers(deps);
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.UNSUBSCRIBE_SECRET;
    else process.env.UNSUBSCRIBE_SECRET = originalSecret;
    vi.restoreAllMocks();
  });

  // ── Suppressions ──────────────────────────────────────────────────────────

  describe("listSuppressions", () => {
    it("returns the project's suppression rows", async () => {
      mockDb.queueSelect([
        { channel: "email", target: "a@example.com", reason: "complained" },
        { channel: "email", target: "b@example.com", reason: "bounced" },
      ]);
      const res = createMockRes();

      await handlers.listSuppressions(createMockReq(), res, ctx());

      expect(res.statusCode).toBe(200);
      expect(parse(res).suppressions).toHaveLength(2);
      expect(mockDb.selects[0]!.table).toBe(suppressions);
    });

    it("defaults to a limit of 100", async () => {
      mockDb.queueSelect([]);
      await handlers.listSuppressions(createMockReq(), createMockRes(), ctx());

      expect(mockDb.selects[0]!.limit).toBe(100);
    });

    it("caps an oversized limit at 500 so one call cannot pull the whole table", async () => {
      mockDb.queueSelect([]);
      await handlers.listSuppressions(
        createMockReq(),
        createMockRes(),
        ctx({ query: new URLSearchParams({ limit: "99999" }) }),
      );

      expect(mockDb.selects[0]!.limit).toBe(500);
    });

    it("raises a zero or negative limit to 1", async () => {
      mockDb.queueSelect([]);
      await handlers.listSuppressions(
        createMockReq(),
        createMockRes(),
        ctx({ query: new URLSearchParams({ limit: "0" }) }),
      );

      expect(mockDb.selects[0]!.limit).toBe(1);
    });

    it("falls back to the default when the limit is not a number", async () => {
      mockDb.queueSelect([]);
      await handlers.listSuppressions(
        createMockReq(),
        createMockRes(),
        ctx({ query: new URLSearchParams({ limit: "abc" }) }),
      );

      expect(mockDb.selects[0]!.limit).toBe(100);
    });

    it("narrows the query when channel, reason, and target are given", async () => {
      mockDb.queueSelect([]);
      await handlers.listSuppressions(
        createMockReq(),
        createMockRes(),
        ctx({
          query: new URLSearchParams({
            channel: "email",
            reason: "complained",
            target: "user@example.com",
          }),
        }),
      );

      // where + orderBy + limit, all against the suppressions table.
      expect(mockDb.selects[0]!.chain).toEqual(["where", "orderBy", "limit"]);
    });
  });

  describe("createSuppression", () => {
    it("stores the suppression and answers 201", async () => {
      const res = createMockRes();
      await handlers.createSuppression(
        createMockReq({ channel: "email", target: "blocked@example.com", reason: "complained" }),
        res,
        ctx(),
      );

      expect(res.statusCode).toBe(201);
      expect(mockDb.inserts[0]!.table).toBe(suppressions);
      expect(mockDb.inserts[0]!.values).toMatchObject({
        projectId: "proj_1",
        channel: "email",
        target: "blocked@example.com",
        reason: "complained",
        source: "api",
      });
    });

    it("normalises the address before storing it", async () => {
      // Stored raw, it would never match the engine's lookup, and the person
      // would keep receiving mail they opted out of.
      const res = createMockRes();
      await handlers.createSuppression(
        createMockReq({ channel: "email", target: "  Blocked@Example.COM " }),
        res,
        ctx(),
      );

      expect(mockDb.inserts[0]!.values.target).toBe("blocked@example.com");
      expect(parse(res).target).toBe("blocked@example.com");
    });

    it("defaults the reason to manual", async () => {
      await handlers.createSuppression(
        createMockReq({ channel: "email", target: "x@example.com" }),
        createMockRes(),
        ctx(),
      );

      expect(mockDb.inserts[0]!.values.reason).toBe("manual");
    });

    it("leaves an existing record alone, so the original reason survives", async () => {
      await handlers.createSuppression(
        createMockReq({ channel: "email", target: "x@example.com" }),
        createMockRes(),
        ctx(),
      );

      expect(mockDb.inserts[0]!.conflict).toBe("nothing");
    });

    it("rejects a body with no target", async () => {
      const res = createMockRes();
      await handlers.createSuppression(createMockReq({ channel: "email" }), res, ctx());

      expect(res.statusCode).toBe(400);
      expect(parse(res).error).toBe("validation_error");
      expect(mockDb.inserts).toHaveLength(0);
    });

    it("rejects an empty target rather than suppressing the empty string", async () => {
      const res = createMockRes();
      await handlers.createSuppression(createMockReq({ channel: "email", target: "" }), res, ctx());

      expect(res.statusCode).toBe(400);
      expect(mockDb.inserts).toHaveLength(0);
    });

    it("rejects an unknown channel", async () => {
      const res = createMockRes();
      await handlers.createSuppression(
        createMockReq({ channel: "carrier-pigeon", target: "x@example.com" }),
        res,
        ctx(),
      );

      expect(res.statusCode).toBe(400);
      expect(mockDb.inserts).toHaveLength(0);
    });

    it("rejects a reason outside the allowed set", async () => {
      const res = createMockRes();
      await handlers.createSuppression(
        createMockReq({ channel: "email", target: "x@example.com", reason: "because" }),
        res,
        ctx(),
      );

      expect(res.statusCode).toBe(400);
    });
  });

  describe("deleteSuppression", () => {
    it("removes the record and answers 204", async () => {
      const res = createMockRes();
      await handlers.deleteSuppression(
        createMockReq(),
        res,
        ctx({ params: { channel: "email", target: "blocked@example.com" } }),
      );

      expect(res.statusCode).toBe(204);
      expect(mockDb.deletes[0]!.table).toBe(suppressions);
    });

    it("400s when the channel or target segment is missing", async () => {
      const res = createMockRes();
      await handlers.deleteSuppression(createMockReq(), res, ctx({ params: { channel: "email" } }));

      expect(res.statusCode).toBe(400);
      expect(parse(res).error).toBe("missing_channel_or_target");
      expect(mockDb.deletes).toHaveLength(0);
    });
  });

  // ── Campaigns ─────────────────────────────────────────────────────────────

  describe("listCampaigns", () => {
    it("returns one row per campaign with counts coerced to numbers", async () => {
      // Postgres returns count() as a string over the wire.
      mockDb.queueSelect([
        {
          campaign: "spring-sale",
          messages: "1200",
          firstSentAt: "2026-05-01T00:00:00Z",
          lastActivityAt: "2026-05-02T00:00:00Z",
        },
      ]);
      const res = createMockRes();

      await handlers.listCampaigns(createMockReq(), res, ctx());

      expect(parse(res).campaigns).toEqual([
        {
          campaign: "spring-sale",
          messages: 1200,
          firstSentAt: "2026-05-01T00:00:00Z",
          lastActivityAt: "2026-05-02T00:00:00Z",
        },
      ]);
    });

    it("reports zero rather than null for a campaign with no count", async () => {
      mockDb.queueSelect([{ campaign: "empty", messages: null }]);
      const res = createMockRes();

      await handlers.listCampaigns(createMockReq(), res, ctx());

      expect(parse(res).campaigns[0].messages).toBe(0);
    });

    it("returns an empty list when the project has never sent a campaign", async () => {
      mockDb.queueSelect([]);
      const res = createMockRes();

      await handlers.listCampaigns(createMockReq(), res, ctx());

      expect(res.statusCode).toBe(200);
      expect(parse(res).campaigns).toEqual([]);
    });

    it("defaults to 20 campaigns and caps the limit at 100", async () => {
      mockDb.queueSelect([]);
      await handlers.listCampaigns(createMockReq(), createMockRes(), ctx());
      expect(mockDb.selects[0]!.limit).toBe(20);

      mockDb.queueSelect([]);
      await handlers.listCampaigns(
        createMockReq(),
        createMockRes(),
        ctx({ query: new URLSearchParams({ limit: "5000" }) }),
      );
      expect(mockDb.selects[1]!.limit).toBe(100);
    });

    it("applies search, channel, date range, and minMessages filters", async () => {
      mockDb.queueSelect([]);
      const res = createMockRes();
      await handlers.listCampaigns(
        createMockReq(),
        res,
        ctx({
          query: new URLSearchParams({
            search: "spring",
            channel: "email",
            since: "2026-05-01T00:00:00.000Z",
            until: "2026-05-31T23:59:59.000Z",
            minMessages: "10",
          }),
        }),
      );

      expect(res.statusCode).toBe(200);
      expect(mockDb.selects[0]!.chain).toContain("where");
      expect(mockDb.selects[0]!.chain).toContain("having");
    });
  });

  describe("getCampaignStats", () => {
    const statsCtx = (campaign = "spring-sale") => ctx({ params: { campaign } });

    it("400s when no campaign is named", async () => {
      const res = createMockRes();
      await handlers.getCampaignStats(createMockReq(), res, ctx({ params: {} }));

      expect(res.statusCode).toBe(400);
      expect(parse(res).error).toBe("missing_campaign");
    });

    it("404s for a campaign with no recorded messages", async () => {
      mockDb.queueSelect([]);
      const res = createMockRes();

      await handlers.getCampaignStats(createMockReq(), res, statsCtx("never-sent"));

      expect(res.statusCode).toBe(404);
      expect(parse(res).message).toContain("never-sent");
    });

    it("splits delivery rows into sent, delivered and failed", async () => {
      mockDb.queueSelect([
        { channel: "email", kind: "delivery", status: "delivered", tasks: "90" },
        { channel: "email", kind: "delivery", status: "failed", tasks: "10" },
      ]);
      const res = createMockRes();

      await handlers.getCampaignStats(createMockReq(), res, statsCtx());

      const { totals } = parse(res);
      expect(totals.sent).toBe(100);
      expect(totals.delivered).toBe(90);
      expect(totals.failed).toBe(10);
      expect(totals.deliveryRate).toBe(90);
    });

    it("counts engagement kinds separately from the send total", async () => {
      mockDb.queueSelect([
        { channel: "email", kind: "delivery", status: "delivered", tasks: "100" },
        { channel: "email", kind: "opened", status: "opened", tasks: "40" },
        { channel: "email", kind: "clicked", status: "clicked", tasks: "10" },
      ]);
      const res = createMockRes();

      await handlers.getCampaignStats(createMockReq(), res, statsCtx());

      const { totals } = parse(res);
      // An open is not another send.
      expect(totals.sent).toBe(100);
      expect(totals.opened).toBe(40);
      expect(totals.openRate).toBe(40);
      expect(totals.clickRate).toBe(10);
    });

    it("rounds a rate to two decimals", async () => {
      mockDb.queueSelect([
        { channel: "email", kind: "delivery", status: "delivered", tasks: "3" },
        { channel: "email", kind: "opened", status: "opened", tasks: "1" },
      ]);
      const res = createMockRes();

      await handlers.getCampaignStats(createMockReq(), res, statsCtx());

      expect(parse(res).totals.openRate).toBe(33.33);
    });

    it("reports a rate as null, not zero, when its denominator is zero", async () => {
      mockDb.queueSelect([{ channel: "email", kind: "delivery", status: "failed", tasks: "5" }]);
      const res = createMockRes();

      await handlers.getCampaignStats(createMockReq(), res, statsCtx());

      const { totals } = parse(res);
      expect(totals.delivered).toBe(0);
      // Nothing was delivered, so an open rate does not exist.
      expect(totals.openRate).toBeNull();
      expect(totals.deliveryRate).toBe(0);
    });

    it("breaks the funnel down per channel and totals across them", async () => {
      mockDb.queueSelect([
        { channel: "email", kind: "delivery", status: "delivered", tasks: "50" },
        { channel: "sms", kind: "delivery", status: "delivered", tasks: "30" },
        { channel: "sms", kind: "delivery", status: "failed", tasks: "20" },
      ]);
      const res = createMockRes();

      await handlers.getCampaignStats(createMockReq(), res, statsCtx());

      const body = parse(res);
      expect(body.byChannel.email.delivered).toBe(50);
      expect(body.byChannel.sms.sent).toBe(50);
      expect(body.byChannel.sms.failed).toBe(20);
      expect(body.totals.sent).toBe(100);
      expect(body.totals.delivered).toBe(80);
    });

    it("warns that opens are untracked rather than zero on a channel that cannot report them", async () => {
      mockDb.queueSelect([{ channel: "sms", kind: "delivery", status: "delivered", tasks: "10" }]);
      const res = createMockRes();

      await handlers.getCampaignStats(createMockReq(), res, statsCtx());

      const body = parse(res);
      expect(body.engagementTracked).toBe(false);
      expect(body.warnings[0]).toContain("not tracked, not zero");
    });

    it("warns when email was delivered but no engagement ever arrived", async () => {
      mockDb.queueSelect([
        { channel: "email", kind: "delivery", status: "delivered", tasks: "10" },
      ]);
      const res = createMockRes();

      await handlers.getCampaignStats(createMockReq(), res, statsCtx());

      const body = parse(res);
      expect(body.engagementTracked).toBe(false);
      expect(body.warnings[0]).toContain("webhook");
    });

    it("stays quiet when engagement is both possible and present", async () => {
      mockDb.queueSelect([
        { channel: "email", kind: "delivery", status: "delivered", tasks: "10" },
        { channel: "email", kind: "opened", status: "opened", tasks: "4" },
      ]);
      const res = createMockRes();

      await handlers.getCampaignStats(createMockReq(), res, statsCtx());

      const body = parse(res);
      expect(body.engagementTracked).toBe(true);
      expect(body.warnings).toEqual([]);
    });
  });

  // ── Notification status and cancellation ──────────────────────────────────

  describe("getNotificationStatus", () => {
    it("400s without a task id", async () => {
      const res = createMockRes();
      await handlers.getNotificationStatus(createMockReq(), res, ctx({ params: {} }));

      expect(res.statusCode).toBe(400);
      expect(parse(res).error).toBe("missing_task_id");
    });

    it("404s when nothing has been logged for the task", async () => {
      mockDb.queueSelect([]);
      const res = createMockRes();

      await handlers.getNotificationStatus(createMockReq(), res, ctx({ params: { taskId: "t1" } }));

      expect(res.statusCode).toBe(404);
    });

    it("reports the newest log row as the current status", async () => {
      mockDb.queueSelect([
        { status: "delivered", timestamp: "2026-05-02T00:00:00Z" },
        { status: "sent", timestamp: "2026-05-01T00:00:00Z" },
      ]);
      const res = createMockRes();

      await handlers.getNotificationStatus(createMockReq(), res, ctx({ params: { taskId: "t1" } }));

      const body = parse(res);
      expect(body.status).toBe("delivered");
      expect(body.logs).toHaveLength(2);
    });
  });

  describe("cancelNotification", () => {
    it("400s without a task id", async () => {
      const res = createMockRes();
      await handlers.cancelNotification(createMockReq(), res, ctx({ params: {} }));

      expect(res.statusCode).toBe(400);
    });

    it("404s when the task is not scheduled any more", async () => {
      mockDb.queueSelect([]);
      const res = createMockRes();

      await handlers.cancelNotification(createMockReq(), res, ctx({ params: { taskId: "t1" } }));

      expect(res.statusCode).toBe(404);
      expect(mockDb.deletes).toHaveLength(0);
    });

    it("refuses to cancel another project's task, and does not reveal it exists", async () => {
      mockDb.queueSelect([{ payload: { projectId: "someone_else" } }]);
      const res = createMockRes();

      await handlers.cancelNotification(createMockReq(), res, ctx({ params: { taskId: "t1" } }));

      expect(res.statusCode).toBe(404);
      // Same body as a genuinely missing task, and nothing was deleted.
      expect(parse(res).error).toBe("not_found");
      expect(mockDb.deletes).toHaveLength(0);
    });

    it("deletes the scheduled payload and announces the cancellation", async () => {
      const emit = vi.spyOn(globalEmitter, "emit");
      mockDb.queueSelect([{ payload: { projectId: "proj_1" } }]);
      mockDb.queueDelete([{ taskId: "t1" }]);
      const res = createMockRes();

      await handlers.cancelNotification(createMockReq(), res, ctx({ params: { taskId: "t1" } }));

      expect(res.statusCode).toBe(200);
      expect(parse(res).success).toBe(true);
      expect(mockDb.deletes[0]!.table).toBe(scheduledPayloads);
      expect(emit).toHaveBeenCalledWith("notification:canceled", {
        projectId: "proj_1",
        taskId: "t1",
      });
    });

    it("404s when the row vanished between the read and the delete", async () => {
      // The scheduler released it in the gap; there is nothing left to cancel.
      const emit = vi.spyOn(globalEmitter, "emit");
      mockDb.queueSelect([{ payload: { projectId: "proj_1" } }]);
      mockDb.queueDelete([]);
      const res = createMockRes();

      await handlers.cancelNotification(createMockReq(), res, ctx({ params: { taskId: "t1" } }));

      expect(res.statusCode).toBe(404);
      expect(emit).not.toHaveBeenCalledWith("notification:canceled", expect.anything());
    });
  });

  // ── Unsubscribe ───────────────────────────────────────────────────────────

  const claim = (over: Partial<Parameters<typeof signUnsubscribeToken>[0]> = {}) => ({
    projectId: "proj_1",
    userId: "usr-1",
    channel: "email",
    target: "alice@example.com",
    topics: [] as string[],
    ...over,
  });

  const tokenQuery = (c = claim()) =>
    new URLSearchParams({ token: signUnsubscribeToken(c, SECRET) });

  describe("unsubscribePage", () => {
    it("renders a confirmation form naming the address", async () => {
      const res = createMockRes();
      await handlers.unsubscribePage(createMockReq(), res, ctx({ query: tokenQuery() }));

      expect(res.statusCode).toBe(200);
      expect(res.headers["Content-Type"]).toContain("text/html");
      expect(res.body).toContain("alice@example.com");
      expect(res.body).toContain('<form method="post"');
    });

    it("changes nothing — a link prescanner must not opt anybody out", async () => {
      const res = createMockRes();
      await handlers.unsubscribePage(createMockReq(), res, ctx({ query: tokenQuery() }));

      expect(mockDb.inserts).toHaveLength(0);
      expect(mockDb.deletes).toHaveLength(0);
    });

    it("names the topics when the opt-out is scoped to some", async () => {
      const res = createMockRes();
      await handlers.unsubscribePage(
        createMockReq(),
        res,
        ctx({ query: tokenQuery(claim({ topics: ["marketing", "digest"] })) }),
      );

      expect(res.body).toContain("marketing");
      expect(res.body).toContain("digest");
    });

    it("rejects a token that was not signed by this server", async () => {
      const forged = signUnsubscribeToken(claim(), "some-other-secret-entirely");
      const res = createMockRes();

      await handlers.unsubscribePage(
        createMockReq(),
        res,
        ctx({ query: new URLSearchParams({ token: forged }) }),
      );

      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("not valid");
    });

    it("rejects a request with no token at all", async () => {
      const res = createMockRes();
      await handlers.unsubscribePage(createMockReq(), res, ctx());

      expect(res.statusCode).toBe(400);
    });

    it("rejects every link when no signing secret is configured", async () => {
      const token = signUnsubscribeToken(claim(), SECRET);
      delete process.env.UNSUBSCRIBE_SECRET;
      const res = createMockRes();

      await handlers.unsubscribePage(
        createMockReq(),
        res,
        ctx({ query: new URLSearchParams({ token }) }),
      );

      expect(res.statusCode).toBe(400);
    });

    it("escapes the address instead of writing it into the page as markup", async () => {
      const res = createMockRes();
      await handlers.unsubscribePage(
        createMockReq(),
        res,
        ctx({ query: tokenQuery(claim({ target: "<script>alert(1)</script>@x.com" })) }),
      );

      expect(res.body).not.toContain("<script>alert(1)</script>");
      expect(res.body).toContain("&lt;script&gt;");
    });

    it("sends the page uncacheable, so a shared proxy cannot serve it to someone else", async () => {
      const res = createMockRes();
      await handlers.unsubscribePage(createMockReq(), res, ctx({ query: tokenQuery() }));

      expect(res.headers["Cache-Control"]).toBe("no-store");
      expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
    });
  });

  describe("unsubscribe", () => {
    it("suppresses the address when the claim carries no topic", async () => {
      mockDb.queueSelect([{ id: "internal-uuid" }]);
      const res = createMockRes();

      await handlers.unsubscribe(createMockReq(), res, ctx({ query: tokenQuery() }));

      expect(res.statusCode).toBe(200);
      expect(mockDb.inserts[0]!.table).toBe(suppressions);
      expect(mockDb.inserts[0]!.values).toMatchObject({
        projectId: "proj_1",
        channel: "email",
        target: "alice@example.com",
        reason: "unsubscribed",
        source: "unsubscribe-link",
      });
    });

    it("normalises the address it suppresses", async () => {
      mockDb.queueSelect([{ id: "internal-uuid" }]);
      const res = createMockRes();

      await handlers.unsubscribe(
        createMockReq(),
        res,
        ctx({ query: tokenQuery(claim({ target: "Alice@Example.COM" })) }),
      );

      expect(mockDb.inserts[0]!.values.target).toBe("alice@example.com");
    });

    it("turns off just the named topics when the claim is scoped", async () => {
      mockDb.queueSelect([{ id: "internal-uuid" }]);
      const res = createMockRes();

      await handlers.unsubscribe(
        createMockReq(),
        res,
        ctx({ query: tokenQuery(claim({ topics: ["marketing"] })) }),
      );

      expect(res.statusCode).toBe(200);
      expect(mockDb.inserts[0]!.table).toBe(userTopicPreferences);
      expect(mockDb.inserts[0]!.values).toEqual([
        { userId: "internal-uuid", topic: "marketing", enabled: false },
      ]);
      // The address itself keeps working for anything transactional.
      expect(mockDb.inserts.some((i) => i.table === suppressions)).toBe(false);
    });

    it("overwrites an existing preference rather than silently keeping it enabled", async () => {
      mockDb.queueSelect([{ id: "internal-uuid" }]);

      await handlers.unsubscribe(
        createMockReq(),
        createMockRes(),
        ctx({ query: tokenQuery(claim({ topics: ["marketing"] })) }),
      );

      expect(mockDb.inserts[0]!.conflict).toBe("update");
    });

    it("suppresses the whole address when the user record is gone", async () => {
      // Over-honouring the request is the safe direction.
      mockDb.queueSelect([]);
      const res = createMockRes();

      await handlers.unsubscribe(
        createMockReq(),
        res,
        ctx({ query: tokenQuery(claim({ topics: ["marketing"] })) }),
      );

      expect(res.statusCode).toBe(200);
      expect(mockDb.inserts[0]!.table).toBe(suppressions);
    });

    it("rejects a forged token without writing anything", async () => {
      const forged = signUnsubscribeToken(claim(), "some-other-secret-entirely");
      const res = createMockRes();

      await handlers.unsubscribe(
        createMockReq(),
        res,
        ctx({ query: new URLSearchParams({ token: forged }) }),
      );

      expect(res.statusCode).toBe(400);
      expect(mockDb.inserts).toHaveLength(0);
    });

    it("rejects a tampered claim, so nobody can unsubscribe a stranger", async () => {
      const token = signUnsubscribeToken(claim(), SECRET);
      const [payload, mac] = token.split(".");
      const otherPayload = Buffer.from(
        JSON.stringify({ p: "proj_1", u: "victim", c: "email", t: "victim@example.com", k: [] }),
      ).toString("base64url");
      expect(otherPayload).not.toBe(payload);
      const res = createMockRes();

      await handlers.unsubscribe(
        createMockReq(),
        res,
        ctx({ query: new URLSearchParams({ token: `${otherPayload}.${mac}` }) }),
      );

      expect(res.statusCode).toBe(400);
      expect(mockDb.inserts).toHaveLength(0);
    });

    it("reports a 500 when the write fails, rather than claiming success", async () => {
      // Telling somebody they are unsubscribed when they are not is the worst
      // possible outcome here.
      mockDb.failWith(new Error("db down"));
      const res = createMockRes();

      await handlers.unsubscribe(createMockReq(), res, ctx({ query: tokenQuery() }));

      expect(res.statusCode).toBe(500);
      expect(res.body).toContain("could not record");
      expect(deps.logger.error).toHaveBeenCalled();
    });

    it("drains the request body so a keep-alive socket is not left with bytes on it", async () => {
      mockDb.queueSelect([{ id: "internal-uuid" }]);
      const req = createMockReq();

      await handlers.unsubscribe(req, createMockRes(), ctx({ query: tokenQuery() }));

      expect(req.resume).toHaveBeenCalled();
    });

    it("confirms the opt-out in the response body", async () => {
      mockDb.queueSelect([{ id: "internal-uuid" }]);
      const res = createMockRes();

      await handlers.unsubscribe(createMockReq(), res, ctx({ query: tokenQuery() }));

      expect(res.body).toContain("unsubscribed");
      expect(res.body).toContain("alice@example.com");
    });

    it("logs a warning diagnostic when UNSUBSCRIBE_SECRET is not configured during unsubscribe", async () => {
      delete process.env.UNSUBSCRIBE_SECRET;
      const res = createMockRes();

      await handlers.unsubscribe(createMockReq(), res, ctx({ query: tokenQuery() }));

      expect(res.statusCode).toBe(400);
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("UNSUBSCRIBE_SECRET is not configured"),
      );
    });

    it("logs a warning diagnostic when UNSUBSCRIBE_SECRET is not configured during unsubscribePage GET", async () => {
      delete process.env.UNSUBSCRIBE_SECRET;
      const res = createMockRes();

      await handlers.unsubscribePage(createMockReq(), res, ctx({ query: tokenQuery() }));

      expect(res.statusCode).toBe(400);
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("UNSUBSCRIBE_SECRET is not configured"),
      );
    });
  });
});
