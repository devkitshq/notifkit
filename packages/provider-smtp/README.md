# @notifkit/provider-smtp

SMTP email transport for [notifkit](https://github.com/devkitshq/notifkit),
built on [nodemailer](https://nodemailer.com). Works with any SMTP server: a
self-hosted Postfix, Gmail, or the SMTP endpoint of SES, SendGrid, Postmark,
Mailgun or Brevo.

```bash
npm install @notifkit/provider-smtp
```

```ts
import { NotifkitServer } from "notifkit";
import { SmtpTransport } from "@notifkit/provider-smtp";

const smtp = new SmtpTransport({
  smtp: {
    host: "smtp.example.com",
    port: 587,
    auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
    pool: true,
  },
  from: "Acme <notifications@example.com>",
});

const server = new NotifkitServer({
  services: ["all"],
  providers: [smtp],
});
```

A recipient's `email` contact target is the destination, so it holds their
address:

```ts
await notifkit.addContact("usr_123", { channel: "email", target: "alice@example.com" });
```

## Options

| Option   | What it's for                                                                                                                                                                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smtp`   | Passed to nodemailer's [`createTransport`](https://nodemailer.com/smtp/) as is: `host`, `port`, `secure`, `auth`, TLS settings, and `pool: true` to reuse connections between sends. A URL such as `smtps://user:pass@smtp.example.com` works too. |
| `from`   | Default sender. A template can name its own `from`.                                                                                                                                                                                                |
| `logger` | Optional notifkit logger.                                                                                                                                                                                                                          |
| `limits` | Optional send rate, `{ limit, windowSeconds }`. There's no default, since it depends on your server. Set it to your relay's quota.                                                                                                                 |

## Templates

Templates render into `subject`, `text` (or `body`) and `htmlBody` (or
`html`). A text-only template also gets an HTML part, built from the escaped
text. A template may carry its own `from` and `replyTo`, so one transport can
send both receipts and campaigns. The `List-Unsubscribe` headers notifkit adds
to topic mail are passed through.

## Failures and retries

nodemailer reports the server's SMTP reply code, and the transport decides
from it:

- A permanent rejection (5xx, such as 550 mailbox unavailable or 535 bad
  credentials) fails the task without a retry.
- A temporary rejection (4xx, such as 451 greylisting), 503, and connection
  errors or timeouts are retried.
- A destination that isn't one plain address fails without a retry, and nothing
  is sent. That includes `Alice <alice@example.com>` and comma-separated lists.

SMTP has no delivery webhooks. A bounce that comes back later as an email,
after the server accepted the message, isn't reported to notifkit.

## Shutting down

With `pool: true`, the open connections keep Node running after notifkit
stops, and notifkit doesn't close providers itself. Call `close()` after
`server.stop()`:

```ts
await server.stop();
smtp.close();
```

The server's own SIGINT/SIGTERM handler exits the process, so this matters
when you stop the server from your own code.

Requires `notifkit` as a peer dependency. Documentation:
[notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
