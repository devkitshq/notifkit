# @notifkit/provider-discord

Discord webhook transport for [notifkit](https://github.com/devkitshq/notifkit).
Sends messages through an incoming Discord webhook and reports deleted/invalid
webhooks back so notifkit can deactivate the contact.

```bash
npm install @notifkit/provider-discord
```

```ts
import { NotifkitServer } from "notifkit";
import { DiscordTransport } from "@notifkit/provider-discord";

const server = new NotifkitServer({
  services: ["all"],
  providers: [new DiscordTransport()],
});
```

## Getting a webhook URL

In the target Discord channel: **Edit Channel → Integrations → Webhooks →
New Webhook**, then copy its URL. Unlike email or push, the webhook URL _is_
the destination — register it as the contact target directly:

```ts
await notifkit.addContact("usr_123", {
  channel: "discord",
  target: "https://discord.com/api/webhooks/123456789012345678/abcdef...",
});
```

Then register a template on the `discord` channel and send:

```ts
await notifkit.syncTemplates({
  templates: [
    {
      id: "order-shipped",
      channel: "discord",
      content: { text: "Order #{{orderId}} shipped!" },
    },
  ],
});

await notifkit.notify({
  user: "usr_123",
  template: "order-shipped",
  channels: ["discord"],
  data: { orderId: "9481" },
});
```

A template's content may set `username` and `avatarUrl` to override the
webhook's default identity per message, and `embeds` (an array of [Discord
embed objects](https://discord.com/developers/docs/resources/webhook#execute-webhook))
for richer formatting. Requires `notifkit` as a peer dependency.
Documentation: [notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
