import { randomUUID } from "node:crypto";
import { loadEnv, readBaseConfig } from "@/index.js";
import type { Logger } from "@/index.js";
import type { RedisClient, Redis } from "@/index.js";
import {
  type StreamConsumer,
  type PendingMessageScanner,
  StreamProducer,
  type StreamMessage,
} from "@/index.js";
import { BaseWorker, type ProcessResult } from "@/index.js";
import {
  STREAMS,
  ENRICHED_STREAMS,
  CONSUMER_GROUPS,
  PUBSUB_CHANNELS,
  registry,
  type EventRegistry,
  buildStreamEvent,
  type DispatchedTaskPayload,
  type StreamEvent,
} from "@/index.js";
import { IdempotencyGuard } from "@/index.js";
import { UserThrottle, ProjectSettingsCache } from "@/index.js";
import { TemplateRepository, ContactRepository, ProjectRepository } from "@/index.js";
import { suppressions } from "@/db/schema.js";
import { and, eq } from "drizzle-orm";
import {
  globalEmitter,
  normaliseTarget,
  type WorkerOptions,
  DataLoader,
  LRUCache,
} from "@/shared/index.js";
import { TemplateCache } from "@/templates/index.js";
import { buildUnsubscribeHeaders } from "@/unsubscribe/index.js";
import { scheduleOrDispatch } from "./schedule-or-dispatch.js";
import { startHealthReporter } from "@/workers/index.js";
import {
  createPriorityProducers,
  createStreamConsumer,
  createWorkerRuntime,
  shutdownWorker,
  uniqueConsumerId,
} from "@/workers/bootstrap.js";
import { isInQuietHours } from "./quiet-hours.js";

export { isInQuietHours };

/** Idempotency stand-in for inline messages; see EngineWorker.process. */
const NO_IDEMPOTENCY = {
  checkAndMark: async (_id: string, _ttl?: number) => true,
  markProcessed: async (_id: string, _ttl?: number) => {},
  unmark: async (_id: string) => {},
};

loadEnv();
const config = readBaseConfig();

