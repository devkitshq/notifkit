# @notifkit/provider-vonage

Vonage (formerly Nexmo) SMS transport for
[notifkit](https://github.com/devkitshq/notifkit). Sends through the Vonage
Messages API v1 and verifies its signed status webhooks, so undeliverable
numbers and STOP replies feed back into notifkit's suppression list
automatically.

```bash
npm install @notifkit/provider-vonage
```

```ts
import { VonageTransport } from "@notifkit/provider-vonage";

registry.register(
  "sms",
  new VonageTransport({
    apiKey: process.env.VONAGE_API_KEY!,
    apiSecret: process.env.VONAGE_API_SECRET!,
    from: "+447700900001",
    signatureSecret: process.env.VONAGE_SIGNATURE_SECRET,
  }),
);
```

## Options

| Option            | Required | Description                                                                                                                                                    |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`          | yes      | API key from the [Vonage Dashboard](https://dashboard.nexmo.com).                                                                                              |
| `apiSecret`       | yes      | API secret from the same page. Sent as HTTP basic auth.                                                                                                        |
| `from`            | yes      | Default sender: a Vonage number in E.164 (`+447700900001`), or an alphanumeric sender ID (`MyShop`) where the destination country allows one.                  |
| `signatureSecret` | no       | Dashboard > Settings > **Signature secret**. Verifies status webhooks. Without it the webhook route is not mounted and sends go out without delivery tracking. |
| `limits`          | no       | Local send rate. Defaults to `{ limit: 75, windowSeconds: 1 }`, the Messages API's default limit per API key.                                                  |
| `logger`          | no       | A notifkit `Logger`.                                                                                                                                           |

A recipient's `sms` contact target is the destination, in E.164
(`+447700900000`). The transport removes the `+` that Vonage does not accept.
Templates render into `text` (or `body`), up to 3,200 characters; a longer text
is cut and ends in "…". A template may also carry its own `from`, the same way
other transports let a template override their default sender.

## Delivery status webhooks

1. In the Vonage Dashboard, open **API Settings** and set the **Messages API**
   version to `v1`.
2. Set the account's **Status URL** to the public URL of this transport's
   route, `/webhooks/vonage` on your notifkit API (for example
   `https://api.example.com/webhooks/vonage`).
3. Copy the **Signature secret** from the same page into `signatureSecret`.

Vonage signs every status webhook with a JWT (`Authorization: Bearer …`,
HS256, keyed by the signature secret). The transport checks the signature and
that the token's `payload_hash` matches the body, and rejects anything else:
an unverifiable callback is an anonymous, forgeable write into delivery
history.

Vonage accepts a message before any carrier has seen it, so a successful `send`
means accepted, not delivered. What actually happened arrives on the webhook:

| Vonage status            | notifkit event                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `rejected`               | `bounced` — `hard` for a permanently bad number (`1050`, `1170`, `1190`, `1310`, `1430`), `soft` otherwise |
| `rejected` + `1240`      | `unsubscribed` — the recipient replied STOP                                                                |
| `undeliverable`          | `bounced`, `soft` — Vonage could not reach the carrier                                                     |
| `submitted`, `delivered` | ignored                                                                                                    |

An unrecognised error code is treated as a **soft** bounce. Wrongly suppressing
a working number silently stops messages someone still wants, so only codes
known to mean the number itself is gone are hard. A block on Vonage's side,
such as Fraud Defender's country block (`1474`) that new accounts often hit for
some destinations, is soft too: the number is fine, the account may not reach
it yet.

## Failed sends

A send refused with a code that means the destination is bad (`1050`, `1170`,
`1190`, `1240`, `1430`) is returned as an invalid token, so notifkit stops
retrying and flags the contact. Any other 4xx, such as rejected credentials or
an invalid sender, is permanent and not retried. A rate limit (HTTP 429, or
codes `1000`, `1241`, `1461`) waits for capacity instead. Timeouts, network
errors, 5xx and temporary codes (`1030`, `1100`, `1180`, `1220`, `1230`,
`1331`) are retried. Error codes:
[developer.vonage.com/en/api-errors/messages](https://developer.vonage.com/en/api-errors/messages).

Requires `notifkit` as a peer dependency. Documentation:
[notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
