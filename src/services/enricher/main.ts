import { loadEnv, readBaseConfig } from "@/index.js";
import { createLogger } from "@/index.js";
import { RedisClient } from "@/index.js";
import {
  StreamConsumer,
  PendingMessageScanner,
  StreamProducer,
  type StreamMessage,
} from "@/index.js";
import { BaseWorker } from "@/index.js";
import {
  STREAMS,
  INBOUND_STREAMS,
  CONSUMER_GROUPS,
  registry,
  buildStreamEvent,
  type NotificationCreatedPayload,
  type NotificationEnrichedPayload,
} from "@/index.js";
import { type StreamName } from "@/contracts/streams.js";
import { IdempotencyGuard } from "@/index.js";
import { createDatabase } from "@/db/index.js";
import {
  UserRepository,
  PreferenceRepository,
  TemplateRepository,
  ContactRepository,
} from "@/index.js";
import { TemplateCache } from "@/templates/index.js";
import { getPriorityBucket, type WorkerOptions } from "@/shared/index.js";
import { startHealthReporter } from "@/workers/index.js";

// ─── Bootstrap ─────────────────────────────────────────────────────────────

loadEnv();
const config = readBaseConfig();

let logger: ReturnType<typeof createLogger>;
let redis: RedisClient;
let sql: any;
let db: any;

let consumer: StreamConsumer;
let pendingScanner: PendingMessageScanner;
let worker: BaseWorker;
let healthInterval: NodeJS.Timeout | null = null;

export interface EnricherWorkerOptions extends WorkerOptions {
  producers: any;
  idempotency: any;
  userRepo: any;
  prefRepo: any;
  contactRepo: any;
  templateCache: TemplateCache;
}

export class EnricherWorker extends BaseWorker {
  private readonly producers: any;
  private readonly idempotency: any;
  private readonly userRepo: any;
  private readonly prefRepo: any;
  private readonly contactRepo: any;
  private readonly templateCache: TemplateCache;

