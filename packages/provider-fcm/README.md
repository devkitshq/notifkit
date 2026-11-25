# @notifkit/provider-fcm

Firebase Cloud Messaging push transport for
[notifkit](https://github.com/devkitshq/notifkit). Delivers to FCM registration
tokens and reports invalid ones back so notifkit can deactivate them.

```bash
npm install @notifkit/provider-fcm
```

```ts
import { NotifkitServer } from "notifkit";
import { FcmTransport } from "@notifkit/provider-fcm";

const server = new NotifkitServer({
  services: ["all"],
  providers: [
    new FcmTransport({
      serviceAccountJson: process.env.FCM_SERVICE_ACCOUNT_JSON!,
    }),
  ],
});
```

Requires `notifkit` as a peer dependency and a Firebase service account.
Documentation: [notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
