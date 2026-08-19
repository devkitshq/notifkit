import { config } from "dotenv";
import { resolve } from "node:path";
import { z, type ZodTypeAny } from "zod";
import type { LanguageModel } from "ai";

import { ValidationError } from "@/index.js";

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
  ADMIN_API_KEY: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(10),
  QUEUE_MAX_LEN: z.coerce.number().int().min(1).default(10000000),
  DB_MAX_CONNECTIONS: z.coerce.number().int().min(1).default(2),
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
