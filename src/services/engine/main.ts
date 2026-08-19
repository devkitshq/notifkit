import { randomUUID } from "node:crypto";
import { loadEnv, readBaseConfig } from "@/index.js";
import { createLogger } from "@/index.js";
import { RedisClient, type Redis } from "@/index.js";
import {
  StreamConsumer,
  PendingMessageScanner,
  StreamProducer,
  type StreamMessage,
} from "@/index.js";
import { BaseWorker } from "@/index.js";
import {
  STREAMS,
  ENRICHED_STREAMS,
  CONSUMER_GROUPS,
  PUBSUB_CHANNELS,
  registry,
  buildStreamEvent,
  type NotificationEnrichedPayload,
  type NotificationDispatchedPayload,
} from "@/index.js";
import { type StreamName } from "@/contracts/streams.js";
import { IdempotencyGuard } from "@/index.js";
import { UserThrottle, ProjectSettingsCache } from "@/index.js";
import { TemplateRepository, ContactRepository, ProjectRepository } from "@/index.js";
import { createDatabase } from "@/db/index.js";
import { scheduledPayloads, suppressions } from "@/db/schema.js";
import { and, eq } from "drizzle-orm";
import {
  getPriorityBucket,
  globalEmitter,
  normaliseTarget,
  type WorkerOptions,
  DataLoader,
} from "@/shared/index.js";
import { renderWithTemplate, TemplateCache } from "@/templates/index.js";
import { buildUnsubscribeHeaders } from "@/unsubscribe/index.js";
import { startHealthReporter } from "@/workers/index.js";

function localTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
): Date {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  for (let iter = 0; iter < 3; iter++) {
    const parts = formatter.formatToParts(new Date(utcMs));
    const pYear = parseInt(parts.find((p) => p.type === "year")?.value ?? "0", 10);
    const pMonth = parseInt(parts.find((p) => p.type === "month")?.value ?? "0", 10);
    const pDay = parseInt(parts.find((p) => p.type === "day")?.value ?? "0", 10);
    const pHour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    const pMin = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
    const pSec = parseInt(parts.find((p) => p.type === "second")?.value ?? "0", 10);

    const targetMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const actualMs = Date.UTC(pYear, pMonth - 1, pDay, pHour, pMin, pSec);
    const diff = targetMs - actualMs;
    if (diff === 0) break;
    utcMs += diff;
  }
  return new Date(utcMs);
}

export function isInQuietHours(
  timezone: string,
  quietHours: { start: string; end: string }[],
  fromDate: Date = new Date(),
): { inQuietHours: boolean; nextActiveTime?: Date } {
  if (!quietHours || quietHours.length === 0) {
    return { inQuietHours: false };
  }

  const checkWindowAt = (date: Date) => {
    let parts: Intl.DateTimeFormatPart[];
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      parts = formatter.formatToParts(date);
    } catch {
      return null;
    }

    const year = parseInt(parts.find((p) => p.type === "year")?.value ?? "0", 10);
    const month = parseInt(parts.find((p) => p.type === "month")?.value ?? "0", 10);
    const day = parseInt(parts.find((p) => p.type === "day")?.value ?? "0", 10);
    const currentHour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    const currentMin = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);

    const currentMinutes = currentHour * 60 + currentMin;

    for (const window of quietHours) {
      const [startH, startM] = window.start.split(":").map(Number);
      const [endH, endM] = window.end.split(":").map(Number);

      if (startH === undefined || startM === undefined || endH === undefined || endM === undefined)
        continue;

      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;

      let inWindow = false;
      if (startMinutes <= endMinutes) {
        inWindow = currentMinutes >= startMinutes && currentMinutes < endMinutes;
      } else {
        inWindow = currentMinutes >= startMinutes || currentMinutes < endMinutes;
      }

      if (inWindow) {
        let targetYear = year;
        let targetMonth = month;
        let targetDay = day;

        if (currentMinutes >= endMinutes) {
          const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
          targetYear = nextDay.getUTCFullYear();
          targetMonth = nextDay.getUTCMonth() + 1;
          targetDay = nextDay.getUTCDate();
        }

        const nextActive = localTimeToUtc(
          targetYear,
          targetMonth,
          targetDay,
          endH,
          endM,
          0,
          timezone,
        );
        return { inQuietHours: true, nextActiveTime: nextActive };
      }
    }
    return { inQuietHours: false };
  };

  let initialCheck = checkWindowAt(fromDate);
  if (!initialCheck || !initialCheck.inQuietHours) {
    return { inQuietHours: false };
  }

  // Chained / overlapping quiet hours intervals
  let candidateTime = initialCheck.nextActiveTime!;
  for (let i = 0; i < 10; i++) {
    const subsequentCheck = checkWindowAt(candidateTime);
    if (subsequentCheck && subsequentCheck.inQuietHours && subsequentCheck.nextActiveTime) {
      if (subsequentCheck.nextActiveTime.getTime() <= candidateTime.getTime()) {
        break;
      }
      candidateTime = subsequentCheck.nextActiveTime;
    } else {
      break;
    }
  }

  return { inQuietHours: true, nextActiveTime: candidateTime };
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────

