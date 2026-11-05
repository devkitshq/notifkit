import { randomUUID } from "node:crypto";
import { loadEnv, readBaseConfig } from "@/index.js";
import type { Logger } from "@/index.js";
import type { RedisClient } from "@/index.js";
import { type StreamConsumer, type PendingMessageScanner, type StreamMessage } from "@/index.js";
import { BaseWorker, type ProcessResult } from "@/index.js";
import {
  INBOUND_STREAMS,
  CONSUMER_GROUPS,
  registry,
  buildStreamEvent,
  type NotificationCreatedPayload,
  type NotificationEnrichedPayload,
  type NotificationChannel,
  type StreamEvent,
} from "@/index.js";
import { IdempotencyGuard } from "@/index.js";
import { UserRepository, TemplateRepository, ContactRepository } from "@/index.js";
import { TemplateCache } from "@/templates/index.js";
import { getPriorityBucket, globalEmitter, type WorkerOptions } from "@/shared/index.js";
import { startHealthReporter } from "@/workers/index.js";
import {
  createPriorityProducers,
  createStreamConsumer,
  createWorkerRuntime,
  shutdownWorker,
  uniqueConsumerId,
} from "@/workers/bootstrap.js";

loadEnv();
const config = readBaseConfig();

const chunkArray = <T>(arr: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, i * size + size),
  );

// A caller's own idempotency key is promised 24 h; an event id only needs to outlive redelivery.
const CALLER_KEY_TTL_SECONDS = 86_400;
const dedupeTtl = (raw: { idempotencyKey?: string }) =>
  raw.idempotencyKey ? CALLER_KEY_TTL_SECONDS : undefined;

let logger: Logger;
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
  prefRepo?: any;
  contactRepo: any;
  templateCache: TemplateCache;
}

export class EnricherWorker extends BaseWorker {
  private readonly producers: any;
  private readonly idempotency: any;
  private readonly userRepo: any;
  private readonly contactRepo: any;
  private readonly templateCache: TemplateCache;
  /** Engine in this process, when the pipeline is fused. See `setInlineNext`. */
  private inlineNext: ((event: StreamEvent) => Promise<void>) | null = null;

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
      if (this.contactBatch.length >= Math.min(this.concurrency, 50)) {
        if (this.contactBatchTimer) clearTimeout(this.contactBatchTimer);
        void this.flushContactBatch();
      } else if (!this.contactBatchTimer) {
        this.contactBatchTimer = setTimeout(() => void this.flushContactBatch(), 5);
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
    this.contactRepo = options.contactRepo;
    this.templateCache = options.templateCache;

    this.flushTimer = setInterval(() => void this.flushWorkerBuffers(), 5);
  }

  /**
   * Single-user notifications skip the enriched stream. Fan-outs keep it, since an
   * inline chain holds this worker's slot until its last send completes.
   */
  setInlineNext(next: ((event: StreamEvent) => Promise<void>) | null): void {
    this.inlineNext = next;
  }

  override async stop(): Promise<void> {
    // Keep the flush timers until in-flight messages settle; they wait on them.
    await super.stop();
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
      if (this.userBatch.length >= Math.min(this.concurrency, 50)) {
        if (this.batchTimer) clearTimeout(this.batchTimer);
        void this.flushUserBatch();
      } else if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => {
          void this.flushUserBatch();
        }, 5);
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

