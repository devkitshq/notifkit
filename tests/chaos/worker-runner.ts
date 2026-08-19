import { NotifkitServer } from "../../src/server.js";

async function main() {
  const service = process.env.WORKER_TYPE as "enricher" | "engine" | "delivery" | "scheduler";
  if (!service) {
    throw new Error("WORKER_TYPE environment variable is required");
  }

  const server = new NotifkitServer({
    services: [service],
    redisUrl: process.env.REDIS_URL,
    databaseUrl: process.env.DATABASE_URL,
    logLevel: "silent",
    autoMigrate: false,
    providers: [
      {
        channel: "email",
        send: async () => ({ success: true }),
      },
    ],
  });

  await server.start();

  process.on("message", (msg) => {
    if (msg === "stop") {
      void server.stop().then(() => process.exit(0));
    }
  });
}

main().catch((err) => {
  console.error("Worker runner failed", err);
  process.exit(1);
});
