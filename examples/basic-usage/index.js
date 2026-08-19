/**
 * Example project demonstrating how to use Notifkit via its HTTP API — no SDK,
 * just fetch. Any language that can POST JSON works the same way.
 *
 * Before running this, start a Notifkit server. The custom-server example is
 * one:
 *   $ cd ../custom-server && node index.js
 *
 * To run this example:
 *   $ ADMIN_API_KEY=my_super_secret_admin_key npm start
 */

const API_BASE = process.env.NOTIFKIT_API_URL || 'http://localhost:3000/v1';
const API_KEY = process.env.ADMIN_API_KEY || 'my_super_secret_admin_key';

// Every /v1 route is authenticated. Only /health, /live, /ready and /metrics are not.
const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${API_KEY}`,
};

async function main() {
  console.log('🚀 Starting Notifkit example...\n');

  try {
    // 1. Sync Templates (Configure how notifications should look)
    console.log('1️⃣ Syncing email template...');
    const templateRes = await fetch(`${API_BASE}/templates`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        templates: [{
          id: 'welcome_email',
          channel: 'email',
          // The per-channel fields live under `content`.
          content: {
            subject: 'Welcome to Notifkit, {{name}}!',
            html: '<h1>Hello {{name}}</h1><p>Thanks for signing up!</p>',
            text: 'Hello {{name}}! Thanks for signing up!'
          }
        }]
      })
    });
    console.log('Template Response:', await templateRes.json());
    console.log();

    // 2. Create a User (Register a recipient)
    console.log('2️⃣ Registering a user...');
    const userRes = await fetch(`${API_BASE}/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 'user_123',
        email: 'test@example.com',
        preferences: {
          channels: { email: true }
        }
      })
    });
    console.log('User Response:', await userRes.json());
    console.log();

    // 3. Send a Notification
    console.log('3️⃣ Sending notification...');
    const notifyRes = await fetch(`${API_BASE}/notify`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user: 'user_123',
        template: 'welcome_email',
        channels: ['email'],
        data: {
          name: 'Alice'
        }
      })
    });
    // 202 Accepted — queued, not delivered. Track it with
    // GET /v1/notifications/{taskId}.
    console.log('Notify Response:', await notifyRes.json());
    console.log('\n✅ Example completed successfully!');

  } catch (err) {
    console.error('❌ Error executing example:', err.message);
  }
}

main();
