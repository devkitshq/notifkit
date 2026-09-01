# @notifkit/provider-slack

Slack transport for [notifkit](https://github.com/devkitshq/notifkit). Registers
against the `webhook` channel and posts through either a Slack bot token
(`chat.postMessage`) or a plain Incoming Webhook URL — whichever a recipient's
stored contact target resolves to.

```bash
npm install @notifkit/provider-slack
```

```ts
import { SlackTransport } from "@notifkit/provider-slack";

registry.register(
  "webhook",
  new SlackTransport({
    botToken: process.env.SLACK_BOT_TOKEN, // xoxb-...
  }),
);
```

A recipient's `webhook` contact target decides how the message is delivered:

- A Slack **channel ID** (`C0123456789`) or **user ID** (`U0123456789`, for a
  DM) is sent via `chat.postMessage` using `botToken`.
- A full **Incoming Webhook URL** (`https://hooks.slack.com/services/...`) is
  posted to directly — no bot token required, so a single-channel integration
  needs nothing but that URL.

A template may also pin its own channel with a `channel` field in its
content, the same way other transports let a template override their default
sender — useful for routing everything to one shared room (e.g.
`system-alerts`) regardless of the recipient's own contact target.

Templates render into `text` (or `body`) and, optionally, a Slack
[Block Kit](https://api.slack.com/block-kit) `blocks` array:

```ts
await notifkit.syncTemplates({
  templates: [
    {
      id: "deploy-failed",
      channel: "webhook",
      content: {
        text: "Deploy failed for {{service}}",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "*Deploy failed* for `{{service}}`" },
          },
        ],
      },
    },
  ],
});
```

A destination Slack reports as gone (`channel_not_found`, `is_archived`,
`user_not_found`, …) is returned as an invalid token, so notifkit stops
retrying it and can flag the contact. Requires `notifkit` as a peer
dependency. Documentation: [notifkit.dev/docs](https://notifkit.dev/docs/).
MIT licensed.
