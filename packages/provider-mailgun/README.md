# @notifkit/provider-mailgun

Mailgun email transport for [notifkit](https://github.com/devkitshq/notifkit).
Sends through the Mailgun Messages API and verifies signed event webhooks
with Node's built-in HMAC check, so bounces and complaints feed back into
notifkit's suppression list automatically. No new dependency: sending uses
plain `fetch`, webhook verification uses Node's built-in crypto.

```bash
npm install @notifkit/provider-mailgun
```

```ts
import { MailgunTransport } from "@notifkit/provider-mailgun";

registry.register(
  "email",
  new MailgunTransport({
    apiKey: process.env.MAILGUN_API_KEY!,
    domain: "mg.example.com",
    from: "notifications@example.com",
    // EU accounts: baseUrl: "https://api.eu.mailgun.net",
    webhookSigningKey: process.env.MAILGUN_WEBHOOK_SIGNING_KEY,
  }),
);
```

`destination` is the recipient's email address. A template may carry its own
`from` and `replyTo`, so one transport can serve both transactional and
campaign mail. Requires `notifkit` as a peer dependency.

To receive delivery events, copy the webhook signing key from the Mailgun
dashboard (Settings > Webhooks > Signing key) into `webhookSigningKey`.
Without it the webhook route rejects every event. The transport mounts at
`/webhooks/mailgun` and maps a `failed` event with `severity: "permanent"` to
a hard bounce, `severity: "temporary"` to a soft bounce, and `complained` to
a complaint. Mailgun references each message as `id`, which is the
`providerMessageId` the send returned.
Documentation: [notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
