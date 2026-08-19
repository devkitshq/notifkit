import { NotifkitClient } from 'notifkit';

/**
 * Example demonstrating multi-step notification workflows (Notify -> Wait -> Notify)
 */
async function runWorkflowExample() {
  const client = new NotifkitClient({
    baseUrl: process.env.NOTIFKIT_API_URL || 'http://localhost:4000',
    apiKey: process.env.ADMIN_API_KEY || 'your_admin_api_key',
  });

  console.log('🔄 Syncing onboarding template...');
  await client.syncTemplates({
    templates: [
      {
        id: 'onboarding-welcome',
        channel: 'email',
        content: {
          subject: 'Welcome to our Platform!',
          html: '<h3>Hello {{name}}!</h3><p>Thank you for signing up.</p>',
          text: 'Hello {{name}}! Thank you for signing up.',
        },
      },
      {
        id: 'onboarding-followup',
        channel: 'email',
        content: {
          subject: 'Getting Started Tips',
          html: '<h3>Tips for {{name}}</h3><p>Check out our documentation to get started.</p>',
          text: 'Tips for {{name}}. Check out our documentation to get started.',
        },
      },
    ],
  });
  console.log('✅ Templates synced successfully.');

  console.log('🔄 Registering multi-step workflow definition...');
  // No step names a recipient: each one inherits the user the instance was
  // triggered with, so the same definition serves every subscriber.
  const workflow = await client.createWorkflow({
    name: 'user-onboarding-drip',
    steps: [
      {
        action: 'notify',
        payload: {
          template: 'onboarding-welcome',
          channels: ['email'],
          data: { name: 'Jane Doe' },
        },
      },
      {
        action: 'wait',
        duration: '1h', // Wait 1 hour before next step
      },
      {
        action: 'notify',
        payload: {
          template: 'onboarding-followup',
          channels: ['email'],
          data: { name: 'Jane Doe' },
        },
      },
    ],
  });

  console.log(`✅ Workflow registered: ${workflow.name}`);

  console.log('🔄 Registering the recipient...');
  await client.addUser({ id: 'user-1001', email: 'user@example.com' });

  console.log('🚀 Triggering workflow execution for recipient...');
  // input.user.id is who every notify step in this instance sends to.
  const execution = await client.triggerWorkflow({
    name: 'user-onboarding-drip',
    input: { user: { id: 'user-1001' } },
  });

  console.log('🎉 Workflow triggered. Instance ID:', execution.instanceId);
}

runWorkflowExample().catch((err) => {
  console.error('❌ Error executing workflow example:', err);
  process.exit(1);
});
