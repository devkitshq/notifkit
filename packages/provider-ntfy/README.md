# @notifkit/provider-ntfy

ntfy push notification transport for [notifkit](https://github.com/devkitshq/notifkit).
Publishes notifications to `https://ntfy.sh` or a self-hosted ntfy server with
zero runtime dependencies.

```bash
npm install @notifkit/provider-ntfy
```

```ts
import { NtfyTransport } from "@notifkit/provider-ntfy";

registry.register(
  "push",
  new NtfyTransport({
    serverUrl: process.env.NTFY_SERVER_URL ?? "https://ntfy.sh",
    accessToken: process.env.NTFY_ACCESS_TOKEN,
  }),
);
```

## Options

- `serverUrl` (optional): base URL of the ntfy server (defaults to `"https://ntfy.sh"`).
- `accessToken` (optional): Bearer access token for protected topics (`Authorization: Bearer <token>`).
- `limits` (optional): rate limit configuration (defaults to `{ limit: 1000, windowSeconds: 10 }`).
- `logger` (optional): notifkit `Logger` instance.

## Destination

`task.destination` should be the ntfy topic name matching `/^[-_A-Za-z0-9]{1,64}$/` (for example `"deploy-alerts"`).

Requires `notifkit` as a peer dependency.
Documentation: [notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