loadEnv();
const config = readBaseConfig();

let logger: ReturnType<typeof createLogger>;
let redis: RedisClient;
let sql: any;
let db: any;
let templateRepo: TemplateRepository;

let templateCache: TemplateCache;

let consumer: StreamConsumer;
let pendingScanner: PendingMessageScanner;
let worker: BaseWorker;
let healthInterval: NodeJS.Timeout | null = null;

export interface EngineWorkerOptions extends WorkerOptions {
  registry: any;
  idempotency: any;
  throttle: any;
  projectSettings: ProjectSettingsCache;
  redis: Redis;
  templateCache: TemplateCache;
  aiPendingProducer: any;
  scheduledProducer: any;
  outboundProducers: any;
  globalEmitter: any;
  contactRepo: any;
  db: any;
}

export class EngineWorker extends BaseWorker {
  private readonly registry: any;
  private readonly idempotency: any;
  private readonly throttle: any;
  private readonly projectSettings: ProjectSettingsCache;
  private readonly redisCli: Redis;
  private readonly templateCache: TemplateCache;
  private readonly aiPendingProducer: any;
  private readonly scheduledProducer: any;
  private readonly outboundProducers: any;
  private readonly globalEmitter: any;
  private readonly contactRepo: any;
  private readonly db: any;

  constructor(options: EngineWorkerOptions) {
    super(options);
    this.registry = options.registry;
    this.idempotency = options.idempotency;
    this.throttle = options.throttle;
    this.projectSettings = options.projectSettings;
    this.redisCli = options.redis;
    this.templateCache = options.templateCache;
    this.aiPendingProducer = options.aiPendingProducer;
    this.scheduledProducer = options.scheduledProducer;
    this.outboundProducers = options.outboundProducers;
    this.globalEmitter = options.globalEmitter;
    this.contactRepo = options.contactRepo;
    this.db = options.db;
  }

  private readonly contactsLoader = new DataLoader<
    { projectId: string; recipientId: string },
    any[]
  >(async (keys) => {
    const byProject = new Map<string, string[]>();
    for (const key of keys) {
      if (!byProject.has(key.projectId)) byProject.set(key.projectId, []);
      byProject.get(key.projectId)!.push(key.recipientId);
    }

    const resultsByProjectAndUser = new Map<string, Map<string, any[]>>();
    for (const [projectId, userIds] of byProject) {
      const activeContactsMap = await this.contactRepo.findActiveByUserIds(projectId, userIds);
      resultsByProjectAndUser.set(projectId, activeContactsMap);
    }

    return keys.map((key) => {
      const projectMap = resultsByProjectAndUser.get(key.projectId);
      if (!projectMap) return [];
      return projectMap.get(key.recipientId) || [];
    });
  });

