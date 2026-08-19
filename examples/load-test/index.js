import { NotifkitClient } from 'notifkit';

/**
 * Load testing example for measuring Notifkit pipeline throughput.
 */
async function runLoadTest() {
  const baseUrl = process.env.NOTIFKIT_API_URL || 'http://localhost:4000';
  const apiKey = process.env.ADMIN_API_KEY || 'your_admin_api_key';
  const totalNotifications = Number(process.env.COUNT || 500);
  const concurrency = Number(process.env.CONCURRENCY || 50);

  const client = new NotifkitClient({ baseUrl, apiKey });

  console.log(`⚡ Starting load test: ${totalNotifications} notifications (Concurrency: ${concurrency})...`);
  const startTime = Date.now();

  let completed = 0;
  let failed = 0;

  const queue = Array.from({ length: totalNotifications }, (_, i) => ({
    template: 'benchmark-template',
    channels: ['email'],
    user: {
      id: `bench-user-${i % 100}`,
      email: `bench-user-${i % 100}@example.com`,
    },
    data: { index: i },
  }));

  async function worker() {
    while (queue.length > 0) {
      const item = queue.pop();
      if (!item) break;

      try {
        await client.notify(item);
        completed++;
      } catch (err) {
        failed++;
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const elapsedMs = Date.now() - startTime;
  const throughputSec = (completed / (elapsedMs / 1000)).toFixed(2);

  console.log(`\n📊 Load Test Results:`);
  console.log(`   - Total Processed: ${completed + failed}`);
  console.log(`   - Successful: ${completed}`);
  console.log(`   - Failed: ${failed}`);
  console.log(`   - Elapsed Time: ${elapsedMs} ms`);
  console.log(`   - Throughput: ${throughputSec} req/sec`);
}

runLoadTest().catch((err) => {
  console.error('❌ Error executing load test:', err);
  process.exit(1);
});
