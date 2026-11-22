# @notifkit/provider-sendgrid

SendGrid email transport for [notifkit](https://github.com/devkitshq/notifkit).
Sends through the SendGrid Mail Send API and verifies signed event webhooks
with Node's built-in ECDSA check, so bounces, blocks, spam reports and
unsubscribes feed back into notifkit's suppression list automatically.

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

`destination` is the recipient's email address. A template may carry its own
`from` and `replyTo`, so one transport can serve both transactional and
campaign mail. Requires `notifkit` as a peer dependency.

To receive delivery events, turn on Signed Event Webhook in the SendGrid
dashboard (Settings > Mail Settings > Event Settings) and copy the PEM public
key there into `webhookPublicKey`. Without it the webhook route rejects every
event. The transport mounts at `/webhooks/sendgrid` and maps `bounce` to a
hard bounce, `blocked` and `deferred` to soft bounces, `spamreport` to a
complaint, and `unsubscribe` to an unsubscribe. SendGrid references each
message as `sg_message_id`, which starts with the `X-Message-Id` the send
returned.
Documentation: [notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
