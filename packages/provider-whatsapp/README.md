# @notifkit/provider-whatsapp

WhatsApp transport for [notifkit](https://github.com/devkitshq/notifkit) via
Meta's WhatsApp Cloud API.

Registers under notifkit's native `channel: "whatsapp"` and delivers to the
recipient's existing `phone` field (the same field the `"sms"` channel uses).

```bash
npm install @notifkit/provider-whatsapp
```

```ts
import { WhatsAppTransport } from "@notifkit/provider-whatsapp";

registry.register(
  "whatsapp",
  new WhatsAppTransport({
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  }),
);
```

Reads `content.text` from the rendered template, same convention as SMS.

**Free tier:** Meta's Cloud API is free for roughly the first 1,000
business-initiated conversations per month per WABA, no per-message markup.

**24-hour session window:** Meta only allows free-form text like this outside
an active customer conversation if the recipient messaged you within the last
24 hours. A cold, business-initiated send (e.g. "order shipped" as someone's
first message) requires a pre-approved WhatsApp message _template_
(`type: "template"`), which this transport does not build — that needs a
template name and component params per message, which the current
`renderedContent.content` shape doesn't carry. Use this transport for session
messages and re-engagement flows, or extend `send()` to build a
`type: "template"` payload for cold outbound.

Requires `notifkit` as a peer dependency. Documentation:
[notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