  async process(message: StreamMessage): Promise<ProcessResult> {
    const { event } = message;
    const publishPromises: Promise<void>[] = [];

    let isRequested = true;
    const requestedResult = registry.safeParsePayload("notification.requested", event.payload);
    let createdResult: any = null;
    if (!requestedResult.success) {
      // @deprecated fallback to the legacy `notification.created` payload (see below).
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

    /**
     * Legacy `notification.created` path.
     * @deprecated Nothing in notifkit publishes `notification.created` any more;
     * this branch only serves callers writing straight to the inbound stream.
     * Removed in the next minor version.
     */
    if (!isRequested) {
      const raw = createdResult.data as NotificationCreatedPayload;
      const dedupeId = `${raw.projectId}:${raw.idempotencyKey ?? event.id}`;
      if (!(await this.idempotency.checkAndMark(dedupeId, 60))) return;
      try {
        const profile = await this.userRepo.findRecordById(raw.projectId, raw.recipientId);
        if (!profile) return;

        // Opt-outs are keyed on the template's topics, not the event type.
        const template = raw.templateId
          ? await this.templateCache.getCachedTemplate(raw.projectId, raw.templateId)
          : null;
        const topics: string[] = template?.topics ?? [];

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
              optedOut: topics.some((t) => profile.preferences.topics?.[t] === false),
              channels: Object.entries(profile.preferences.channels ?? {})
                .filter(([_, enabled]) => !enabled)
                .map(([channel]) => channel as any),
              quietHours: profile.preferences.quietHours,
            },
          },
          // The legacy payload has no campaign.
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
        this.logger.debug(
          { messageId: message.id, eventId: event.id, recipientId: raw.recipientId },
          "event enriched",
        );
      } catch (err) {
        await this.idempotency.unmark(dedupeId).catch(() => {});
        throw err;
      }
      await Promise.all(publishPromises).catch(async (err) => {
        await this.idempotency.unmark(dedupeId).catch(() => {});
        throw err;
      });
      await this.idempotency.markProcessed(dedupeId, dedupeTtl(raw));
      return;
    }

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
      }

      const maxUsers = readBaseConfig().SEGMENT_MAX_USERS;
      if (userIds.length > maxUsers) {
        const reason = `Segment fan-out of ${userIds.length} exceeds limit of ${maxUsers}`;
        this.logger.error(
          { count: userIds.length, max: maxUsers, projectId: raw.projectId, eventId: event.id },
          "Segment fan-out exceeds maximum allowed limit",
        );
        // Reported via the emitter: the engine can't read a failure on the enriched stream.
        globalEmitter.emit("notification:failed", event.id, reason, event.type);
        await this.idempotency.markProcessed(dedupeId, dedupeTtl(raw));
        return;
      }

      // Opt-outs are keyed on the template's topics, not the event type.
      const template = raw.templateId
        ? await this.templateCache.getCachedTemplate(raw.projectId, raw.templateId)
        : null;
      const topics: string[] = template?.topics ?? [];

      const channels: NotificationChannel[] =
        raw.channels && raw.channels.length > 0 ? raw.channels : ["email"];
      const isFallback = (raw as any).fallback === true;

      const chunks = chunkArray(userIds, 500);
      const inline = raw.target.type === "user" ? this.inlineNext : null;

      for (const chunk of chunks) {
        const profiles = (
          await Promise.all(chunk.map((id) => this.loadUser(raw.projectId, id)))
        ).filter(Boolean);
        const contactsByUser = await this.loadContacts(
          raw.projectId,
          profiles.map((profile: any) => profile.userId),
        );

        const batchedEvents: Record<
          "critical" | "normal" | "low",
          Omit<any, "id" | "timestamp">[]
        > = {
          critical: [],
          normal: [],
          low: [],
        };

        for (const profile of profiles) {
          const contacts = contactsByUser.get(profile.userId) ?? [];
          // The user's addresses on a channel, minus those opted out of this template's topics.
          const usable = (channel: string) =>
            contacts.filter(
              (contact: any) =>
                contact.channel === channel &&
                !topics.some((t) => contact.preferences?.topics?.[t] === false),
            );

          // With fallback, start at the first reachable channel and chain the rest behind it.
          let userChannels: NotificationChannel[] = channels;
          let fallbackChain: NotificationChannel[] | undefined;
          if (isFallback) {
            const first = channels.findIndex((c: NotificationChannel) => usable(c).length > 0);
            if (first === -1) {
              this.logger.info(
                { recipientId: profile.userId, channels },
                "no active contact on any fallback channel",
              );
              continue;
            }
            userChannels = [channels[first]!];
            fallbackChain = channels.slice(first + 1);
          }

          for (const channel of userChannels) {
            const channelContacts = usable(channel);
            // Push resolves its tokens at send time; other channels get one task per address.
            const resolved: ({ id: string; target: string } | undefined)[] =
              channel === "push" ? [undefined] : channelContacts;
            if (resolved.length === 0) {
              this.logger.info(
                { recipientId: profile.userId, channel },
                "no active contact for channel",
              );
              continue;
            }
            for (const contact of resolved) {
              const destination = contact?.target;
              const enrichedPayload: NotificationEnrichedPayload = {
                projectId: raw.projectId,
                rawEventId: event.id,
                recipientId: profile.userId,
                channel,
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
                  phone: channel === "sms" || channel === "whatsapp" ? destination : undefined,
                  webhook: channel === "webhook" ? destination : undefined,
                  telegram: channel === "telegram" ? destination : undefined,
                  discord: channel === "discord" ? destination : undefined,
                  slack: channel === "slack" ? destination : undefined,
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
                // Saves the engine a second contacts read.
                contactId: contact?.id,
                destination,
                campaignId: raw.campaignId,
                workflowInstanceId: raw.workflowInstanceId,
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
              if (inline) {
                publishPromises.push(
                  inline({
                    ...ev,
                    id: randomUUID(),
                    timestamp: new Date().toISOString(),
                  } as StreamEvent),
                );
                continue;
              }
              publishPromises.push(
                new Promise((resolve, reject) => {
                  this.eventBuffer.push({ producer, event: ev, resolve, reject });
                }),
              );
            }
            if (this.eventBuffer.length >= Math.min(this.concurrency, 50)) {
              void this.flushWorkerBuffers();
            }
          }
        }
      }

      this.logger.debug(
        {
          messageId: message.id,
          eventId: event.id,
          target: raw.target.type,
          traceId: event.metadata.traceId,
        },
        "event enriched",
      );
    } catch (err) {
      // Release the marker, or the retry is acked as a duplicate.
      await this.idempotency.unmark(dedupeId).catch(() => {});
      throw err;
    }

    await Promise.all(publishPromises).catch(async (err) => {
      await this.idempotency.unmark(dedupeId).catch(() => {});
      throw err;
    });

    await this.idempotency.markProcessed(dedupeId, dedupeTtl(raw));
  }
}

