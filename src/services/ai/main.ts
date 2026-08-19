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
  CONSUMER_GROUPS,
  registry,
  buildStreamEvent,
  type NotificationAiPendingPayload,
  type NotificationDispatchedPayload,
  getAiConfig,
  AI_DEFAULTS,
} from "@/index.js";
import { generateText } from "ai";
import { type StreamName } from "@/contracts/streams.js";
import { IdempotencyGuard } from "@/index.js";
import { TemplateRepository } from "@/index.js";
import { createDatabase } from "@/db/index.js";
import { scheduledPayloads } from "@/db/schema.js";
import { getPriorityBucket, globalEmitter, type WorkerOptions } from "@/shared/index.js";
import { renderWithTemplate, TemplateCache } from "@/templates/index.js";
import { startHealthReporter } from "@/workers/index.js";

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
let subscriber: any = null;

/**
 * A model failure that retrying cannot fix (bad prompt, rejected request,
 * unsupported model). Thrown so the notification fails once instead of being
 * re-billed on every retry.
 */
export class PermanentAiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermanentAiError";
  }
}

/** Timeouts, rate limits and 5xx are worth another attempt; 4xx are not. */
export function isRetryableAiError(err: unknown): boolean {
  if (err instanceof PermanentAiError) return false;

  const e = err as { name?: string; statusCode?: number; status?: number } | null;
  if (!e) return false;

  if (e.name === "TimeoutError" || e.name === "AbortError") return true;

  const status = e.statusCode ?? e.status;
  if (typeof status === "number") {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }

  // Unclassifiable (network errors, transport failures) — assume transient.
  return true;
}

export interface AiWorkerOptions extends WorkerOptions {
  registry: any;
  idempotency: any;
  redis: Redis;
  generateAiContent: any;
  templateCache: TemplateCache;
  scheduledProducer: any;
  outboundProducers: any;
  db: any;
}

export class AiWorker extends BaseWorker {
  private readonly registry: any;
  private readonly idempotency: any;
  private readonly redisCli: Redis;
  private readonly generateAiContent: any;
  private readonly templateCache: TemplateCache;
  private readonly scheduledProducer: any;
  private readonly outboundProducers: any;
  private readonly db: any;

  constructor(options: AiWorkerOptions) {
    super(options);
    this.registry = options.registry;
    this.idempotency = options.idempotency;
    this.redisCli = options.redis;
    this.generateAiContent = options.generateAiContent;
    this.templateCache = options.templateCache;
    this.scheduledProducer = options.scheduledProducer;
    this.outboundProducers = options.outboundProducers;
    this.db = options.db;
  }
  async process(message: StreamMessage): Promise<void> {
    const { event } = message;

    const payloadResult = this.registry.safeParsePayload("notification.ai_pending", event.payload);
    if (!payloadResult.success) {
      this.logger.warn(
        { messageId: message.id, issues: payloadResult.error.issues },
        "invalid notification.ai_pending payload — skipping",
      );
      return;
    }

    const pending = payloadResult.data as NotificationAiPendingPayload;

    // Idempotency
    const idempotencyKey = `${pending.enrichedEventId}:${pending.recipientId}:${pending.channel}:ai`;
    if (!(await this.idempotency.checkAndMark(idempotencyKey))) {
      this.logger.debug(
        { messageId: message.id, eventId: event.id },
        "duplicate ai task — skipping",
      );
      return;
    }
    try {
      // Execute AI prompts. Each key is a separate billed model call, so the
      // count is capped rather than being driven by whatever the caller sent.
      const promptEntries = Object.entries(pending.aiPrompts);
      const maxPrompts =
        getAiConfig().maxPromptsPerNotification ?? AI_DEFAULTS.maxPromptsPerNotification;
      if (promptEntries.length > maxPrompts) {
        this.logger.warn(
          { messageId: message.id, requested: promptEntries.length, maxPrompts },
          "aiPrompts exceeds the per-notification cap — extra prompts ignored",
        );
      }

      const generatedVars: Record<string, string> = {};
      for (const [key, prompt] of promptEntries.slice(0, maxPrompts)) {
        generatedVars[key] = await this.generateAiContent(prompt, pending.templateVariables);
      }

      // Merge generated vars with original template vars
      const finalVars = { ...pending.templateVariables, ...generatedVars };

      const dbTemplate = pending.templateId
        ? await this.templateCache.getCachedTemplate(pending.projectId, pending.templateId)
        : null;

      const rendered = renderWithTemplate(dbTemplate, finalVars);

      const taskId = randomUUID();
      const destination =
        pending.channel === "email"
          ? pending.recipient.email
          : pending.channel === "sms"
            ? pending.recipient.phone
            : pending.channel === "webhook"
              ? pending.recipient.webhook
              : pending.channel === "push"
                ? (pending.recipient.pushTokens?.[0] ?? pending.recipient.pushToken)
                : undefined;
      const resolvedDestination =
        destination ?? (pending.channel === "push" ? undefined : pending.recipientId);

      const taskPayload: NotificationDispatchedPayload = {
        projectId: pending.projectId,
        taskId,
        enrichedEventId: pending.enrichedEventId,
        recipientId: pending.recipientId,
        channel: pending.channel,
        priority: pending.priority,
        templateId: pending.templateId,
        templateVariables: pending.templateVariables,
        aiPrompts: pending.aiPrompts,
        recipient: pending.recipient,
        renderedContent: rendered,
        destination: resolvedDestination,
        deliveryOptions: {
          maxAttempts: 3,
          timeoutMs: 10_000,
        },
        fallbackChain: pending.fallbackChain,
      };

      const envelope = buildStreamEvent(
        "notification.dispatched",
        taskPayload as Record<string, unknown>,
        "ai-worker",
        event.metadata.traceId,
      );

      // Route by scheduledAt
      const now = Date.now();
      const scheduledAt = pending.scheduledAt ? new Date(pending.scheduledAt).getTime() : now;

      if (scheduledAt > now) {
        await this.db.insert(scheduledPayloads).values({
          taskId,
          payload: taskPayload,
        });

        const scheduledEnvelope = buildStreamEvent(
          "notification.scheduled",
          {
            projectId: pending.projectId,
            enrichedEventId: pending.enrichedEventId,
            taskId,
            scheduledAt: pending.scheduledAt!,
          },
          "ai-worker",
          event.metadata.traceId,
        );

        await this.scheduledProducer.publish(scheduledEnvelope);
        this.logger.info(
          {
            messageId: message.id,
            taskId,
            scheduledAt: pending.scheduledAt,
            traceId: event.metadata.traceId,
          },
          "task scheduled and payload cached after AI generation",
        );
      } else {
        const p = getPriorityBucket(pending.priority);
        const outboundProducer = this.outboundProducers[p] ?? this.outboundProducers["normal"]!;

        await outboundProducer.publish(envelope);
        this.logger.info(
          {
            messageId: message.id,
            taskId,
            recipientId: pending.recipientId,
            traceId: event.metadata.traceId,
          },
          "task dispatched after AI generation",
        );
      }
    } catch (err) {
      await this.idempotency.unmark(idempotencyKey);
      if (err instanceof PermanentAiError || (err as Error)?.name === "PermanentAiError") {
        // Retrying re-bills the same failing prompt. Fail the notification once.
        this.logger.error(
          { err, messageId: message.id, recipientId: pending.recipientId },
          "AI generation failed permanently — dropping notification without retry",
        );
        globalEmitter.emit(
          "notification:failed",
          pending.enrichedEventId,
          (err as Error).message,
          pending.channel,
        );
        return;
      }
      throw err;
    }
  }
}

