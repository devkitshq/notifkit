# @notifkit/provider-resend

Resend email transport for [notifkit](https://github.com/devkitshq/notifkit).
Sends through Resend and verifies delivery webhooks with svix, so bounces and
complaints feed back into notifkit's suppression list automatically.

```bash
npm install @notifkit/provider-resend
```

```ts
import { ResendTransport } from "@notifkit/provider-resend";

registry.register(
  "email",
  new ResendTransport({
    apiKey: process.env.RESEND_API_KEY!,
    from: "notifications@example.com",
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
  }),
);
```

A template may carry its own `from` and `replyTo`, so one transport can serve
both transactional and campaign mail. Requires `notifkit` as a peer dependency.
Documentation: [notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
