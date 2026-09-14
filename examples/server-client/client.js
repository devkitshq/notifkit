/**
 * Notifkit Client SDK Example
 *
 * Demonstrates using the typed `NotifkitClient` to:
 * 1. Sync templates
 * 2. Register users & recipient contacts
 * 3. Dispatch multi-channel notifications
 *
 * To run:
 *   node client.js
 */

import { NotifkitClient } from "../../dist/index.mjs";

const BASE_URL = process.env.NOTIFKIT_URL || "http://localhost:3000";
// Project API Key or Admin API Key
const API_KEY =
  process.env.NOTIFKIT_API_KEY || process.env.ADMIN_API_KEY || "nk_live_admin_secret_key";
const PROJECT_ID = process.env.NOTIFKIT_PROJECT_ID;

async function main() {
  console.log("🚀 Initializing Notifkit Client...\n");

  const client = new NotifkitClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    headers: PROJECT_ID ? { "x-project-id": PROJECT_ID } : undefined,
  });

  try {
    // 1. Sync Notification Templates
    console.log("1️⃣ Syncing notification templates...");
    const syncRes = await client.syncTemplates({
      templates: [
        {
          id: "welcome_notification",
          channel: "email",
          content: {
            subject: "Welcome to our platform, {{name}}!",
            html: "<h1>Welcome {{name}} 🎉</h1><p>We are thrilled to have you on board!</p>",
            text: "Welcome {{name}}! We are thrilled to have you on board!",
          },
        },
        {
          id: "security_alert",
          channel: "sms",
          content: {
            text: "Security Alert: New login detected from {{location}} at {{time}}.",
          },
        },
      ],
    });
    console.log(`✅ Synced ${syncRes.synced} templates.\n`);

    // 2. Register / Upsert a User and their contact points
    console.log("2️⃣ Upserting user profile and contacts...");
    const userRes = await client.upsertUser({
      id: "usr_alex_99",
      email: "alex@example.com",
      timezone: "America/New_York",
      contacts: [
        {
          channel: "email",
          target: "alex@example.com",
          isPrimary: true,
          enabled: true,
        },
        {
          channel: "sms",
          target: "+15551234567",
          enabled: true,
        },
      ],
      preferences: {
        channels: {
          email: true,
          sms: true,
        },
      },
    });
    console.log(`✅ User registered: ID "${userRes.id}"\n`);

    // 3. Send a Notification
    console.log("3️⃣ Dispatching notification...");
    const notifyRes = await client.send({
      user: "usr_alex_99",
      template: "welcome_notification",
      channels: ["email"],
      data: {
        name: "Alex",
      },
      priority: "normal",
    });

    console.log(`✅ Notification queued successfully! Task ID: ${notifyRes.taskId}\n`);

    // 4. Poll/Check Notification Status
    console.log("4️⃣ Fetching notification status...");
    const status = await client.getNotificationStatus(notifyRes.taskId);
    console.log("Status details:", status);

    console.log("\n🎉 All client actions completed successfully!");
  } catch (error) {
    console.error("❌ Client error:", error.message);
  }
}

void main();
