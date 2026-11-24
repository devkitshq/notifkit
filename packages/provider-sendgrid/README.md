# @notifkit/provider-sendgrid

SendGrid email transport for [notifkit](https://github.com/devkitshq/notifkit).
Sends transactional email through SendGrid's v3 Mail Send API with zero runtime
dependencies and verifies Event Webhooks using ECDSA (`node:crypto`), so
bounces, complaints, and unsubscribes feed back into notifkit's suppression list
automatically.

```bash
npm install @notifkit/provider-sendgrid
```

```ts
import { SendGridTransport } from "@notifkit/provider-sendgrid";

registry.register(
  "email",
  new SendGridTransport({
    apiKey: process.env.SENDGRID_API_KEY!,
    from: "notifications@example.com",
    webhookPublicKey: process.env.SENDGRID_WEBHOOK_PUBLIC_KEY,
  }),
);
```

## Options

- `apiKey` (required): SendGrid API key (`Authorization: Bearer <apiKey>`).
- `from` (required): default sender address. Templates may override it with their own `from` and `replyTo`.
- `webhookPublicKey` (optional): SendGrid Event Webhook ECDSA verification public key (PEM or base64 SPKI DER). Required for `verifyWebhook` and `parseWebhook` to accept incoming events.
- `apiBaseUrl` (optional): override the SendGrid API base URL (defaults to `https://api.sendgrid.com`).
- `limits` (optional): rate limit configuration (defaults to `{ limit: 1000, windowSeconds: 10 }`).
- `logger` (optional): notifkit `Logger` instance.

## Destination

`task.destination` should be the recipient's email address (for example `"alice@example.com"`).

Requires `notifkit` as a peer dependency.
Documentation: [notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
