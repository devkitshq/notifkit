# @notifkit/provider-ntfy

[ntfy](https://ntfy.sh) push transport for
[notifkit](https://github.com/devkitshq/notifkit). Publishes to an ntfy topic
on the public ntfy.sh server or on your own, so anyone subscribed to that topic
in the ntfy app (Android, iOS or web) gets the notification. No account or SDK
needed: a send is one HTTP request.

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

| Option        | Required | Description                                                                                                                                                |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serverUrl`   | no       | The ntfy server, `https://ntfy.sh` by default. Point it at a self-hosted server (`https://ntfy.example.com`), also one behind a path.                      |
| `accessToken` | no       | An access token (`tk_…`) for topics that require one: a reserved topic on ntfy.sh, or a server with access control. Sent as `Authorization: Bearer`.       |
| `limits`      | no       | Local send rate. Defaults to `{ limit: 60, windowSeconds: 300 }`, inside ntfy's default per-visitor limit. Raise it for a server or tier that allows more. |
| `logger`      | no       | A notifkit `Logger`.                                                                                                                                       |

## Topics

The destination is a topic name, not a device token. Whoever subscribes to the
topic in the ntfy app receives what is published to it. Give each recipient
their own topic and register it as their `push` contact:

```ts
await notifkit.addContact("usr_123", {
  channel: "push",
  target: "acme-alerts-usr123-k3v9x2",
});
```

A topic name is 1 to 64 letters, digits, `-` or `_`; anything else is refused
without calling ntfy. On ntfy.sh topics are public: anyone who knows a name can
read it and publish to it, so pick names that are hard to guess, or
[reserve them](https://docs.ntfy.sh/publish/#authentication) and set
`accessToken`.

Then register a template on the `push` channel and send:

```ts
await notifkit.syncTemplates({
  templates: [
    {
      id: "order-shipped",
      channel: "push",
      content: { title: "Order shipped", body: "Order #{{orderId}} is on its way." },
    },
  ],
});

await notifkit.notify({
  user: "usr_123",
  template: "order-shipped",
  channels: ["push"],
  priority: "high",
  data: { orderId: "9481" },
});
```

## What is sent

- **Message**: the template's `text` (or `body`), up to 4,095 bytes. ntfy turns
  a message of 4,096 bytes or more into a file attachment, so a longer one is
  cut and ends in "…". A template with only a title sends the title as the
  message.
- **Title**: the template's `title` (or `subject`), on one line, up to 1,024
  bytes. Accents and emoji are fine: they are sent as RFC 2047 encoded words,
  which ntfy decodes.
- **Priority**: from the notification's priority. `low` → 2, `normal` → 3 (ntfy's
  default), `high` → 4, `critical` → 5 (urgent: long vibration bursts on
  Android).

ntfy answers with the message `id`, recorded as the `providerMessageId`.

## Failed sends

ntfy has no delivery receipts, so a successful send means the server accepted
the message for the topic. A missing or invalid topic, a rejected token (401),
a topic the token may not write to (403) and any other 4xx are permanent and
not retried. None of them flags the contact: on the shared `push` channel the
target may be another provider's device token, and ntfy has no answer that
means a topic is gone (its 410 is for UnifiedPush publishes, which this
provider doesn't send). A rate limit (429) waits for capacity; timeouts,
network errors and 5xx are retried.

A redirect is not followed: it would turn the publish into a GET that returns a
page with a 200 and publishes nothing. It fails the send instead, as does a
reply without a message id. Both point at the configuration, for example an
`http://` server URL that redirects to `https://`, or the topic `docs`, which
ntfy.sh redirects to its documentation.

Requires `notifkit` as a peer dependency. Documentation:
[notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
