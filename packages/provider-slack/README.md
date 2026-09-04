# @notifkit/provider-slack

Slack transport for [notifkit](https://github.com/devkitshq/notifkit). Registers
against the `webhook` channel and posts through either a Slack bot token
(`chat.postMessage`) or a plain Incoming Webhook URL — whichever a recipient's
stored contact target resolves to.

```bash
npm install @notifkit/provider-slack
```

```ts
import { NotifkitServer } from "notifkit";
import { SlackTransport } from "@notifkit/provider-slack";

const server = new NotifkitServer({
  services: ["all"],
  providers: [
    new SlackTransport({
      botToken: process.env.SLACK_BOT_TOKEN, // xoxb-...
    }),
  ],
});
```

## Whichever credential you have

`SlackTransport` picks up whatever you give it — there's no one required
shape:

| Option                      | What it's for                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `botToken` (or `token`)     | A bot/user OAuth token (`xoxb-...`/`xoxp-...`). Needed for `chat.postMessage` sends to a channel or user ID.                             |
| `webhookUrl`                | A default Incoming Webhook URL, used when a message names no destination of its own. Lets a single-channel setup skip contacts entirely. |
| `appId`                     | Purely descriptive — shows up in log lines so you can tell multiple Slack app installations apart. Doesn't affect sending.               |
| `clientId` / `clientSecret` | Accepted, but **not** used to authenticate sends — see below.                                                                            |

A recipient's `webhook` contact target (or a template's own `channel`
override, or the transport's `webhookUrl` fallback) decides how the message
is actually delivered:

- A Slack **channel ID** (`C0123456789`) or **user ID** (`U0123456789`, for a
  DM) is sent via `chat.postMessage` using `botToken`/`token`.
- A full **Incoming Webhook URL** (`https://hooks.slack.com/services/...`) is
  posted to directly — no token required, so a single-channel integration
  needs nothing but that URL.

A template may also pin its own channel with a `channel` field in its
content, the same way other transports let a template override their default
sender — useful for routing everything to one shared room (e.g.
`system-alerts`) regardless of the recipient's own contact target.

### About `clientId` / `clientSecret`

These authenticate Slack's OAuth **install** flow — exchanging a workspace
admin's "Add to Slack" click for a token — not an individual send. This
transport doesn't perform that exchange, so passing only `clientId`/
`clientSecret` with no `botToken`/`token` logs a warning and every send still
fails until you complete the OAuth handshake yourself (or use a static bot
token from **OAuth & Permissions** in your Slack app's settings, which needs
no OAuth flow at all for a single workspace).

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
