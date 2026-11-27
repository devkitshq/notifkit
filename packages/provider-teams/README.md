# @notifkit/provider-teams

Microsoft Teams Workflows webhook transport for [notifkit](https://github.com/devkitshq/notifkit).
Sends Adaptive Card messages through a Microsoft Teams Workflows incoming webhook
(`*.logic.azure.com` or `*.api.powerplatform.com`) and flags deleted workflows (HTTP 404) so
notifkit can deactivate stale contacts.

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

## Creating a Workflows webhook in Microsoft Teams

Legacy Office 365 Connectors were retired in May 2026; create a Workflows webhook instead:

1. In Microsoft Teams, open the target channel's **More options (`...`) → Workflows**.
2. Choose the **"Post to a channel when a webhook request is received"** template.
3. Name the workflow, pick the team and channel, click **Add workflow**, and copy the generated webhook URL (`https://...logic.azure.com/...` or `https://...api.powerplatform.com/...`).

Register the webhook URL as the recipient's `teams` contact target:

```ts
await notifkit.addUser({
  id: "usr_123",
  contacts: [
    {
      channel: "teams",
      target: "https://prod-00.westus.logic.azure.com:443/workflows/...",
    },
  ],
});
```

Then register a template on the `teams` channel and send:

```ts
await notifkit.syncTemplates({
  templates: [
    {
      id: "order-shipped",
      channel: "teams",
      content: {
        subject: "Order #{{orderId}} shipped",
        body: "Your package is on its way.",
      },
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

Templates render `subject` (omitted when absent) and `body` (or `text`) into an Adaptive Card
`v1.4`. Set `content.card` to send a custom Adaptive Card object instead. Requires `notifkit` as a
peer dependency. Documentation: [notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