  /**
   * Suppressed destinations for one (project, channel), as a normalised set.
   *
   * Loaded per project+channel rather than per address: a campaign is thousands
   * of messages against one channel, so this collapses to a single query for
   * the whole batch. Cached for the loader's lifetime of a tick, which means a
   * suppression written mid-batch takes effect on the next batch — acceptable,
   * since the webhook that writes it is itself minutes behind the send.
   */
  private readonly suppressionsLoader = new DataLoader<
    { projectId: string; channel: string },
    Set<string>
  >(async (keys) => {
    const results = new Map<string, Set<string>>();
    for (const key of keys) {
      const cacheKey = `${key.projectId}:${key.channel}`;
      if (results.has(cacheKey)) continue;
      try {
        const rows = await this.db
          .select({ target: suppressions.target })
          .from(suppressions)
          .where(
            and(
              eq(suppressions.projectId, key.projectId),
              eq(suppressions.channel, key.channel as any),
            ),
          );
        results.set(
          cacheKey,
          new Set(rows.map((r: { target: string }) => normaliseTarget(r.target))),
        );
      } catch (err) {
        // A suppression lookup that fails must not silently become "nothing
        // is suppressed" — that would resume mailing people who opted out.
        this.logger.error(
          { err, projectId: key.projectId, channel: key.channel },
          "suppression lookup failed — holding message",
        );
        throw err;
      }
    }
    return keys.map((key) => results.get(`${key.projectId}:${key.channel}`) ?? new Set<string>());
  });