export async function startAiWorker() {
  logger = createLogger({ name: "ai", level: config.LOG_LEVEL });
  redis = new RedisClient({ url: config.REDIS_URL, name: "ai", logger });
  const dbData = createDatabase({ url: config.DATABASE_URL, applicationName: "ai", logger });
  sql = dbData.sql;
  db = dbData.db;
  templateRepo = new TemplateRepository(db);
  templateCache = new TemplateCache(templateRepo);
  consumer = new StreamConsumer({
    redis: redis.native,
    stream: STREAMS.AI_PENDING as StreamName,
    group: CONSUMER_GROUPS.AI,
    consumer: `ai-${process.pid}`,
    dlqStream: STREAMS.DEAD_LETTER,
    batchSize: config.WORKER_CONCURRENCY,
    logger,
  });

  pendingScanner = new PendingMessageScanner({
    redis: redis.native,
    stream: STREAMS.AI_PENDING as StreamName,
    group: CONSUMER_GROUPS.AI,
    consumer: `ai-${process.pid}`,
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

  const idempotency = new IdempotencyGuard({
    redis: redis.native,
    keyPrefix: "notif:processed:ai",
    ttlSeconds: 86_400,
  });

  // AI generation
  async function generateAiContent(prompt: string, vars: Record<string, unknown>): Promise<string> {
    const aiConfig = getAiConfig();
    const interpolated = prompt.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? ""));

    if (!aiConfig || !aiConfig.aiModel) {
      logger.warn("AI worker called but no AI model was provided to NotifkitServer");
      return `[AI Disabled] ${interpolated}`;
    }

    const maxOutputTokens = aiConfig.maxOutputTokens ?? AI_DEFAULTS.maxOutputTokens;
    const timeoutMs = aiConfig.timeoutMs ?? AI_DEFAULTS.timeoutMs;

    try {
      const { text } = await generateText({
        model: aiConfig.aiModel,
        prompt: interpolated,
        maxOutputTokens,
        abortSignal: AbortSignal.timeout(timeoutMs),
      });

      return text;
    } catch (err) {
      // BaseWorker retries a throw up to maxRetriesBeforeDlq, and every retry is
      // another billed call. Only re-throw for failures a retry could actually
      // fix; a malformed prompt or a rejected request must not be re-billed.
      if (isRetryableAiError(err)) {
        logger.error({ err }, "AI generation failed (transient) — will retry");
        throw err;
      }
      throw new PermanentAiError(err instanceof Error ? err.message : String(err), { cause: err });
    }
  }

  worker = new AiWorker({
    consumer,
    pendingScanner,
    logger,
    concurrency: config.WORKER_CONCURRENCY,
    registry,
    idempotency,
    redis: redis.native,
    generateAiContent,
    templateCache,
    scheduledProducer,
    outboundProducers,
    db,
  });

  subscriber = redis.native.duplicate();
  await subscriber.subscribe("template.invalidated");
  subscriber.on("message", (channel: string, message: string) => {
    if (channel === "template.invalidated") {
      templateCache.invalidateKey(message);
      logger.info({ cacheKey: message }, "invalidated template cache");
    }
  });

  healthInterval = startHealthReporter("ai", worker, redis, logger);

  logger.info({ env: config.NODE_ENV, redis: config.REDIS_URL }, "ai starting");
  await worker.start();
}

export async function stopAiWorker(): Promise<void> {
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
  logger?.info("ai stopped");
}
