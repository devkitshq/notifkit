# @notifkit/provider-onesignal

[OneSignal](https://onesignal.com) push transport for
[notifkit](https://github.com/devkitshq/notifkit). Sends to devices and browsers
already registered in a OneSignal app, through the OneSignal REST API. No SDK:
a send is one HTTP request.

```bash
npm install @notifkit/provider-onesignal
```

```ts
import { NotifkitServer } from "notifkit";
import { OneSignalTransport } from "@notifkit/provider-onesignal";

const server = new NotifkitServer({
  services: ["all"],
  providers: [
    new OneSignalTransport({
      appId: process.env.ONESIGNAL_APP_ID!,
      apiKey: process.env.ONESIGNAL_API_KEY!,
    }),
  ],
});
```

## Options

| Option   | Required | Description                                                                                                                            |
| -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `appId`  | yes      | The OneSignal app's id, a UUID (Settings → Keys & IDs).                                                                                |
| `apiKey` | yes      | An App API key of that app (`os_v2_app_…`), sent as `Authorization: Key`. Not the key's id, which the dashboard shows next to it.      |
| `limits` | no       | Local send rate. Defaults to `{ limit: 150, windowSeconds: 1 }`, OneSignal's per-app limit on the free plan. Paid plans allow 6,000/s. |
| `logger` | no       | A notifkit `Logger`.                                                                                                                   |

The app id and the key are checked when the transport is created, so a missing
one fails at startup rather than on every send.

## Subscriptions

The destination is a OneSignal subscription id: one device or browser that
subscribed through a OneSignal SDK. In a web app using the OneSignal Web SDK,
it is `OneSignal.User.PushSubscription.id`; mobile SDKs expose the same id.
Send it to your server and register it as the user's `push` contact:

```ts
await notifkit.addContact("usr_123", {
  channel: "push",
  target: "1dd608f2-c6a1-11e3-851d-000c2940e62c",
});
```

A destination that is not a UUID is refused without a request, and not flagged:
on the shared `push` channel it is another provider's target (an FCM token, a
Web Push subscription), and `accepts()` keeps delivery from handing it to
OneSignal in the first place.

Then register a template on the `push` channel and send:

```ts
await notifkit.syncTemplates({
  templates: [
    {
      id: "order-shipped",
      channel: "push",
      content: {
        title: "Order shipped",
        body: "Order #{{orderId}} is on its way.",
        data: { orderId: "{{orderId}}" },
      },
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

## What is sent

- **contents**: the template's `text` (or `body`), in `en`, which OneSignal
  requires. A template with only a title sends the title here instead.
- **headings**: the template's `title` (or `subject`). On the web, OneSignal
  shows the site name when there is none.
- **data**: the template's `data` object, if it has one, plus notifkit's
  `eventId` and `taskId`, for the app to read when the notification arrives or
  is opened.
- **priority**: from the notification's priority. `high` and `critical` → 10,
  `low` and `normal` → 5, which a device saving battery may hold back.
- **idempotency_key**: a UUID derived from the task id, the same on every
  attempt. If a send times out after OneSignal created the message, the retry
  gets that message back instead of sending a second notification.

OneSignal answers with the message `id`, recorded as the `providerMessageId`.

## Failed sends

- **Unsubscribed**: OneSignal answers 200 but sends nothing to a subscription
  that unsubscribed or revoked permission. It says so in `errors`, either
  `All included players are not subscribed` or the id listed in
  `invalid_player_ids`. The contact is flagged so notifkit stops sending to it.
- **400, 401, 403 and other 4xx**: permanent, not retried, and not flagged. A
  401 or 403 is the key, or the app's plan, refusing the request.
- **429**: waits for capacity. **Timeouts, network errors and 5xx**: retried,
  with the same idempotency key.
- **Redirects** are not followed, and a 200 without a message id is not a
  success.

Requires `notifkit` as a peer dependency. Documentation:
[notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
