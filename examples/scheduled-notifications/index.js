import { NotifkitClient } from 'notifkit';

/**
 * Example demonstrating scheduled and quiet-hours aware notification delivery.
 */
async function runScheduledNotificationsExample() {
  const client = new NotifkitClient({
    baseUrl: process.env.NOTIFKIT_API_URL || 'http://localhost:4000',
    apiKey: process.env.ADMIN_API_KEY || 'your_admin_api_key',
  });

  console.log('🔄 Syncing template...');
  await client.syncTemplates({
    templates: [
      {
        id: 'scheduled-reminder',
        channel: 'email',
        content: {
          subject: 'Scheduled Meeting Reminder',
          html: '<h3>Meeting Reminder</h3><p>Hi {{name}}, your meeting starts in 15 minutes.</p>',
          text: 'Hi {{name}}, your meeting starts in 15 minutes.',
        },
      },
    ],
  });

  // Schedule notification for 10 minutes in the future
  const sendAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  console.log(`⏰ Dispatching scheduled notification for ${sendAt}...`);
  const response = await client.notify({
    template: 'scheduled-reminder',
    channels: ['email'],
    user: {
      id: 'user-2002',
      email: 'alex@example.com',
      timezone: 'America/New_York',
      // Quiet hours live under `preferences`, and are a list of UTC windows.
      preferences: {
        quietHours: [{ start: '22:00', end: '08:00' }],
      },
    },
    data: { name: 'Alex' },
    sendAt,
  });

  console.log('✅ Scheduled notification response:', response);
}

runScheduledNotificationsExample().catch((err) => {
  console.error('❌ Error executing scheduled notification example:', err);
  process.exit(1);
});