  private userBatch: {
    projectId: string;
    userId: string;
    resolve: (p: any) => void;
    reject: (e: any) => void;
  }[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private eventBuffer: {
    producer: any;
    event: any;
    resolve: () => void;
    reject: (e: any) => void;
  }[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  private contactBatch: {
    projectId: string;
    userIds: string[];
    resolve: (c: Map<string, any[]>) => void;
    reject: (e: any) => void;
  }[] = [];
  private contactBatchTimer: NodeJS.Timeout | null = null;

  private async loadContacts(projectId: string, userIds: string[]): Promise<Map<string, any[]>> {
    return new Promise((resolve, reject) => {
      this.contactBatch.push({ projectId, userIds, resolve, reject });
      if (this.contactBatch.length >= 500) {
        if (this.contactBatchTimer) clearTimeout(this.contactBatchTimer);
        void this.flushContactBatch();
      } else if (!this.contactBatchTimer) {
        this.contactBatchTimer = setTimeout(() => void this.flushContactBatch(), 10);
      }
    });
  }

  private async flushContactBatch(): Promise<void> {
    const batch = this.contactBatch;
    this.contactBatch = [];
    this.contactBatchTimer = null;
    if (batch.length === 0) return;

    try {
      const byProject = new Map<string, typeof batch>();
      for (const b of batch) {
        if (!byProject.has(b.projectId)) byProject.set(b.projectId, []);
        byProject.get(b.projectId)!.push(b);
      }

      for (const [projectId, items] of byProject) {
        const userIds = Array.from(new Set(items.flatMap((i) => i.userIds)));
        const contactsMap = await this.contactRepo.findActiveByUserIds(projectId, userIds);
        for (const item of items) {
          item.resolve(contactsMap);
        }
      }
    } catch (err) {
      for (const b of batch) b.reject(err);
    }
  }

  constructor(options: EnricherWorkerOptions) {
    super(options);
    this.producers = options.producers;
    this.idempotency = options.idempotency;
    this.userRepo = options.userRepo;
    this.prefRepo = options.prefRepo;
    this.contactRepo = options.contactRepo;
    this.templateCache = options.templateCache;

    this.flushTimer = setInterval(() => void this.flushWorkerBuffers(), 100);
  }

  override async stop(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.contactBatchTimer) {
      clearTimeout(this.contactBatchTimer);
      this.contactBatchTimer = null;
    }
    await this.flushContactBatch();
    await this.flushUserBatch();
    await this.flushWorkerBuffers();
    await super.stop();
  }

  private async flushWorkerBuffers(): Promise<void> {
    if (this.eventBuffer.length === 0) return;
    const events = this.eventBuffer;
    this.eventBuffer = [];

    try {
      const byProducer = new Map<any, typeof events>();
      for (const e of events) {
        if (!byProducer.has(e.producer)) byProducer.set(e.producer, []);
        byProducer.get(e.producer)!.push(e);
      }
      for (const [producer, batch] of byProducer) {
        await producer.publishBatch(batch.map((b) => b.event));
        for (const b of batch) b.resolve();
      }
    } catch (err: any) {
      this.logger.error({ err }, "failed to flush events in EnricherWorker");
      for (const e of events) e.reject(err);
    }
  }

  private async loadUser(projectId: string, userId: string): Promise<any> {
    return new Promise((resolve, reject) => {
      this.userBatch.push({ projectId, userId, resolve, reject });
      if (this.userBatch.length >= 500) {
        if (this.batchTimer) clearTimeout(this.batchTimer);
        void this.flushUserBatch();
      } else if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => {
          void this.flushUserBatch();
        }, 10);
      }
    });
  }

  private async flushUserBatch() {
    const batch = this.userBatch;
    this.userBatch = [];
    this.batchTimer = null;

    const byProject = new Map<string, typeof batch>();
    for (const b of batch) {
      if (!byProject.has(b.projectId)) byProject.set(b.projectId, []);
      byProject.get(b.projectId)!.push(b);
    }

    for (const [projectId, reqs] of byProject.entries()) {
      try {
        const uniqueIds = Array.from(new Set(reqs.map((r) => r.userId)));
        const profiles = await this.userRepo.findRecordsByIds(projectId, uniqueIds);
        const profileMap = new Map(profiles.map((p: any) => [p.userId, p]));

        for (const req of reqs) {
          req.resolve(profileMap.get(req.userId) || null);
        }
      } catch (err) {
        for (const req of reqs) req.reject(err);
      }
    }
  }

  async process(message: StreamMessage): Promise<void> {
    const { event } = message;
    const publishPromises: Promise<void>[] = [];

    let isRequested = true;
    const requestedResult = registry.safeParsePayload("notification.requested", event.payload);
    let createdResult: any = null;
    if (!requestedResult.success) {
      createdResult = registry.safeParsePayload("notification.created", event.payload);
      isRequested = false;
    }

    if (!isRequested && (!createdResult || !createdResult.success)) {
      const issues = createdResult
        ? createdResult.error.issues
        : (requestedResult as any).error.issues;
      this.logger.warn({ messageId: message.id, issues }, "invalid payload — skipping");
      return;
    }

    // Handle legacy notification.created
    if (!isRequested) {
      const raw = createdResult.data as NotificationCreatedPayload;
      const dedupeId = `${raw.projectId}:${raw.idempotencyKey ?? event.id}`;
      if (!(await this.idempotency.checkAndMark(dedupeId, 60))) return;
      try {
        const profile = await this.userRepo.findRecordById(raw.projectId, raw.recipientId);
        if (!profile) return;

        const prefs = await this.prefRepo.findByUserId(raw.projectId, raw.recipientId);
        const optedOutTypes = new Set(
          prefs.filter((p: any) => !p.optedIn).map((p: any) => p.eventType),
        );

        const enrichedPayload: NotificationEnrichedPayload = {
          projectId: raw.projectId,
          rawEventId: event.id,
          recipientId: raw.recipientId,
          channel: raw.channel,
          priority: raw.priority,
          templateId: raw.templateId,
          templateVariables: raw.payload,
          recipient: {
            id: profile.userId,
            email: profile.email ?? undefined,
            locale: profile.language ?? "en",
            timezone: profile.timezone ?? "UTC",
            preferences: {
              optedOut:
                optedOutTypes.has(event.type) || profile.preferences.topics?.[event.type] === false,
              channels: Object.entries(profile.preferences.channels ?? {})
                .filter(([_, enabled]) => !enabled)
                .map(([channel]) => channel as any),
              quietHours: profile.preferences.quietHours,
            },
          },
          // No campaignId: this is the legacy `notification.created` path,
          // which predates campaigns and carries no label to attribute to.
          scheduledAt: raw.scheduledAt,
        };

        const p = getPriorityBucket(raw.priority);
        const producer = this.producers[p] ?? this.producers["normal"]!;

        publishPromises.push(
          new Promise((resolve, reject) => {
            this.eventBuffer.push({
              producer,
              event: buildStreamEvent(
                "notification.enriched",
                enrichedPayload as Record<string, unknown>,
                "enricher",
                event.metadata.traceId,
              ),
              resolve,
              reject,
            });
          }),
        );
        this.logger.info(
          { messageId: message.id, eventId: event.id, recipientId: raw.recipientId },
          "event enriched",
        );
      } catch (err) {
        throw err;
      }
      await Promise.all(publishPromises).catch(async (err) => {
        await this.idempotency.unmark(dedupeId).catch(() => {});
        throw err;
      });
      await this.idempotency.markProcessed(dedupeId);
      return;
    }

    // Handle new notification.requested
    const raw = (requestedResult as any).data;
    const dedupeId = `${raw.projectId}:${raw.idempotencyKey ?? event.id}`;
    if (!(await this.idempotency.checkAndMark(dedupeId, 60))) return;
    try {
      let userIds: string[] = [];
      if (raw.target.type === "user") {
        userIds = [raw.target.userId];
      } else if (raw.target.type === "segment") {
        userIds = await this.userRepo.findUsersBySegment(raw.projectId, raw.target.segment);
        this.logger.info(
          { segment: raw.target.segment, count: userIds.length },
          "Resolved segment",
        );
      } else if (raw.target.type === "topic") {
        userIds = await this.userRepo.findUsersByTopic(raw.projectId, raw.target.topic);
        this.logger.info({ topic: raw.target.topic, count: userIds.length }, "Resolved topic");
      } else {
        this.logger.warn({ target: raw.target }, "Segment/topic resolution not fully implemented");
        // Stub: maybe resolve later
      }

      const maxUsers = readBaseConfig().SEGMENT_MAX_USERS;
      if (userIds.length > maxUsers) {
        this.logger.error(
          { count: userIds.length, max: maxUsers, projectId: raw.projectId, eventId: event.id },
          "Segment fan-out exceeds maximum allowed limit",
        );
        const p = getPriorityBucket(raw.priority ?? "normal");
        const producer = this.producers[p] ?? this.producers.normal;
        await producer.publish(
          buildStreamEvent(
            "notification.failed",
            {
              projectId: raw.projectId,
              rawEventId: event.id,
              error: `Segment fan-out of ${userIds.length} exceeds limit of ${maxUsers}`,
            },
            "enricher",
            event.metadata.traceId,
          ),
        );
        return;
      }

      // Topic opt-outs are keyed on the TEMPLATE's topics, not the envelope type.
      // `event.type` here is "notification.requested", which no user ever sets a
      // preference against, so keying on it silently disabled every opt-out.
      const template = raw.templateId
        ? await this.templateCache.getCachedTemplate(raw.projectId, raw.templateId)
        : null;
      const topics: string[] = template?.topics ?? [];

      const channels =
        raw.channels && raw.channels.length > 0 ? raw.channels : (["email"] as any[]);
      const isFallback = (raw as any).fallback === true;

      // If fallback is true, we only emit the first channel, and pass the rest in fallbackChain.
      // If fallback is false, we emit all channels concurrently.
      const channelsToProcess = isFallback ? [channels[0]] : channels;
      const fallbackChain = isFallback ? channels.slice(1) : undefined;

      const chunkArray = <T>(arr: T[], size: number) =>
        Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
          arr.slice(i * size, i * size + size),
        );

      const chunks = chunkArray(userIds, 500);

      for (const chunk of chunks) {
        const profiles = (
          await Promise.all(chunk.map((id) => this.loadUser(raw.projectId, id)))
        ).filter(Boolean);
        const contactsByUser = await this.loadContacts(
          raw.projectId,
          profiles.map((profile: any) => profile.userId),
        );

        const batchedEvents: Record<
          "critical" | "high" | "normal" | "low",
          Omit<any, "id" | "timestamp">[]
        > = {
          critical: [],
          high: [],
          normal: [],
          low: [],
        };

        for (const profile of profiles) {
          for (const channel of channelsToProcess) {
            const contacts = contactsByUser.get(profile.userId) ?? [];
            const channelContacts = contacts.filter((contact: any) => contact.channel === channel);
            // Push resolves its active tokens at send time so token invalidation
            // remains current. Other channels need one task per address.
            const destinations =
              channel === "push" ? [undefined] : channelContacts.map((c: any) => c.target);
            if (destinations.length === 0) {
              this.logger.info(
                { recipientId: profile.userId, channel },
                "no active contact for channel",
              );
              continue;
            }
            for (const destination of destinations) {
              const enrichedPayload: NotificationEnrichedPayload = {
                projectId: raw.projectId,
                rawEventId: event.id,
                recipientId: profile.userId,
                channel: channel,
                priority: "normal",
                templateId: raw.templateId,
                templateVariables: raw.data,
                aiPrompts: raw.aiPrompts,
                recipient: {
                  id: profile.userId,
                  email:
                    channel === "email"
                      ? (destination ?? profile.email ?? undefined)
                      : (profile.email ?? undefined),
                  phone: channel === "sms" ? destination : undefined,
                  webhook: channel === "webhook" ? destination : undefined,
                  locale: profile.language ?? "en",
                  timezone: profile.timezone ?? "UTC",
                  preferences: {
                    // Opted out if the user disabled ANY topic this template carries.
                    optedOut: topics.some((t) => profile.preferences.topics?.[t] === false),
                    channels: Object.entries(profile.preferences.channels ?? {})
                      .filter(([_, enabled]) => !enabled)
                      .map(([channel]) => channel as any),
                    quietHours: profile.preferences.quietHours,
                  },
                },
                scheduledAt: raw.scheduledAt,
                fallbackChain: fallbackChain?.length ? fallbackChain : undefined,
                campaignId: raw.campaignId,
              };

              const msgPriority = raw.priority ?? "normal";
              const p = getPriorityBucket(msgPriority);

              enrichedPayload.priority = msgPriority;

              batchedEvents[p].push(
                buildStreamEvent(
                  "notification.enriched",
                  enrichedPayload as Record<string, unknown>,
                  "enricher",
                  event.metadata.traceId,
                ),
              );
            }
          }
        }

        for (const p of ["critical", "normal", "low"] as const) {
          if (batchedEvents[p].length > 0) {
            const producer = this.producers[p] ?? this.producers.normal;
            for (const ev of batchedEvents[p]) {
              publishPromises.push(
                new Promise((resolve, reject) => {
                  this.eventBuffer.push({ producer, event: ev, resolve, reject });
                }),
              );
            }
          }
        }
      }

      this.logger.info(
        {
          messageId: message.id,
          eventId: event.id,
          target: raw.target.type,
          traceId: event.metadata.traceId,
        },
        "event enriched",
      );
    } catch (err) {
      throw err;
    }

    await Promise.all(publishPromises).catch(async (err) => {
      await this.idempotency.unmark(dedupeId).catch(() => {});
      throw err;
    });

    await this.idempotency.markProcessed(dedupeId);
  }
}

