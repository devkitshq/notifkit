# @notifkit/provider-mailgun

Mailgun email transport for [notifkit](https://github.com/devkitshq/notifkit).
Sends transactional email through Mailgun's v3 HTTP API with zero runtime
dependencies and verifies delivery webhooks with HMAC-SHA256, so permanent
failures and spam complaints feed back into notifkit's suppression list
automatically.

```bash
npm install @notifkit/provider-mailgun
```

```ts
import { MailgunTransport } from "@notifkit/provider-mailgun";

registry.register(
  "email",
  new MailgunTransport({
    apiKey: process.env.MAILGUN_API_KEY!,
    domain: process.env.MAILGUN_DOMAIN!,
    from: "notifications@example.com",
    // Set to "https://api.eu.mailgun.net" for EU region domains.
    apiBaseUrl: process.env.MAILGUN_API_BASE_URL,
    webhookSigningKey: process.env.MAILGUN_WEBHOOK_SIGNING_KEY,
  }),
);
```

## Options

- `apiKey` (required): Mailgun private API key (`api:<apiKey>` HTTP Basic Auth).
- `domain` (required): Mailgun sending domain (for example `"mg.example.com"`).
- `from` (required): default sender address. Templates may override it with their own `from` and `replyTo`.
- `apiBaseUrl` (optional): Mailgun API base URL (defaults to `"https://api.mailgun.net"`; use `"https://api.eu.mailgun.net"` for EU accounts).
- `webhookSigningKey` (optional): Mailgun HTTP webhook signing key used to verify `signature.timestamp + signature.token` with HMAC-SHA256. Required for `verifyWebhook` and `parseWebhook` to accept incoming events.
- `limits` (optional): rate limit configuration (defaults to `{ limit: 1000, windowSeconds: 10 }`).
- `logger` (optional): notifkit `Logger` instance.

## Destination

`task.destination` should be the recipient's email address (for example `"alice@example.com"`).

Requires `notifkit` as a peer dependency.
Documentation: [notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
