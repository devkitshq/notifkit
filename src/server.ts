import { EventEmitter } from "node:events";
import { registerTransport, type Transport } from "./transport/index.js";
import { globalEmitter } from "./shared/index.js";
import { createLogger, type Logger } from "./logger/index.js";
import type { LanguageModel } from "ai";

export interface NotifkitOptions {
  redisUrl?: string;
  databaseUrl?: string;
  port?: number;
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  nodeEnv?: "development" | "test" | "production";
  services: (
    "api" | "delivery" | "engine" | "enricher" | "scheduler" | "ai" | "workflow" | "events" | "all"
  )[];
  providers?: Transport[];
  autoMigrate?: boolean;
  aiModel?: LanguageModel;
  workerConcurrency?: number;
  redisOptions?: {
    maxQueueLength?: number;
  };
  dbOptions?: {
    maxConnections?: number;
  };
}

export class NotifkitServer extends EventEmitter {
  private options: NotifkitOptions;
  private pgContainer: any = null;
  private redisContainer: any = null;
  private eventCleanupFns: (() => void)[] = [];
  private signalHandlersAttached = false;
  private logger: Logger;

  constructor(options: NotifkitOptions) {
    super();
    this.options = options;
    this.logger = createLogger({
      name: "server",
      level: options.logLevel || (process.env.LOG_LEVEL as any) || "info",
    });

    // Forward worker/API events to the server instance
    const eventNames = [
      "delivery:delivered",
      "delivery:failed",
      "notification:throttled",
      "notification:failed",
      "notification:skipped",
      "notification:canceled",
    ];
    for (const name of eventNames) {
      const listener = (...args: any[]) => {
        this.emit(name, ...args);
      };
      globalEmitter.on(name, listener);
      this.eventCleanupFns.push(() => {
        globalEmitter.off(name, listener);
      });
    }
  }

