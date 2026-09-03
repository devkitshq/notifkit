# @notifkit/provider-telegram

Telegram Bot API transport for [notifkit](https://github.com/devkitshq/notifkit).
Sends messages through a Telegram bot to a chat id, and reports blocked/kicked
bots back so notifkit can deactivate the contact.

```bash
npm install @notifkit/provider-telegram
```

```ts
import { NotifkitServer } from "notifkit";
import { TelegramTransport } from "@notifkit/provider-telegram";

const server = new NotifkitServer({
  services: ["all"],
  providers: [
    new TelegramTransport({
      botToken: process.env.TELEGRAM_BOT_TOKEN!,
    }),
  ],
});
```

## Getting a bot token

Message [@BotFather](https://t.me/BotFather) on Telegram, run `/newbot`, and
copy the token it gives you.

## Getting a chat id

A user must start a conversation with your bot before it can message them —
Telegram has no way to message someone who hasn't. Once they've sent `/start`,
read their chat id from `getUpdates` (or a webhook on your own bot) and
register it as their contact:

```ts
await notifkit.addContact("usr_123", { channel: "telegram", target: "5910738042" });
```

Then register a template on the `telegram` channel and send:

```ts
await notifkit.syncTemplates({
  templates: [
    {
      id: "order-shipped",
      channel: "telegram",
      content: { text: "Your order #{{orderId}} shipped!" },
    },
  ],
});

await notifkit.notify({
  user: "usr_123",
  template: "order-shipped",
  channels: ["telegram"],
  data: { orderId: "9481" },
});
```

A template's content may set `parseMode` (`"HTML"`, `"MarkdownV2"`, or
`"Markdown"`) to opt into formatted messages, `disableWebPagePreview` to
suppress link previews, and `disableNotification` for a silent send.
Requires `notifkit` as a peer dependency.
Documentation: [notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
