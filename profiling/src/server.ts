import {
  NotifkitServer,
  type Transport,
  type NotificationDispatchedPayload,
  type DeliveryResult,
} from "notifkit";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const workerConcurrency = process.env.WORKER_CONCURRENCY
  ? parseInt(process.env.WORKER_CONCURRENCY, 10)
  : 50;
function parseLatency(val?: string): { min: number; max: number } {
  if (!val) return { min: 0, max: 0 };
  if (val.includes("-")) {
    const [minStr, maxStr] = val.split("-");
    const min = parseInt(minStr!, 10) || 0;
    const max = parseInt(maxStr!, 10) || min;
    return { min, max };
  }
  const exact = parseInt(val, 10) || 0;
  return { min: exact, max: exact };
}

const latencyRange = parseLatency(process.env.PROVIDER_LATENCY_MS);

class ProfilingTransport implements Transport {
  readonly channel = "email";
  readonly limits = { limit: 1_000_000, windowSeconds: 1 };

  async send(task: NotificationDispatchedPayload): Promise<DeliveryResult> {
    if (latencyRange.max > 0) {
      const delay =
        latencyRange.min === latencyRange.max
          ? latencyRange.min
          : Math.floor(Math.random() * (latencyRange.max - latencyRange.min + 1)) +
            latencyRange.min;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const providerMessageId = `prof-${Date.now()}`;
    const requestTime = (task.templateVariables as Record<string, unknown> | undefined)
      ?.requestTime;
    const latency = typeof requestTime === "number" ? Date.now() - requestTime : 0;

    console.log(
      JSON.stringify({
        taskId: task.taskId,
        channel: this.channel,
        destination: task.destination,
        providerMessageId,
        latency,
        msg: "push delivered (console transport)",
      }),
    );

    return { success: true, providerMessageId };
  }
}

import http from "node:http";

const rawServices = process.env.SERVICES?.trim();
const services: (
  "api" | "enricher" | "engine" | "delivery" | "scheduler" | "ai" | "workflow" | "events"
)[] =
  rawServices && rawServices !== "all"
    ? (rawServices.split(",").map((s) => s.trim()) as (
        "api" | "enricher" | "engine" | "delivery" | "scheduler"
      )[])
    : ["api", "enricher", "engine", "delivery", "scheduler"];

const server = new NotifkitServer({
  services,
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  databaseUrl: process.env.DATABASE_URL || "postgres://notifkit:password@localhost:5432/notifkit",
  logLevel: (process.env.LOG_LEVEL as "info" | "warn" | "error" | "debug") || "info",
  autoMigrate: false,
  port: PORT,
  workerConcurrency,
  providers: [new ProfilingTransport()],
});

server
  .start()
  .then(() => {
    console.log(
      `🚀 Profiling Server started on port ${PORT} [services: ${services.join(",")}] (concurrency: ${workerConcurrency})`,
    );

    // If API is not enabled on this worker node, expose a lightweight health responder so orchestration succeeds
    if (!services.includes("api")) {
      const healthServer = http.createServer((req, res) => {
        if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", services, isWorkerOnly: true }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      healthServer.listen(PORT, "0.0.0.0");
    }
  })
  .catch((err) => {
    console.error("Failed to start profiling server:", err);
    process.exit(1);
  });
