# @notifkit/provider-telnyx

Telnyx SMS transport for [notifkit](https://github.com/devkitshq/notifkit).
Sends through the Telnyx Messaging API v2 with plain `fetch` (no SDK) and
verifies delivery status callbacks with Ed25519, so undeliverable numbers
feed back into notifkit's suppression list automatically.

```bash
npm install @notifkit/provider-telnyx
```

```ts
import { TelnyxTransport } from "@notifkit/provider-telnyx";

registry.register(
  "sms",
  new TelnyxTransport({
    apiKey: process.env.TELNYX_API_KEY!,
    from: "+15550000001",
    webhookUrl: "https://api.example.com/webhooks/telnyx",
    webhookPublicKey: process.env.TELNYX_PUBLIC_KEY!,
  }),
);
```

A recipient's `sms` contact target is the destination, in E.164
(`+15550000002`). Templates render into `text` (or `body`); a template may also
carry its own `from`, the same way other transports let a template override
their default sender — useful when a support long code and a marketing short
code share one transport.

Send with a messaging profile instead of a sender number by passing
`messagingProfileId` in place of `from`. Telnyx takes one or the other, never
both; a template `from` wins over a configured profile id.

## Delivery status callbacks

`webhookUrl` must be the publicly reachable URL of this transport's webhook
route. The route is mounted at its path (`/webhooks/telnyx` above), and is
only mounted at all when the URL is configured: an unverifiable callback is
an anonymous, forgeable write into delivery history, so the transport fails
closed rather than accepting one. Passing `webhookUrl` also sends it as the
per-message `webhook_url`, so Telnyx posts delivery events for each message
there even when the messaging profile has no webhook URL of its own.

`webhookPublicKey` is the base64 Ed25519 public key from the Telnyx portal
(Mission Control → Account Settings → Keys & Credentials → Public Key). It
verifies signatures and is not secret, but it is not the API key. Every
webhook carries `telnyx-signature-ed25519`, a base64 Ed25519 signature over
`${telnyx-timestamp}|${rawBody}`, and `telnyx-timestamp`, Unix seconds. The
signature is checked against the exact bytes Telnyx sent, before they are
parsed, and a timestamp more than five minutes old is refused as a replay.

Enable v2 webhooks on the messaging profile so Telnyx sends
`message.finalized` once a message reaches its final state. What actually
happened arrives on the callback — a successful `send` means accepted, not
delivered:

| Telnyx status                              | notifkit event |
| ------------------------------------------ | -------------- |
| `delivery_failed` / `sending_failed`       | `bounced`      |
| `delivered` and other progress statuses    | ignored        |

Telnyx attaches no permanent-vs-transient code to these statuses, so the
bounce type is left unset (treated as soft): wrongly suppressing a working
number silently stops messages someone still wants.

## Failures

A send to a dead destination answers `422` with the `to` field named in the
error, and is returned as an invalid token — so notifkit stops retrying and
flags the contact. Other `4xx` refusals (except `408` and `429`) are permanent
failures without deactivating the contact. Timeouts, `5xx`, and `429` stay
retryable.

Requires `notifkit` as a peer dependency. Documentation:
[notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
