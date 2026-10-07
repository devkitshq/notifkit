import { config } from "dotenv";
import { resolve } from "node:path";
import { z, type ZodTypeAny } from "zod";
import type { LanguageModel } from "ai";

import { ValidationError } from "@/shared/index.js";

export function loadEnv(path?: string): void {
  const envPath = path ?? resolve(process.cwd(), ".env");
  config({ path: envPath, override: false });
}

export function parseConfig<TSchema extends ZodTypeAny>(
  schema: TSchema,
  data: unknown,
): z.output<TSchema> {
  const result = schema.safeParse(data);

  if (!result.success) {
    const fields: Record<string, string[]> = {};

    for (const issue of result.error.issues) {
      const key = issue.path.join(".");
      fields[key] ??= [];
      fields[key].push(issue.message);
    }

    throw new ValidationError("Configuration validation failed", fields);
  }

  return result.data;
}

export const baseConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().default("127.0.0.1"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  DATABASE_URL: z.string().url().default("postgres://platform:platform@localhost:5432/notifkit"),
  // Trimmed because the incoming bearer token is trimmed before comparison, so
  // an untrimmed value here could never match it. `set KEY=value && cmd` on
  // Windows puts a trailing space in the variable, which otherwise turns every
  // admin request into a 401 that reads like a wrong key.
  ADMIN_API_KEY: z.string().trim().optional(),
  ADMIN_EMAIL: z.string().trim().email().optional(),
  ADMIN_PASSWORD: z.string().trim().min(6).optional(),
  ADMIN_USERNAME: z.string().trim().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(10),
  /** In-flight sends per delivery worker. Defaults to WORKER_CONCURRENCY. */
  DELIVERY_CONCURRENCY: z.coerce.number().int().min(1).optional(),
  /**
   * When enricher, engine and delivery run in the same process, hand
   * single-recipient notifications from stage to stage in memory instead of
   * through the enriched/outbound streams. See `NotifkitOptions.fusedPipeline`.
   */
  PIPELINE_FUSED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  QUEUE_MAX_LEN: z.coerce.number().int().min(1).default(100000),
  /**
   * How long the pipeline remembers it handled a message, so a redelivery
   * after a crash is not sent twice. It only has to outlast redelivery (about
   * ten minutes) plus however far behind the streams run; a caller's own
   * X-Idempotency-Key is always kept for 24 hours regardless. These markers
   * are most of Redis memory under load, so the cost of a longer window is
   * real: a few hundred bytes per message for as long as it lasts.
   */
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().min(60).default(3600),
  DB_MAX_CONNECTIONS: z.coerce.number().int().min(1).default(2),
  /**
   * PostgreSQL schema that holds notifkit's tables and enum types. Defaults to
   * `public`. Any other value makes migrations create every object in that
   * schema and sets `search_path` on every connection, so notifkit can share a
   * database with an application that owns `public`.
   */
  DB_SCHEMA: z
    .string()
    .trim()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/, "must be a lowercase PostgreSQL identifier")
    .default("public"),
  LOG_FLUSH_INTERVAL_MS: z.coerce.number().int().min(50).default(500),
  LOG_BUFFER_MAX_SIZE: z.coerce.number().int().min(100).default(5000),
  SEGMENT_MAX_USERS: z.coerce.number().int().min(1).default(10000),
  /**
   * Externally reachable base URL of this API. Unsubscribe links are built from
   * it, so it must be what an inbox can actually reach — not `HOST`/`PORT`,
   * which describe the bind address behind your proxy.
   */
  PUBLIC_URL: z.string().url().optional(),
  /**
   * Signing key for unsubscribe tokens. Rotating it invalidates every
   * unsubscribe link already sitting in someone's inbox, so treat it as
   * permanent: a dead link means the recipient reaches for the spam button
   * instead, which costs far more than the key ever protected.
   */
  UNSUBSCRIBE_SECRET: z.string().min(16).optional(),
  /**
   * When true, trusts X-Forwarded-For headers from reverse proxies for client IP resolution.
   * Defaults to false to prevent client-spoofed headers from bypassing rate limits.
   */
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  /**
   * Comma-separated list of allowed origins for CORS on session-authenticated admin routes.
   */
  CORS_ORIGIN: z.string().optional(),
});

export type BaseConfig = z.infer<typeof baseConfigSchema>;

let globalConfig: BaseConfig | null = null;

export function setGlobalConfig(config: BaseConfig) {
  globalConfig = config;
}

export function readBaseConfig(data: NodeJS.ProcessEnv = process.env): BaseConfig {
  if (globalConfig) {
    return globalConfig;
  }
  return parseConfig(baseConfigSchema, data);
}

export interface RateLimitConfig {
  limit: number;
  windowSeconds: number;
}

export interface AiConfig {
  aiModel?: LanguageModel;
  /** Hard cap on generated tokens per prompt. Bounds cost and email size. */
  maxOutputTokens?: number;
  /** Wall-clock budget for a single generation before it is aborted. */
  timeoutMs?: number;
  /** Max prompts executed for one notification. */
  maxPromptsPerNotification?: number;
}

export const AI_DEFAULTS = {
  maxOutputTokens: 1_000,
  timeoutMs: 30_000,
  maxPromptsPerNotification: 5,
} as const;

let globalAiConfig: AiConfig = {};

export function setAiConfig(config: AiConfig) {
  globalAiConfig = config;
}

export function getAiConfig(): AiConfig {
  return globalAiConfig;
}
