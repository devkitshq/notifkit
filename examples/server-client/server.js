/**
 * Notifkit Server Example
 *
 * Starts the Notifkit orchestrator server including the API service,
 * workers (delivery, engine, enricher, scheduler), and the Admin Dashboard.
 *
 * To run:
 *   node server.js
 */

import { NotifkitServer } from "../../dist/index.mjs";

// Optional: Set default admin credentials for first-time dashboard login
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "nk_live_admin_secret_key";

async function main() {
  console.log("🚀 Initializing Notifkit Server...\n");

  const server = new NotifkitServer({
    services: ["all"],
    port: Number(process.env.PORT || 3000),
    logLevel: process.env.LOG_LEVEL || "info",
    redisUrl: process.env.REDIS_URL,
    databaseUrl: process.env.DATABASE_URL,
    workerConcurrency: 10,
    autoMigrate: true,
  });

  // Listen to server events
  server.on("delivery:delivered", (event) => {
    console.log(`[Event] Notification delivered: Task ${event.taskId} -> ${event.channel}`);
  });

  server.on("delivery:failed", (event) => {
    console.error(`[Event] Notification delivery failed: Task ${event.taskId}`, event.error);
  });

  try {
    await server.start();

    const port = process.env.PORT || 3000;
    console.log("\n=======================================================");
    console.log(`✅ Notifkit Server is running at http://localhost:${port}`);
    console.log(`📊 Admin Dashboard available at http://localhost:${port}/admin`);
    console.log(`🔑 Default Admin Credentials:`);
    console.log(`   Email:    ${process.env.ADMIN_EMAIL}`);
    console.log(`   Password: ${process.env.ADMIN_PASSWORD}`);
    console.log("=======================================================\n");
  } catch (error) {
    console.error("❌ Failed to start Notifkit Server:", error);
    process.exit(1);
  }
}

void main();