let logger: Logger;
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
  registry: EventRegistry;
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
  private readonly registry: EventRegistry;
  private readonly idempotency: any;
  private readonly throttle: any;
  private readonly projectSettings: ProjectSettingsCache;
  private readonly templateCache: TemplateCache;
  private readonly aiPendingProducer: any;
  private readonly scheduledProducer: any;
  private readonly outboundProducers: any;
  private readonly globalEmitter: any;
  private readonly contactRepo: any;
  private readonly db: any;
  /** Delivery in this process, when the pipeline is fused. */
  private inlineNext: ((event: StreamEvent) => Promise<void>) | null = null;

  constructor(options: EngineWorkerOptions) {
    super(options);
    this.registry = options.registry;
    this.idempotency = options.idempotency;
    this.throttle = options.throttle;
    this.projectSettings = options.projectSettings;
    this.templateCache = options.templateCache;
    this.aiPendingProducer = options.aiPendingProducer;
    this.scheduledProducer = options.scheduledProducer;
    this.outboundProducers = options.outboundProducers;
    this.globalEmitter = options.globalEmitter;
    this.contactRepo = options.contactRepo;
    this.db = options.db;
  }

  /** Hands due tasks straight to `next` instead of the outbound stream. */
  setInlineNext(next: ((event: StreamEvent) => Promise<void>) | null): void {
    this.inlineNext = next;
  }

  private readonly contactsLoader = new DataLoader<
    { projectId: string; recipientId: string },
    any[]
  >(
    async (keys) => {
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
    },
    { batchDelayMs: 2, maxBatchSize: 500 },
  );

  // One query per (project, channel), not per address: a campaign is thousands
  // of sends on one channel. Cached 10s; webhooks that suppress lag far more.
  private readonly suppressionsCache = new LRUCache<string, Set<string>>(1000, 10_000);

  private readonly suppressionsLoader = new DataLoader<
    { projectId: string; channel: string },
    Set<string>
  >(async (keys) => {
    const results = new Map<string, Set<string>>();
    for (const key of keys) {
      const cacheKey = `${key.projectId}:${key.channel}`;
      if (results.has(cacheKey)) continue;

      const cached = this.suppressionsCache.get(cacheKey);
      if (cached !== undefined) {
        results.set(cacheKey, cached);
        continue;
      }

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
        const set = new Set<string>(rows.map((r: { target: string }) => normaliseTarget(r.target)));
        this.suppressionsCache.set(cacheKey, set);
        results.set(cacheKey, set);
      } catch (err) {
        // Failing open here would mail people who opted out.
        this.logger.error(
          { err, projectId: key.projectId, channel: key.channel },
          "suppression lookup failed — holding message",
        );
        throw err;
      }
    }
    return keys.map((key) => results.get(`${key.projectId}:${key.channel}`) ?? new Set<string>());
  });

  async process(message: StreamMessage): Promise<ProcessResult> {
    const { event } = message;

    const payloadResult = this.registry.safeParsePayload("notification.enriched", event.payload);
    if (!payloadResult.success) {
      this.logger.warn(
        { messageId: message.id, issues: payloadResult.error.issues },
        "invalid notification.enriched payload — skipping",
      );
      return;
    }

    const enriched = payloadResult.data;

    // One event per resolved contact, so two addresses on a channel are two messages.
    const idempotencyKey =
      `${enriched.rawEventId}:${enriched.recipientId}:${enriched.channel}` +
      (enriched.contactId ? `:${enriched.contactId}` : "");
    let customTtl: number | undefined;
    if (enriched.scheduledAt) {
      const msUntil = new Date(enriched.scheduledAt).getTime() - Date.now();
      if (msUntil > 0) {
        // Held until the send is due, then as long as any other marker.
        customTtl = config.IDEMPOTENCY_TTL_SECONDS + Math.ceil(msUntil / 1000);
      }
    }

    // Inline runs are already exclusive under the enricher's lock and delivery's lease.
    const idempotency = message.inline ? NO_IDEMPOTENCY : this.idempotency;

    // A short lease: if this process dies, the redelivery must not find it.
    if (!(await idempotency.checkAndMark(idempotencyKey, 60))) {
      this.logger.debug({ messageId: message.id, eventId: event.id }, "duplicate — skipping");
      return;
    }

    try {
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
        await idempotency.markProcessed(idempotencyKey, customTtl);
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
        await idempotency.markProcessed(idempotencyKey, customTtl);
        return;
      }

      const qh = enriched.recipient.preferences.quietHours;
      if (qh && qh.length > 0 && enriched.priority !== "critical") {
        // Judged at send time, so a send booked for next week isn't pulled forward.
        const requestedAt = enriched.scheduledAt ? new Date(enriched.scheduledAt) : new Date();
        const sendAt = requestedAt.getTime() > Date.now() ? requestedAt : new Date();
        const qhResult = isInQuietHours(enriched.recipient.timezone, qh, sendAt);
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

      // A failed settings lookup falls back to the global default, never drops the send.
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

      // A channel fallback was counted when the notification was first sent.
      const throttleResult = enriched.throttleCounted
        ? { allowed: true, count: 0, limit: 0 }
        : await this.throttle.check(enriched.projectId, enriched.recipientId, enriched.priority, {
            limit: projectThrottle.throttleLimit,
            windowHours: projectThrottle.throttleWindowHours,
            scheduledAt: enriched.scheduledAt,
            // A replayed message must not be counted against the user twice.
            messageId: idempotencyKey,
          });
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
        await idempotency.markProcessed(idempotencyKey, customTtl);
        return;
      }

      // Template-level AI prompts, overridden by any on the request.
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
          await idempotency.markProcessed(idempotencyKey, customTtl);
          return;
        }
      }
      const aiPrompts = {
        ...(dbTemplate?.aiPrompts ?? {}),
        ...(enriched.aiPrompts ?? {}),
      };

      const templateTopics: string[] = dbTemplate?.topics ?? [];
      // AI sends pass the same gates below before going to the AI worker.
      const useAi = Object.keys(aiPrompts).length > 0;

      // The enricher already resolved the contact; only events without one
      // (push, channel fallbacks, the AI worker) need the user's contacts.
      const allContacts =
        enriched.contactId && enriched.destination
          ? [
              {
                id: enriched.contactId,
                channel: enriched.channel,
                target: enriched.destination,
                active: true,
              },
            ]
          : await this.contactsLoader.load({
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
        await idempotency.markProcessed(idempotencyKey, customTtl);
        return;
      }

      const suppressedTargets = await this.suppressionsLoader.load({
        projectId: enriched.projectId,
        channel: enriched.channel,
      });

      for (const contact of activeContacts) {
        // This address opted out of one of the template's topics.
        if (templateTopics.some((t) => contact.preferences?.topics?.[t] === false)) {
          continue;
        }

        // Suppression beats every other gate, `critical` included.
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

        // Only mail with a topic gets unsubscribe headers; no topic means transactional.
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

        const taskPayload: DispatchedTaskPayload = {
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
          destination: resolvedDestination,
          deliveryOptions: {
            maxAttempts: 3,
            timeoutMs: 10_000,
            ...(unsubscribeHeaders ? { headers: unsubscribeHeaders } : {}),
          },
          fallbackChain: enriched.fallbackChain,
          campaignId: enriched.campaignId,
          workflowInstanceId: enriched.workflowInstanceId,
        };

        if (useAi) {
          await this.aiPendingProducer.publish(
            buildStreamEvent(
              "notification.ai_pending",
              {
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
                taskId,
                destination: resolvedDestination,
                deliveryHeaders: unsubscribeHeaders,
                campaignId: enriched.campaignId,
                workflowInstanceId: enriched.workflowInstanceId,
              },
              "engine",
              event.metadata.traceId,
            ),
          );
          this.logger.debug(
            { messageId: message.id, taskId, traceId: event.metadata.traceId },
            "task routed to AI worker",
          );
          continue;
        }

        await scheduleOrDispatch(
          {
            db: this.db,
            scheduledProducer: this.scheduledProducer,
            outboundProducers: this.outboundProducers,
            logger: this.logger,
            inlineNext: this.inlineNext,
          },
          taskPayload,
          {
            source: "engine",
            scheduledAt: enriched.scheduledAt,
            messageId: message.id,
            traceId: event.metadata.traceId,
            logLevel: "debug",
            scheduledMessage: "task scheduled and payload cached",
            dispatchedMessage: "task dispatched",
          },
        );
      }
      await idempotency.markProcessed(idempotencyKey, customTtl);
    } catch (err) {
      await idempotency.unmark(idempotencyKey).catch(() => {});
      throw err;
    }
  }
}

