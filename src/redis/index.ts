import { Redis, type RedisOptions } from "ioredis";
import type { Logger } from "@/index.js";

export interface RedisClientOptions {
  url: string;
  name?: string;
  logger?: Logger;
  redisOptions?: Partial<RedisOptions>;
}

export class RedisClient {
  readonly native: Redis;

  private readonly logger?: Logger;
  private isClosing = false;

  constructor({ url, name = "notifkit", logger, redisOptions }: RedisClientOptions) {
    this.logger = logger;

    this.native = new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
      connectionName: name,
      ...redisOptions,
    });

    this.native.on("connect", () => {
      this.logger?.info({ url: redactUrl(url) }, "redis connected");
    });

    this.native.on("ready", () => {
      this.logger?.debug("redis ready");
    });

    this.native.on("error", (err: Error) => {
      this.logger?.error({ err }, "redis client error");
    });

    this.native.on("close", () => {
      if (!this.isClosing) {
        this.logger?.warn("redis connection closed unexpectedly");
      }
    });

    this.native.on("reconnecting", () => {
      this.logger?.warn("redis reconnecting");
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const pong = await this.native.ping();
      return pong === "PONG";
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.isClosing) return;
    this.isClosing = true;
    this.logger?.info("disconnecting redis");
    try {
      if (this.native.status !== "end" && this.native.status !== "close") {
        await this.native.quit();
      }
    } catch {
      try {
        this.native.disconnect();
      } catch {
        // ignore errors on forced disconnect
      }
    }
    this.logger?.info("redis disconnected");
  }
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "[invalid-url]";
  }
}

export { Redis, type RedisOptions };
