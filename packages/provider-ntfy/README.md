# @notifkit/provider-ntfy

ntfy push transport for [notifkit](https://github.com/devkitshq/notifkit).
Sends push messages to an [ntfy](https://ntfy.sh) topic — either the public
ntfy.sh server or a self-hosted one — with a single HTTP POST, and reports
invalid topics back so notifkit can deactivate the contact.

```bash
npm install @notifkit/provider-ntfy
```

```ts
import { NotifkitServer } from "notifkit";
import { NtfyTransport } from "@notifkit/provider-ntfy";

const server = new NotifkitServer({
  services: ["all"],
  providers: [new NtfyTransport()],
});
```

## Options

| Option        | Default           | Description                                                                      |
| ------------- | ----------------- | -------------------------------------------------------------------------------- |
| `serverUrl`   | `https://ntfy.sh` | Base URL of the ntfy server. Point it at your own server to self-host.           |
| `accessToken` | —                 | Sent as `Authorization: Bearer <token>` when set, for servers that require auth. |
| `logger`      | —                 | Optional notifkit logger.                                                        |

## Destination

The `destination` is an ntfy topic name: 1–64 characters of letters, digits,
`-` and `_`. Register it as the contact target directly:

```ts
await notifkit.addContact("usr_123", {
  channel: "push",
  target: "order-alerts",
});
```

Then register a template on the `push` channel and send:

```ts
await notifkit.syncTemplates({
  templates: [
    {
      id: "order-shipped",
      channel: "push",
      content: { text: "Order #{{orderId}} shipped!" },
    },
  ],
});

await notifkit.notify({
  user: "usr_123",
  template: "order-shipped",
  channels: ["push"],
  data: { orderId: "9481" },
});
```

The rendered message body is posted as plain text. A rendered `subject`
becomes the ntfy `Title` header, and the task priority maps to the ntfy
`Priority` header (`low` → 2, `normal` → 3, `high` → 4, `critical` → 5).
The response JSON `id` is recorded as the provider message id.

Subscribe to the topic with the ntfy app or `curl https://ntfy.sh/order-alerts/json`
to receive the push. Requires `notifkit` as a peer dependency.
Documentation: [notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
