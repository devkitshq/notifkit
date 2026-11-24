# @notifkit/provider-telnyx

Telnyx SMS transport for [notifkit](https://github.com/devkitshq/notifkit).
Sends SMS through Telnyx's v2 Messages API with zero runtime dependencies and
verifies `message.finalized` webhooks using Ed25519 (`node:crypto`).

```bash
npm install @notifkit/provider-telnyx
```

```ts
import { TelnyxTransport } from "@notifkit/provider-telnyx";

registry.register(
  "sms",
  new TelnyxTransport({
    apiKey: process.env.TELNYX_API_KEY!,
    from: "+15550100000",
    webhookPublicKey: process.env.TELNYX_WEBHOOK_PUBLIC_KEY,
  }),
);
```

## Options

- `apiKey` (required): Telnyx v2 API key (`Authorization: Bearer <apiKey>`).
- `from` (optional): default E.164 sender phone number (at least one of `from` or `messagingProfileId` should be provided).
- `messagingProfileId` (optional): Telnyx Messaging Profile ID (`messaging_profile_id`).
- `webhookPublicKey` (optional): Telnyx Ed25519 public key (PEM or base64-encoded raw 32-byte / SPKI DER key). Required for `verifyWebhook` and `parseWebhook`.
- `apiBaseUrl` (optional): override the Telnyx API base URL (defaults to `https://api.telnyx.com`).
- `limits` (optional): rate limit configuration (defaults to `{ limit: 1000, windowSeconds: 10 }`).
- `logger` (optional): notifkit `Logger` instance.

## Destination

`task.destination` should be the recipient phone number in E.164 format (for example `"+15550199999"`).

Requires `notifkit` as a peer dependency.
Documentation: [notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
