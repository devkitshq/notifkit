# @notifkit/provider-ses

AWS SES email transport for [notifkit](https://github.com/devkitshq/notifkit),
built on the AWS SDK's SESv2 client.

```bash
npm install @notifkit/provider-ses
```

```ts
import { NotifkitServer } from "notifkit";
import { SesTransport } from "@notifkit/provider-ses";

const ses = new SesTransport({
  region: "eu-west-1",
  from: "Acme <notifications@example.com>",
  limits: { limit: 14, windowSeconds: 1 }, // your account's maximum send rate
});

const server = new NotifkitServer({
  services: ["all"],
  providers: [ses],
});
```

Credentials come from the AWS SDK's default chain: the `AWS_ACCESS_KEY_ID`
and `AWS_SECRET_ACCESS_KEY` environment variables, a profile in the shared
config, SSO, or the IAM role of the machine (EC2, ECS, Lambda). That identity
needs the `ses:SendEmail` permission.

The `from` address, or its domain, has to be a verified SES identity. While
the account is in the SES sandbox, recipients have to be verified too.

`limits` is required. Set it to your account's maximum send rate, so a burst
waits its turn instead of being throttled. The SES console shows the rate
under **Sending limits** on the **Account dashboard**, and
`aws sesv2 get-account` returns it as `SendQuota.MaxSendRate`. It's set per
region, and in the sandbox it's 1 a second.

A recipient's `email` contact target is the destination, so it holds their
address:

```ts
await notifkit.addContact("usr_123", { channel: "email", target: "alice@example.com" });
```

## Options

| Option                 | What it's for                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `from`                 | Default sender, a verified identity. A template can name its own `from`.                                                                                             |
| `region`               | The SES account's region. Without it the SDK reads `AWS_REGION` or the shared config.                                                                                |
| `client`               | An `SESv2Client` you built yourself, for custom credentials or settings. It's used as is, so its retry and timeout settings are yours, and `close()` leaves it open. |
| `configurationSetName` | SES configuration set to send with, such as one that publishes events.                                                                                               |
| `logger`               | Optional notifkit logger.                                                                                                                                            |
| `limits`               | Required. Send rate, `{ limit, windowSeconds }`, set to your account's maximum send rate, e.g. `{ limit: 14, windowSeconds: 1 }`. See above for where to find it.    |

## Templates

Templates render into `subject`, `text` (or `body`) and `htmlBody` (or
`html`). A text-only template also gets an HTML part, built from the escaped
text. A template may carry its own `from` and `replyTo`, so one transport can
send both receipts and campaigns. The `List-Unsubscribe` headers notifkit adds
to topic mail are passed through.

## Failures and retries

The transport decides from the error SES returns:

- A refusal another attempt can't fix fails the task without a retry. That
  covers a rejected message, an unverified sender or MAIL FROM domain, a bad
  address, a paused or suspended account, and a configuration set that doesn't
  exist.
- Throttling is retried, which covers short spikes over the send rate. It
  can't wait out the daily quota, which resets over 24 hours, so keep your
  quota above your daily volume. 5xx errors, timeouts and network errors are
  retried too.

The client the transport builds has the SDK's own retries turned off, because
notifkit already retries with backoff. Each send is cancelled when it reaches
notifkit's send timeout, 10 seconds by default.

SES has no idempotency key. If SES accepts a message but its reply is lost,
for example to a timeout, the retry sends the message a second time.

This package doesn't read SES bounce and complaint notifications yet.

## Shutting down

From notifkit 0.1.20, `server.stop()` closes the transport, which closes the
connections of the client it built. On older versions, call `ses.close()`
after `server.stop()`. A client you passed in stays open for you to close.

Requires `notifkit` as a peer dependency. Documentation:
[notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
