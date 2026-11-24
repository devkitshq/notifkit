# @notifkit/provider-postmark

Postmark email transport for [notifkit](https://github.com/devkitshq/notifkit).
Sends transactional email through Postmark's HTTP API with zero runtime
dependencies and verifies delivery webhooks via HTTP Basic Auth, so hard bounces
and spam complaints feed back into notifkit's suppression list automatically.

```bash
npm install @notifkit/provider-postmark
```

```ts
import { PostmarkTransport } from "@notifkit/provider-postmark";

registry.register(
  "email",
  new PostmarkTransport({
    serverToken: process.env.POSTMARK_SERVER_TOKEN!,
    from: "notifications@example.com",
    messageStream: "outbound",
    webhookBasicAuth: {
      username: process.env.POSTMARK_WEBHOOK_USER!,
      password: process.env.POSTMARK_WEBHOOK_PASS!,
    },
  }),
);
```

## Options

- `serverToken` (required): Postmark Server API token (`X-Postmark-Server-Token`).
- `from` (required): default sender address. Templates may override it with their own `from` and `replyTo`.
- `messageStream` (optional): Postmark Message Stream ID (for example `"outbound"` or `"broadcast"`).
- `webhookBasicAuth` (optional): `{ username, password }` credentials embedded in the Postmark webhook URL (for example `https://user:pass@your-host/webhooks/postmark`). Required for `verifyWebhook` and `parseWebhook` to accept incoming events.
- `apiBaseUrl` (optional): override the Postmark API base URL (defaults to `https://api.postmarkapp.com`).
- `limits` (optional): rate limit configuration (defaults to `{ limit: 1000, windowSeconds: 10 }`).
- `logger` (optional): notifkit `Logger` instance.

## Destination

`task.destination` should be the recipient's email address (for example `"alice@example.com"`).

Requires `notifkit` as a peer dependency.
Documentation: [notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
