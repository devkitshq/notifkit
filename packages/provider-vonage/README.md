# @notifkit/provider-vonage

Vonage SMS transport for [notifkit](https://github.com/devkitshq/notifkit).
Sends through the Vonage Messages API v1 (`POST /v1/messages`) and verifies
delivery status webhooks using HS256 JWT signatures.

```bash
npm install @notifkit/provider-vonage
```

```ts
import { VonageTransport } from "@notifkit/provider-vonage";

registry.register(
  new VonageTransport({
    apiKey: process.env.VONAGE_API_KEY!,
    apiSecret: process.env.VONAGE_API_SECRET!,
    from: "AcmeApp",
    signatureSecret: process.env.VONAGE_SIGNATURE_SECRET,
  }),
);
```

A recipient's `sms` contact target is the destination in E.164 format
(`+15550000002`); the leading `+` is stripped automatically as required by the
Vonage Messages API. Templates render into `text` (or `body`), and may override
the default sender via `from`.

## Delivery status webhooks

Configure `signatureSecret` (from your Vonage dashboard) to mount the status
webhook route (defaults to `/webhooks/vonage`, customizable via `webhookPath`).
Incoming webhooks are verified via the `Authorization: Bearer <jwt>` HS256
signature (and `payload_hash` when present) and fail closed when unconfigured
or invalid.

| Vonage status            | notifkit event |
| ------------------------ | -------------- |
| `rejected`               | `bounced`      |
| `undeliverable`          | `bounced`      |
| `read`                   | `opened`       |
| `submitted`, `delivered` | ignored        |

Requires `notifkit` as a peer dependency. Documentation:
[notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
