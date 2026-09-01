# @notifkit/provider-twilio

Twilio SMS transport for [notifkit](https://github.com/devkitshq/notifkit).
Sends through the Twilio Messages API and verifies delivery status callbacks
with `X-Twilio-Signature`, so undeliverable numbers and STOP replies feed back
into notifkit's suppression list automatically.

```bash
npm install @notifkit/provider-twilio
```

```ts
import { TwilioTransport } from "@notifkit/provider-twilio";

registry.register(
  "sms",
  new TwilioTransport({
    accountSid: process.env.TWILIO_ACCOUNT_SID!,
    authToken: process.env.TWILIO_AUTH_TOKEN!,
    from: "+15550000001",
    statusCallbackUrl: "https://api.example.com/webhooks/twilio",
  }),
);
```

A recipient's `sms` contact target is the destination, in E.164
(`+15550000002`). Templates render into `text` (or `body`); a template may also
carry its own `from`, the same way other transports let a template override
their default sender — useful when a support long code and a marketing short
code share one transport.

## Delivery status callbacks

`statusCallbackUrl` must be the publicly reachable URL of this transport's
webhook route. Twilio signs the URL it was given along with the request body,
so signatures can only be checked against that exact string — including any
query string. The route is mounted at its path (`/webhooks/twilio` above), and
is only mounted at all when the URL is configured: an unverifiable callback is
an anonymous, forgeable write into delivery history, so the transport fails
closed rather than accepting one.

Twilio accepts a message before any carrier has seen it, so a successful
`send` means `queued`, not delivered. What actually happened arrives on the
callback:

| Twilio status                                                    | notifkit event                                                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `undelivered` / `failed`                                         | `bounced` — `hard` for a permanently bad number (`21211`, `21612`, `21614`, `30005`, `30006`), `soft` otherwise |
| `undelivered` / `failed` + `21610`                               | `unsubscribed` — the recipient replied STOP                                                                     |
| `read`                                                           | `opened` (RCS and WhatsApp only; SMS has no read receipt)                                                       |
| `queued`, `sending`, `sent`, `delivered`, `accepted`, `canceled` | ignored                                                                                                         |

An unrecognised error code is treated as a **soft** bounce. Wrongly
suppressing a working number silently stops messages someone still wants, so
only codes known to mean the number itself is gone are hard.

## Opt-outs

Twilio handles STOP/START itself and rejects a send to an opted-out recipient
with error `21610`. That is returned as an invalid token — as are `21211`,
`21612`, and `21614` — so notifkit stops retrying and flags the contact.
Everything else, including rate limits, stays retryable.

Requires `notifkit` as a peer dependency. Documentation:
[notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
