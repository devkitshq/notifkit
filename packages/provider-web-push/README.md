# @notifkit/provider-web-push

Web Push (VAPID) browser push transport for [notifkit](https://github.com/devkitshq/notifkit).
Delivers push notifications directly to browser push services using `web-push`
and VAPID keys, with no Firebase dependency.

```bash
npm install @notifkit/provider-web-push
```

```ts
import { WebPushTransport } from "@notifkit/provider-web-push";

registry.register(
  "push",
  new WebPushTransport({
    subject: "mailto:notifications@example.com",
    publicKey: process.env.VAPID_PUBLIC_KEY!,
    privateKey: process.env.VAPID_PRIVATE_KEY!,
  }),
);
```

## Destination format

Because notifkit stores contact targets as strings while a browser
`PushSubscription` is a structured object (`{ endpoint, keys: { p256dh, auth } }`),
store the serialized JSON string from `JSON.stringify(subscription)` as the
contact target:

```ts
const subscription = await registration.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: vapidPublicKey,
});

await notifkit.addUser({
  id: "usr_123",
  contacts: {
    push: JSON.stringify(subscription),
  },
});
```

Malformed subscription JSON or expired subscriptions (`404`/`410`) return
`invalidToken: true` so notifkit deactivates the dead contact automatically.
Payloads exceeding 4 KB are rejected with `retryable: false`.

Requires `notifkit` as a peer dependency.
Documentation: [notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
