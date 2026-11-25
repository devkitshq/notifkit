# @notifkit/provider-web-push

Web Push transport for [notifkit](https://github.com/devkitshq/notifkit). Sends
push notifications to browsers through their own push service (Google's for
Chrome, Microsoft's for Edge, Mozilla's for Firefox, Apple's for Safari), signed
with your VAPID keys. No Firebase project or vendor account needed. Built on
[`web-push`](https://github.com/web-push-libs/web-push).

```bash
npm install @notifkit/provider-web-push
```

## Keys

A Web Push server identifies itself with a VAPID key pair. Make one once and
keep it: subscriptions made with one public key only accept pushes signed by
its private key.

```bash
npx web-push generate-vapid-keys
```

```ts
import { NotifkitServer } from "notifkit";
import { WebPushTransport } from "@notifkit/provider-web-push";

const server = new NotifkitServer({
  services: ["all"],
  providers: [
    new WebPushTransport({
      vapidSubject: "mailto:ops@example.com",
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY!,
      vapidPrivateKey: process.env.VAPID_PRIVATE_KEY!,
    }),
  ],
});
```

## Options

| Option            | Required | Description                                                                                                                                               |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vapidSubject`    | yes      | How push services can reach you: a `mailto:` address or an `https:` URL. Apple's push service refuses `localhost`.                                        |
| `vapidPublicKey`  | yes      | The VAPID public key, URL-safe base64. The browser subscribes with the same key.                                                                          |
| `vapidPrivateKey` | yes      | The VAPID private key, URL-safe base64. Keep it secret.                                                                                                   |
| `ttlSeconds`      | no       | How long a push service keeps a message for a device that is offline. Defaults to 4 weeks, the longest push services keep one. `0` delivers now or never. |
| `limits`          | no       | Local send rate. Defaults to `{ limit: 1000, windowSeconds: 60 }`.                                                                                        |
| `logger`          | no       | A notifkit `Logger`.                                                                                                                                      |

The keys and the subject are checked when the transport is created, including
that the public key belongs to the private one, so a wrong pair fails at
startup rather than on every send.

## In the browser

The destination is the browser's push subscription, stored as JSON. Register a
service worker that shows what arrives:

```js
// sw.js
self.addEventListener("push", (event) => {
  const { title, body, data } = event.data.json();
  event.waitUntil(self.registration.showNotification(title, { body, data }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.notification.data?.url)
    event.waitUntil(clients.openWindow(event.notification.data.url));
});
```

Then subscribe with your VAPID public key, after the user agreed to
notifications, and send the subscription to your server:

```js
const registration = await navigator.serviceWorker.register("/sw.js");
const subscription = await registration.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: VAPID_PUBLIC_KEY,
});
await fetch("/api/push-subscriptions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(subscription),
});
```

Your server registers it as the user's `push` contact, as the JSON the browser
sent (`{ endpoint, expirationTime, keys: { p256dh, auth } }`):

```ts
await notifkit.addContact("usr_123", {
  channel: "push",
  target: JSON.stringify(subscription),
});
```

Each browser the user subscribes from is one more contact. notifkit sends to
the `endpoint` in the subscription, so if your users are not trusted, check it
is a push service you expect before you store it.

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
        data: { url: "/orders/{{orderId}}" },
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

The service worker receives this JSON, encrypted for that browser alone:

```json
{
  "title": "Order shipped",
  "body": "Order #9481 is on its way.",
  "data": { "url": "/orders/9481", "eventId": "…", "taskId": "…" }
}
```

- **title**: the template's `title` (or `subject`).
- **body**: the template's `text` (or `body`).
- **data**: the template's `data` object, if it has one, plus notifkit's
  `eventId` and `taskId`.
- **Urgency**: from the notification's priority. `low` → `low`, `normal` →
  `normal`, `high` and `critical` → `high`. A device saving battery may hold
  back `low` messages.

Push services must accept 4,096 bytes of encrypted message, which leaves 3,993
bytes for the JSON. A larger one fails without being sent. The push service
answers with the message's URL in `Location` (`apns-id` from Apple), recorded as
the `providerMessageId`.

## Failed sends

A success means the push service accepted the message. It delivers it when the
browser is next online, within `ttlSeconds`.

- **404 or 410**: the browser unsubscribed, or the subscription expired. The
  contact is flagged so notifkit stops sending to it.
- **A subscription that cannot be used** (its endpoint is not an `https://`
  URL, or its keys are not keys): flagged the same way, without a request.
- **401, 403 and other 4xx**: permanent, not retried, and not flagged. A 401 or
  403 means the push service refused the VAPID signature, often because the
  browser subscribed with another public key.
- **429**: waits for capacity. **Timeouts, network errors and 5xx**: retried.
- **Redirects** are not followed: a push service answers a push itself.

### With other push providers

The `push` channel is shared, and notifkit tries each push provider in turn.
A target that is not a subscription (an FCM token, an ntfy topic) is left to
the next provider and not flagged.

`FcmTransport` is not as careful: it flags a target it cannot read. If you
register both, list `WebPushTransport` first, and know that a subscription
which reaches FCM, because Web Push failed or had no capacity left, will be
deactivated.

Requires `notifkit` as a peer dependency. Documentation:
[notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed; `web-push` is
MPL-2.0.