  async process(message: StreamMessage): Promise<void> {
    const { event } = message;

    const payloadResult = this.registry.safeParsePayload("notification.enriched", event.payload);
    if (!payloadResult.success) {
      this.logger.warn(
        { messageId: message.id, issues: payloadResult.error.issues },
        "invalid notification.enriched payload — skipping",
      );
      return;
    }

    const enriched = payloadResult.data as NotificationEnrichedPayload;

    // Idempotency
    const idempotencyKey = `${enriched.rawEventId}:${enriched.recipientId}:${enriched.channel}`;
    let customTtl: number | undefined;
    if (enriched.scheduledAt) {
      const msUntil = new Date(enriched.scheduledAt).getTime() - Date.now();
      if (msUntil > 0) {
        // base 24h (86400) + schedule time
        customTtl = 86400 + Math.ceil(msUntil / 1000);
      }
    }

    if (!(await this.idempotency.checkAndMark(idempotencyKey, 60))) {
      this.logger.debug({ messageId: message.id, eventId: event.id }, "duplicate — skipping");
      return;
    }

    try {
      // Opt-in check
      if (enriched.recipient.preferences.optedOut) {
        this.logger.info(
          { messageId: message.id, recipientId: enriched.recipientId, eventType: event.type },
          "user opted out — dropping",
        );
        this.globalEmitter.emit("notification:skipped", {
          projectId: enriched.projectId,
          eventId: event.id,
          recipientId: enriched.recipientId,
          reason: "user_opted_out",
        });
        await this.idempotency.markProcessed(idempotencyKey, customTtl);
        return;
      }

      if (enriched.recipient.preferences.channels?.includes(enriched.channel)) {
        this.logger.info(
          { messageId: message.id, recipientId: enriched.recipientId, channel: enriched.channel },
          "user disabled notification channel — dropping",
        );
        this.globalEmitter.emit("notification:skipped", {
          projectId: enriched.projectId,
          eventId: event.id,
          recipientId: enriched.recipientId,
          reason: "channel_disabled",
        });
        await this.idempotency.markProcessed(idempotencyKey, customTtl);
        return;
      }

      // Quiet hours check
      const qh = enriched.recipient.preferences.quietHours;
      if (qh && qh.length > 0 && enriched.priority !== "critical") {
        const qhResult = isInQuietHours(enriched.recipient.timezone, qh);
        if (qhResult.inQuietHours && qhResult.nextActiveTime) {
          this.logger.info(
            {
              messageId: message.id,
              recipientId: enriched.recipientId,
              nextActiveTime: qhResult.nextActiveTime.toISOString(),
            },
            "user is in quiet hours — deferring notification",
          );
          enriched.scheduledAt = qhResult.nextActiveTime.toISOString();
        }
      }

      // Rate limit. Per-project overrides win over the process-wide default;
      // a lookup failure must not drop the notification, so fall back rather
      // than propagate.
      let projectThrottle: { throttleLimit: number | null; throttleWindowHours: number | null } = {
        throttleLimit: null,
        throttleWindowHours: null,
      };
      try {
        projectThrottle = await this.projectSettings.get(enriched.projectId);
      } catch (err) {
        this.logger.warn(
          { err, projectId: enriched.projectId },
          "could not read project throttle settings — falling back to the global default",
        );
      }

      const throttleResult = await this.throttle.check(
        enriched.projectId,
        enriched.recipientId,
        enriched.priority,
        {
          limit: projectThrottle.throttleLimit,
          windowHours: projectThrottle.throttleWindowHours,
          scheduledAt: enriched.scheduledAt,
        },
      );
      if (!throttleResult.allowed) {
        this.logger.info(
          {
            messageId: message.id,
            recipientId: enriched.recipientId,
            count: throttleResult.count,
            limit: throttleResult.limit,
            priority: enriched.priority,
          },
          "user throttled — dropping",
        );
        this.globalEmitter.emit(
          "notification:throttled",
          enriched.recipientId,
          throttleResult.count,
        );
        await this.idempotency.markProcessed(idempotencyKey, customTtl);
        return;
      }

      // Gather AI Prompts
      // Gather AI Prompts
      let dbTemplate = null;
      if (enriched.templateId) {
        dbTemplate = await this.templateCache.getCachedTemplate(
          enriched.projectId,
          enriched.templateId,
        );
        if (!dbTemplate) {
          this.logger.warn(
            { messageId: message.id, templateId: enriched.templateId },
            "template not found — dropping",
          );
          this.globalEmitter.emit("notification:skipped", {
            projectId: enriched.projectId,
            eventId: event.id,
            recipientId: enriched.recipientId,
            reason: "template_not_found",
          });
          await this.idempotency.markProcessed(idempotencyKey, customTtl);
          return;
        }
      }
      const aiPrompts = {
        ...(dbTemplate?.aiPrompts ?? {}),
        ...(enriched.aiPrompts ?? {}),
      };

      // Drives whether this message gets an unsubscribe header, and what the
      // resulting opt-out applies to.
      const templateTopics: string[] = dbTemplate?.topics ?? [];

      if (Object.keys(aiPrompts).length > 0) {
        const aiPendingPayload = {
          projectId: enriched.projectId,
          enrichedEventId: event.id,
          recipientId: enriched.recipientId,
          channel: enriched.channel,
          priority: enriched.priority,
          templateId: enriched.templateId,
          templateVariables: enriched.templateVariables,
          recipient: enriched.recipient,
          aiPrompts,
          scheduledAt: enriched.scheduledAt,
          fallbackChain: enriched.fallbackChain,
        };

        const aiPendingEnvelope = buildStreamEvent(
          "notification.ai_pending",
          aiPendingPayload as Record<string, unknown>,
          "engine",
          event.metadata.traceId,
        );

        await this.aiPendingProducer.publish(aiPendingEnvelope);
        this.logger.info(
          {
            messageId: message.id,
            eventId: event.id,
            recipientId: enriched.recipientId,
            traceId: event.metadata.traceId,
          },
          "task routed to AI worker",
        );
        await this.idempotency.markProcessed(idempotencyKey, customTtl);
        return;
      }

      // Render template
      const rendered = renderWithTemplate(dbTemplate, enriched.templateVariables);

      const allContacts = await this.contactsLoader.load({
        projectId: enriched.projectId,
        recipientId: enriched.recipientId,
      });
      const activeContacts = allContacts.filter(
        (c: any) => c.channel === enriched.channel && c.active,
      );

      if (activeContacts.length === 0) {
        this.logger.info(
          { messageId: message.id, recipientId: enriched.recipientId, channel: enriched.channel },
          "no active contacts for channel — dropping",
        );
        this.globalEmitter.emit("notification:skipped", {
          projectId: enriched.projectId,
          eventId: event.id,
          recipientId: enriched.recipientId,
          reason: "no_active_contacts",
        });
        await this.idempotency.markProcessed(idempotencyKey, customTtl);
        return;
      }

      const suppressedTargets = await this.suppressionsLoader.load({
        projectId: enriched.projectId,
        channel: enriched.channel,
      });

      for (const contact of activeContacts) {
        if (contact.preferences?.optedOut) {
          continue;
        }

        // A suppression outranks every other gate, `critical` included: it
        // records that the person asked us to stop, or that the address is
        // dead. Sending anyway is what gets a domain blocked.
        if (contact.target && suppressedTargets.has(normaliseTarget(contact.target))) {
          this.logger.info(
            {
              messageId: message.id,
              recipientId: enriched.recipientId,
              channel: enriched.channel,
            },
            "destination suppressed — dropping",
          );
          this.globalEmitter.emit("notification:skipped", {
            projectId: enriched.projectId,
            eventId: event.id,
            recipientId: enriched.recipientId,
            reason: "suppressed",
          });
          continue;
        }

        const taskId = `${enriched.rawEventId}:${contact.id || randomUUID()}`;
        const resolvedDestination = contact.target;

        // One-click unsubscribe headers, but only on mail that should carry
        // them. A template with no topic is transactional by this codebase's
        // own convention — a password reset, a receipt — and putting an
        // unsubscribe button on those invites people to switch off mail they
        // actually need, with no topic to scope the opt-out to anyway.
        if (
          enriched.channel === "email" &&
          templateTopics.length > 0 &&
          !config.UNSUBSCRIBE_SECRET
        ) {
          this.logger.warn(
            { projectId: enriched.projectId, recipientId: enriched.recipientId },
            "UNSUBSCRIBE_SECRET is not configured — email sent without RFC 8058 one-click unsubscribe headers",
          );
        }

        const unsubscribeHeaders =
          enriched.channel === "email" &&
          templateTopics.length > 0 &&
          config.UNSUBSCRIBE_SECRET &&
          config.PUBLIC_URL &&
          resolvedDestination
            ? buildUnsubscribeHeaders({
                claim: {
                  projectId: enriched.projectId,
                  userId: enriched.recipientId,
                  channel: enriched.channel,
                  target: resolvedDestination,
                  topics: templateTopics,
                },
                secret: config.UNSUBSCRIBE_SECRET,
                publicUrl: config.PUBLIC_URL,
              })
            : undefined;

        const taskPayload: NotificationDispatchedPayload = {
          projectId: enriched.projectId,
          taskId,
          enrichedEventId: event.id,
          recipientId: enriched.recipientId,
          channel: enriched.channel,
          priority: enriched.priority,
          templateId: enriched.templateId,
          templateVariables: enriched.templateVariables,
          aiPrompts: enriched.aiPrompts,
          recipient: enriched.recipient,
          renderedContent: rendered,
          destination: resolvedDestination,
          deliveryOptions: {
            maxAttempts: 3,
            timeoutMs: 10_000,
            ...(unsubscribeHeaders ? { headers: unsubscribeHeaders } : {}),
          },
          fallbackChain: enriched.fallbackChain,
          campaignId: enriched.campaignId,
        };

        const envelope = buildStreamEvent(
          "notification.dispatched",
          taskPayload as Record<string, unknown>,
          "engine",
          event.metadata.traceId,
        );

        // Route by scheduledAt
        const now = Date.now();
        const scheduledAt = enriched.scheduledAt ? new Date(enriched.scheduledAt).getTime() : now;

        if (scheduledAt > now) {
          await this.db
            .insert(scheduledPayloads)
            .values({
              taskId,
              payload: {
                ...taskPayload,
                scheduledAt: enriched.scheduledAt,
              },
            })
            .onConflictDoNothing();

          const scheduledEnvelope = buildStreamEvent(
            "notification.scheduled",
            {
              projectId: enriched.projectId,
              enrichedEventId: event.id,
              taskId,
              scheduledAt: enriched.scheduledAt!,
            },
            "engine",
            event.metadata.traceId,
          );

          await this.scheduledProducer.publish(scheduledEnvelope);
          this.logger.info(
            {
              messageId: message.id,
              taskId,
              scheduledAt: enriched.scheduledAt,
              traceId: event.metadata.traceId,
            },
            "task scheduled and payload cached",
          );
        } else {
          const p = getPriorityBucket(enriched.priority);
          const outboundProducer = this.outboundProducers[p] ?? this.outboundProducers["normal"]!;

          await outboundProducer.publish(envelope);
          this.logger.info(
            {
              messageId: message.id,
              taskId,
              recipientId: enriched.recipientId,
              traceId: event.metadata.traceId,
            },
            "task dispatched",
          );
        }
      }
      await this.idempotency.markProcessed(idempotencyKey, customTtl);
    } catch (err) {
      await this.idempotency.unmark(idempotencyKey).catch(() => {});
      throw err;
    }
  }
}

