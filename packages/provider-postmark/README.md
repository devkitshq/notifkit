# @notifkit/provider-postmark

Postmark email transport for [notifkit](https://github.com/devkitshq/notifkit).
Sends through the Postmark Email API and verifies bounce webhooks with HTTP
Basic Auth (Postmark does not sign webhooks), so hard bounces, soft bounces
and spam complaints feed back into notifkit's suppression list automatically.

```bash
npm install @notifkit/provider-postmark
```

```ts
import { PostmarkTransport } from "@notifkit/provider-postmark";

registry.register(
  "email",
  new PostmarkTransport({
    serverToken: process.env.POSTMARK_SERVER_TOKEN,
    from: "notifications@example.com",
    webhookUsername: process.env.POSTMARK_WEBHOOK_USERNAME,
    webhookPassword: process.env.POSTMARK_WEBHOOK_PASSWORD,
  }),
);
```

`destination` is the recipient's email address. A template may carry its own
`from` and `replyTo`, so one transport can serve both transactional and
campaign mail. Requires `notifkit` as a peer dependency.

To receive bounce events, set the bounce webhook URL in the Postmark
dashboard (Servers > Message Streams > Outbound > Webhooks) to
`https://<username>:<password>@<your-host>/webhooks/postmark` and put the
same credentials in `webhookUsername` / `webhookPassword`. Without them the
webhook route rejects every event. The transport mounts at
`/webhooks/postmark` and maps `HardBounce` to a hard bounce, `SoftBounce`
and `Transient` to soft bounces, and `SpamComplaint` to a complaint. A send
refused with ErrorCode 406 means the recipient is inactive (Postmark already
suppressed it), so the contact is deactivated instead of retried.
Documentation: [notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
