import type { Logger } from "@/index.js";
import type { BaseWorker } from "./index.js";

export function startHealthReporter(
  serviceName: string,
  worker: BaseWorker,
  redis: { healthCheck: () => Promise<boolean>; native: any },
  logger: Logger,
  intervalMs = 1000,
): NodeJS.Timeout {
  return setInterval(() => {
    void (async () => {
      try {
        const redisOk = await redis.healthCheck();
        await redis.native.set(
          `notif:health:${serviceName}`,
          JSON.stringify({
            service: serviceName,
            redis: redisOk,
            ...worker.health(),
            updatedAt: new Date().toISOString(),
          }),
          "EX",
          15,
        );
      } catch {
        // A failed health write is not worth failing the worker over.
      }
    })();
  }, intervalMs);
}