let subscriber: any = null;

export async function startEngineWorker() {
  ({ logger, redis, sql, db } = createWorkerRuntime(config, "engine"));
  templateRepo = new TemplateRepository(db);
  templateCache = new TemplateCache(templateRepo);
  const contactRepo = new ContactRepository(db);
  if (!config.UNSUBSCRIBE_SECRET) {
    logger.warn(
      "UNSUBSCRIBE_SECRET is not configured — emails with topics are sent without RFC 8058 one-click unsubscribe headers",
    );
  }
  const consumerId = uniqueConsumerId("engine");
  ({ consumer, pendingScanner } = createStreamConsumer(
    { redis, logger },
    {
      stream: ENRICHED_STREAMS,
      group: CONSUMER_GROUPS.ENGINE,
      consumer: consumerId,
      batchSize: config.WORKER_CONCURRENCY,
      bufferAcks: true,
      coalesceMs: 2,
    },
  ));

  const outboundProducers = createPriorityProducers(redis.native, logger, "OUTBOUND");

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
    ttlSeconds: config.IDEMPOTENCY_TTL_SECONDS,
  });

  const throttle = new UserThrottle({
    redis: redis.native,
    maxPerHour: config.RATE_LIMIT_PER_HOUR,
  });

  // Read once per send, so cached; the pub/sub subscriber below drops stale entries early.
  const projectRepo = new ProjectRepository(db);
  const projectSettings = new ProjectSettingsCache((projectId) =>
    projectRepo.findThrottleSettings(projectId),
  );

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

  subscriber = redis.native.duplicate({ enableAutoPipelining: false });
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

  healthInterval = startHealthReporter("engine", worker, redis, logger);

  logger.info({ env: config.NODE_ENV }, "engine starting");
  await worker.start();
}

export function getEngineWorker(): EngineWorker | undefined {
  return worker as EngineWorker | undefined;
}

export async function stopEngineWorker(): Promise<void> {
  await shutdownWorker("engine", {
    logger,
    timers: [healthInterval],
    subscriber,
    worker,
    sql,
    redis,
  });
  healthInterval = null;
  subscriber = null;
}