  async start() {
    // 1. Initial configuration setup for environment overrides
    const { setGlobalConfig, readBaseConfig } = await import("./config/index.js");
    if (this.options.port) process.env.PORT = String(this.options.port);
    if (this.options.logLevel) process.env.LOG_LEVEL = this.options.logLevel;
    if (this.options.nodeEnv) process.env.NODE_ENV = this.options.nodeEnv;
    if (this.options.workerConcurrency)
      process.env.WORKER_CONCURRENCY = String(this.options.workerConcurrency);
    if (this.options.redisOptions?.maxQueueLength)
      process.env.QUEUE_MAX_LEN = String(this.options.redisOptions.maxQueueLength);
    if (this.options.dbOptions?.maxConnections)
      process.env.DB_MAX_CONNECTIONS = String(this.options.dbOptions.maxConnections);

    const isProduction = process.env.NODE_ENV === "production";

    // 2. Spin up test containers if needed (only in development/test)
    if (!this.options.redisUrl) {
      if (process.env.REDIS_URL) {
        this.options.redisUrl = process.env.REDIS_URL;
      } else if (!isProduction) {
        this.logger.info(
          "No redisUrl provided, spinning up Redis container for development/testing...",
        );
        const { RedisContainer } = await import("@testcontainers/redis");
        this.redisContainer = await new RedisContainer("redis:alpine").start();
        this.options.redisUrl = this.redisContainer.getConnectionUrl();
      } else {
        throw new Error(
          "Missing required configuration: REDIS_URL must be provided when running in production mode.",
        );
      }
    }

    if (!this.options.databaseUrl) {
      if (process.env.DATABASE_URL) {
        this.options.databaseUrl = process.env.DATABASE_URL;
      } else if (!isProduction) {
        this.logger.info(
          "No databaseUrl provided, spinning up PostgreSQL container for development/testing...",
        );
        const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
        this.pgContainer = await new PostgreSqlContainer("postgres:15-alpine").start();
        this.options.databaseUrl = this.pgContainer.getConnectionUri();
      } else {
        throw new Error(
          "Missing required configuration: DATABASE_URL must be provided when running in production mode.",
        );
      }
    }

    if (this.options.redisUrl) process.env.REDIS_URL = this.options.redisUrl;
    if (this.options.databaseUrl) process.env.DATABASE_URL = this.options.databaseUrl;

    // 3. Set global config overrides
    const finalConfig = readBaseConfig();
    setGlobalConfig(finalConfig);
    if (this.options.aiModel) {
      const { setAiConfig } = await import("./config/index.js");
      setAiConfig({ aiModel: this.options.aiModel });
    }

    // 4. Run database migrations if enabled
    if (this.options.autoMigrate !== false) {
      this.logger.info("Running database migrations...");
      const { createDatabase, runMigrations } = await import("./db/index.js");
      const { db, sql } = createDatabase({ url: this.options.databaseUrl! });
      await runMigrations(db);
      await sql.end();
      this.logger.info("Database migrations complete");
    }

    const services = this.options.services.includes("all")
      ? ["api", "delivery", "engine", "enricher", "scheduler", "ai", "workflow", "events"]
      : this.options.services;

    if (this.options.providers) {
      for (const provider of this.options.providers) {
        registerTransport(provider);
      }
      this.logger.info(`Registered ${this.options.providers.length} custom providers`);
    }

    const startupPromises: Promise<any>[] = [];

    if (services.includes("api")) {
      const { startApiServer } = await import("./services/api/main.js");
      startupPromises.push(startApiServer());
    }

    if (services.includes("delivery")) {
      const { startDeliveryWorker } = await import("./services/delivery/main.js");
      startupPromises.push(startDeliveryWorker());
    }

    if (services.includes("engine")) {
      const { startEngineWorker } = await import("./services/engine/main.js");
      startupPromises.push(startEngineWorker());
    }

    if (services.includes("enricher")) {
      const { startEnricherWorker } = await import("./services/enricher/main.js");
      startupPromises.push(startEnricherWorker());
    }

    if (services.includes("scheduler")) {
      const { startSchedulerWorker } = await import("./services/scheduler/main.js");
      startupPromises.push(startSchedulerWorker());
    }

    if (services.includes("ai")) {
      const { startAiWorker } = await import("./services/ai/main.js");
      startupPromises.push(startAiWorker());
    }

    if (services.includes("workflow")) {
      const { startWorkflowWorker } = await import("./services/workflow/main.js");
      startupPromises.push(startWorkflowWorker());
    }

    if (services.includes("events")) {
      const { startEventWorker } = await import("./services/events/main.js");
      startupPromises.push(startEventWorker());
    }

    const handleSignal = async (signal: string) => {
      this.logger.info(`Received ${signal}, starting graceful shutdown...`);
      await this.stop();
      process.exit(0);
    };

    if (!this.signalHandlersAttached) {
      process.once("SIGINT", () => {
        void handleSignal("SIGINT");
      });
      process.once("SIGTERM", () => {
        void handleSignal("SIGTERM");
      });
      this.signalHandlersAttached = true;
    }

    await Promise.all(startupPromises);
  }

  async stop() {
    // Cleanup event listeners to prevent memory leaks
    for (const cleanup of this.eventCleanupFns) {
      cleanup();
    }
    this.eventCleanupFns = [];

    const services = this.options.services.includes("all")
      ? ["api", "delivery", "engine", "enricher", "scheduler", "ai", "workflow", "events"]
      : this.options.services;

    if (services.includes("api")) {
      const { stopApiServer } = await import("./services/api/main.js");
      await stopApiServer();
    }

    if (services.includes("delivery")) {
      const { stopDeliveryWorker } = await import("./services/delivery/main.js");
      await stopDeliveryWorker();
    }

    if (services.includes("engine")) {
      const { stopEngineWorker } = await import("./services/engine/main.js");
      await stopEngineWorker();
    }

    if (services.includes("enricher")) {
      const { stopEnricherWorker } = await import("./services/enricher/main.js");
      await stopEnricherWorker();
    }

    if (services.includes("scheduler")) {
      const { stopSchedulerWorker } = await import("./services/scheduler/main.js");
      await stopSchedulerWorker();
    }

    if (services.includes("ai")) {
      const { stopAiWorker } = await import("./services/ai/main.js");
      await stopAiWorker();
    }

    if (services.includes("workflow")) {
      const { stopWorkflowWorker } = await import("./services/workflow/main.js");
      await stopWorkflowWorker();
    }

    if (services.includes("events")) {
      const { stopEventWorker } = await import("./services/events/main.js");
      await stopEventWorker();
    }

    if (this.pgContainer) {
      this.logger.info("Stopping PostgreSQL container...");
      await this.pgContainer.stop();
    }
    if (this.redisContainer) {
      this.logger.info("Stopping Redis container...");
      await this.redisContainer.stop();
    }
  }
}