let subscriber: any = null;

export async function startEngineWorker() {
  logger = createLogger({ name: "engine", level: config.LOG_LEVEL });
  redis = new RedisClient({ url: config.REDIS_URL, name: "engine", logger });
  const dbData = createDatabase({ url: config.DATABASE_URL, applicationName: "engine", logger });
  sql = dbData.sql;
  db = dbData.db;
  templateRepo = new TemplateRepository(db);
  templateCache = new TemplateCache(templateRepo);
  const contactRepo = new ContactRepository(db);
  consumer = new StreamConsumer({
    redis: redis.native,
    stream: ENRICHED_STREAMS as unknown as StreamName[],
    group: CONSUMER_GROUPS.ENGINE,
    consumer: `engine-${process.pid}`,
    dlqStream: STREAMS.DEAD_LETTER,
    batchSize: config.WORKER_CONCURRENCY,
    logger,
  });

  pendingScanner = new PendingMessageScanner({
    redis: redis.native,
    stream: ENRICHED_STREAMS as unknown as StreamName[],
    group: CONSUMER_GROUPS.ENGINE,
    consumer: `engine-${process.pid}`,
    logger,
  });

  const outboundProducers = {
    critical: new StreamProducer({
      redis: redis.native,
      stream: STREAMS.OUTBOUND_CRITICAL,
      logger,
    }),
    normal: new StreamProducer({ redis: redis.native, stream: STREAMS.OUTBOUND_NORMAL, logger }),
    low: new StreamProducer({ redis: redis.native, stream: STREAMS.OUTBOUND_LOW, logger }),
  };

  const scheduledProducer = new StreamProducer({
    redis: redis.native,
    stream: STREAMS.SCHEDULED,
    logger,
  });

  const aiPendingProducer = new StreamProducer({
    redis: redis.native,
    stream: STREAMS.AI_PENDING,
    logger,
  });

  const idempotency = new IdempotencyGuard({
    redis: redis.native,
    keyPrefix: "notif:processed:engine",
    ttlSeconds: 86_400,
  });

  const throttle = new UserThrottle({
    redis: redis.native,
    maxPerHour: parseInt(process.env.RATE_LIMIT_PER_HOUR || "100", 10),
  });

  // Per-project throttle overrides, cached because this is read once per
  // notification. Stale entries expire on their own; the pub/sub subscriber
  // below only makes an admin's change take effect sooner.
  const projectRepo = new ProjectRepository(db);
  const projectSettings = new ProjectSettingsCache((projectId) =>
    projectRepo.findThrottleSettings(projectId),
  );

  // ─── Stage 2: Decision Engine ───────────────────────────────────────────────
  //
  // Pipeline:
  //  1. Parse payload as notification.enriched
  //  2. Idempotency check
  //  3. Check user opt-in (from enriched recipient.preferences)
  //  4. Apply per-user hourly rate limit
  //  5. Render template using user locale
  //  6. Route: if scheduledAt is future → SCHEDULED; else → OUTBOUND

  worker = new EngineWorker({
    consumer,
    pendingScanner,
    logger,
    concurrency: config.WORKER_CONCURRENCY,
    registry,
    idempotency,
    throttle,
    projectSettings,
    redis: redis.native,
    templateCache,
    aiPendingProducer,
    scheduledProducer,
    outboundProducers,
    globalEmitter,
    contactRepo,
    db,
  });

  subscriber = redis.native.duplicate();
  await subscriber.subscribe(
    PUBSUB_CHANNELS.TEMPLATE_INVALIDATED,
    PUBSUB_CHANNELS.PROJECT_INVALIDATED,
  );
  subscriber.on("message", (channel: string, message: string) => {
    if (channel === PUBSUB_CHANNELS.TEMPLATE_INVALIDATED) {
      templateCache.invalidateKey(message);
      logger.info({ cacheKey: message }, "invalidated template cache");
    } else if (channel === PUBSUB_CHANNELS.PROJECT_INVALIDATED) {
      projectSettings.invalidate(message);
      logger.info({ projectId: message }, "invalidated project settings cache");
    }
  });

  // ─── Health check interval ──────────────────────────────────────────────────

  healthInterval = startHealthReporter("engine", worker, redis, logger);

  logger.info({ env: config.NODE_ENV }, "engine starting");
  await worker.start();
}

// ─── Shutdown ──────────────────────────────────────────────────────────────

export async function stopEngineWorker(): Promise<void> {
  logger?.info("shutdown initiated");
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
  if (subscriber) {
    subscriber.disconnect();
    subscriber = null;
  }
  if (worker) await worker.stop();
  if (sql) await sql.end();
  if (redis) await redis.disconnect();
  logger?.info("engine stopped");
}