export async function startEnricherWorker() {
  ({ logger, redis, sql, db } = createWorkerRuntime(config, "enricher"));
  // Fused, the enricher's slot is held through delivery, so it needs delivery's concurrency.
  const enricherConcurrency = config.PIPELINE_FUSED
    ? Math.max(config.WORKER_CONCURRENCY, config.DELIVERY_CONCURRENCY ?? config.WORKER_CONCURRENCY)
    : config.WORKER_CONCURRENCY;
  const consumerId = uniqueConsumerId("enricher");
  ({ consumer, pendingScanner } = createStreamConsumer(
    { redis, logger },
    {
      stream: INBOUND_STREAMS,
      group: CONSUMER_GROUPS.ENRICHER,
      consumer: consumerId,
      batchSize: enricherConcurrency,
      bufferAcks: true,
      coalesceMs: 2,
    },
  ));

  const producers = createPriorityProducers(redis.native, logger, "ENRICHED");

  const idempotency = new IdempotencyGuard({
    redis: redis.native,
    keyPrefix: "notif:processed:enricher",
    ttlSeconds: config.IDEMPOTENCY_TTL_SECONDS,
  });

  const userRepo = new UserRepository(db);
  const contactRepo = new ContactRepository(db);
  const templateCache = new TemplateCache(new TemplateRepository(db));

  worker = new EnricherWorker({
    consumer,
    pendingScanner,
    logger,
    maxRetriesBeforeDlq: 5,
    concurrency: enricherConcurrency,
    producers,
    idempotency,
    userRepo,
    contactRepo,
    templateCache,
  });

  healthInterval = startHealthReporter("enricher", worker, redis, logger);

  logger.info({ env: config.NODE_ENV }, "enricher starting");
  await worker.start();
}

export function getEnricherWorker(): EnricherWorker | undefined {
  return worker as EnricherWorker | undefined;
}

export async function stopEnricherWorker(): Promise<void> {
  await shutdownWorker("enricher", { logger, timers: [healthInterval], worker, sql, redis });
  healthInterval = null;
}
