# @notifkit/provider-expo

Expo Push transport for [notifkit](https://github.com/devkitshq/notifkit).
It delivers the `push` channel to the Expo push tokens that React Native apps
get from `expo-notifications`, and reports dead tokens back so notifkit can
deactivate them. It calls Expo's push API with `fetch` and has no other
dependencies.

```bash
npm install @notifkit/provider-expo
```

```ts
import { NotifkitServer } from "notifkit";
import { ExpoTransport } from "@notifkit/provider-expo";

const expo = new ExpoTransport({
  // Only if the Expo project has enhanced push security turned on:
  accessToken: process.env.EXPO_ACCESS_TOKEN,
});

const server = new NotifkitServer({
  services: ["all"],
  providers: [expo],
});
```

Without enhanced push security, Expo needs no credentials from the server. If
the project turned it on, pass an Expo access token as `accessToken`; sends
without it fail with `UNAUTHORIZED`. See Expo's
[sending notifications](https://docs.expo.dev/push-notifications/sending-notifications/)
guide.

A recipient's `push` contact target is the destination, so it holds the token
the app got from `getExpoPushTokenAsync()`, such as
`ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]`:

```ts
await notifkit.addContact("usr_123", {
  channel: "push",
  target: "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
});
```

A push target that isn't an `ExponentPushToken[...]` or `ExpoPushToken[...]`
is treated as a dead token, so notifkit deactivates it. notifkit tries a
channel's transports in order and stops at a dead token, so don't register
this transport next to `@notifkit/provider-fcm` for contacts that hold FCM
registration tokens: whichever transport runs first would deactivate the
other's tokens.

## Options

| Option        | What it's for                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `accessToken` | Expo access token, sent as `Authorization: Bearer <token>`. Needed only when the project has enhanced push security turned on. |
| `logger`      | Optional notifkit logger.                                                                                                      |
| `limits`      | Send rate, `{ limit, windowSeconds }`. Defaults to `{ limit: 600, windowSeconds: 1 }`, Expo's limit per project.               |

## Templates

Templates render into `subject`, which becomes the notification's `title`,
and `text` (or `body`). The notification's `data` carries notifkit's
`eventId` and `taskId`.

## Failures and retries

The transport decides from Expo's answer:

- `DeviceNotRegistered` marks the token dead, and notifkit deactivates it.
- `MessageTooBig`, `InvalidCredentials`, `MismatchSenderId` and
  `InvalidProviderToken` fail the task without a retry, since sending the
  same message again can't succeed until the message or the project's push
  credentials change.
- A refused request (a 4xx such as `UNAUTHORIZED`) fails without a retry,
  except 408 and 429.
- `MessageRateExceeded` and a 429 mean Expo or the device wants fewer sends:
  notifkit waits for capacity, and the wait doesn't use up a retry.
- 5xx, timeouts and network errors are retried.

Each send is cancelled when it reaches notifkit's send timeout, 10 seconds by
default.

## Push receipts aren't checked yet

Expo answers a send with a push ticket, and this transport reports that
ticket's result. The delivery outcome from Apple or Google comes later, as a
push receipt that has to be fetched with the ticket id, about 15 minutes
after the send. This package doesn't fetch receipts yet, so a token that
Apple or Google reports as unregistered only in its receipt isn't
deactivated, and errors that only appear in receipts aren't seen. The ticket
id is stored as the delivery's `providerMessageId`, so receipts can be
fetched for it later.

Requires `notifkit` as a peer dependency. Documentation:
[notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