export async function startEnricherWorker() {
  logger = createLogger({ name: "enricher", level: config.LOG_LEVEL });
  redis = new RedisClient({ url: config.REDIS_URL, name: "enricher", logger });
  const dbData = createDatabase({ url: config.DATABASE_URL, applicationName: "enricher", logger });
  sql = dbData.sql;
  db = dbData.db;
  consumer = new StreamConsumer({
    redis: redis.native,
    stream: INBOUND_STREAMS as unknown as StreamName[],
    group: CONSUMER_GROUPS.ENRICHER,
    consumer: `enricher-${process.pid}`,
    dlqStream: STREAMS.DEAD_LETTER,
    batchSize: config.WORKER_CONCURRENCY,
    logger,
  });

  pendingScanner = new PendingMessageScanner({
    redis: redis.native,
    stream: INBOUND_STREAMS as unknown as StreamName[],
    group: CONSUMER_GROUPS.ENRICHER,
    consumer: `enricher-${process.pid}`,
    logger,
  });

  const producers = {
    critical: new StreamProducer({
      redis: redis.native,
      stream: STREAMS.ENRICHED_CRITICAL,
      logger,
    }),
    normal: new StreamProducer({ redis: redis.native, stream: STREAMS.ENRICHED_NORMAL, logger }),
    low: new StreamProducer({ redis: redis.native, stream: STREAMS.ENRICHED_LOW, logger }),
  };

  const idempotency = new IdempotencyGuard({
    redis: redis.native,
    keyPrefix: "notif:processed:enricher",
    ttlSeconds: 86_400,
  });

  const userRepo = new UserRepository(db);
  const prefRepo = new PreferenceRepository(db);
  const contactRepo = new ContactRepository(db);
  const templateCache = new TemplateCache(new TemplateRepository(db));

  // ─── Stage 1: Context Enricher ──────────────────────────────────────────────
  //
  // Pipeline:
  //  1. Parse payload as notification.created
  //  2. Idempotency check — drop if already processed
  //  3. Load user profile (language, timezone) from DB
  //  4. Load all stored preferences for this user
  //  5. Publish notification.enriched to ENRICHED stream

  //  5. Publish notification.enriched to ENRICHED stream

  worker = new EnricherWorker({
    consumer,
    pendingScanner,
    logger,
    maxRetriesBeforeDlq: 5,
    concurrency: config.WORKER_CONCURRENCY,
    producers,
    idempotency,
    userRepo,
    prefRepo,
    contactRepo,
    templateCache,
  });

  // ─── Health check interval ──────────────────────────────────────────────────

  healthInterval = startHealthReporter("enricher", worker, redis, logger);

  logger.info({ env: config.NODE_ENV }, "enricher starting");
  await worker.start();
}

// ─── Shutdown ──────────────────────────────────────────────────────────────

export async function stopEnricherWorker(): Promise<void> {
  logger?.info("shutdown initiated");
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
  if (worker) await worker.stop();
  if (sql) await sql.end();
  if (redis) await redis.disconnect();
  logger?.info("enricher stopped");
}
