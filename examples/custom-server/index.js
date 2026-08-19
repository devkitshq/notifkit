import { NotifkitServer } from 'notifkit';

/**
 * Example Custom Email Transport Provider
 */
class CustomEmailTransport {
  constructor() {
    this.channel = 'email';
  }

  async send(task) {
    console.log(`[CustomEmailTransport] Sending notification to ${task.recipient.email}...`);
    
    // Simulate async network request to email gateway
    await new Promise((resolve) => setTimeout(resolve, 100));

    return {
      success: true,
      providerMessageId: `custom-msg-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
    };
  }
}

async function main() {
  console.log('🚀 Starting custom Notifkit Server example...');

  const server = new NotifkitServer({
    services: ['all'],
    port: Number(process.env.PORT || 4000),
    logLevel: process.env.LOG_LEVEL || 'info',
    redisUrl: process.env.REDIS_URL,
    databaseUrl: process.env.DATABASE_URL,
    workerConcurrency: 50,
    providers: [
      new CustomEmailTransport(),
    ],
  });

  try {
    await server.start();
    console.log('✅ Notifkit Server started successfully on port 4000.');

    // Graceful shutdown handling
    const shutdown = async (signal) => {
      console.log(`\n🛑 Received ${signal}, stopping Notifkit Server...`);
      await server.stop();
      console.log('👋 Server stopped cleanly.');
      process.exit(0);
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    console.error('❌ Failed to start Notifkit Server:', error);
    process.exit(1);
  }
}

main();
