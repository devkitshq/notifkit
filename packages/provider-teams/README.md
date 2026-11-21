# @notifkit/provider-teams

Microsoft Teams webhook transport for [notifkit](https://github.com/devkitshq/notifkit).
Sends Adaptive Card messages through a Teams Workflows webhook and reports
deleted workflows back so notifkit can deactivate the contact.

```bash
npm install @notifkit/provider-teams
```

```ts
import { NotifkitServer } from "notifkit";
import { TeamsTransport } from "@notifkit/provider-teams";

const server = new NotifkitServer({
  services: ["all"],
  providers: [new TeamsTransport()],
});
```

## Getting a webhook URL

Office 365 connectors (the old Teams "Incoming Webhook") were retired in May
2026, so create the webhook with Workflows instead. In the target Teams
channel: **••• → Workflows → "Post to a channel when a webhook request is
received"**, confirm the team and channel, save the flow, and copy the webhook
URL it shows. The URL is only shown once — the signature in its query string
is the only credential, so keep it secret. Unlike email or push, the webhook
URL _is_ the destination — register it as the contact target directly:

```ts
await notifkit.addContact("usr_123", {
  channel: "teams",
  target: "https://prod-12.westus.logic.azure.com/workflows/...",
});
```

Then register a template on the `teams` channel and send:

```ts
await notifkit.syncTemplates({
  templates: [
    {
      id: "order-shipped",
      channel: "teams",
      content: { text: "Order #{{orderId}} shipped!" },
    },
  ],
});

await notifkit.notify({
  user: "usr_123",
  template: "order-shipped",
  channels: ["teams"],
  data: { orderId: "9481" },
});
```

A template's content may set `card` to an [Adaptive Card
object](https://learn.microsoft.com/en-us/adaptive-cards/authoring-cards/getting-started)
to post that card instead of the default subject/body text blocks. Only
`https:` URLs on `*.logic.azure.com` or `*.api.powerplatform.com` are
accepted; anything else is rejected without sending. Requires `notifkit` as a
peer dependency. Documentation: [notifkit.dev/docs](https://notifkit.dev/docs/).
MIT licensed.
