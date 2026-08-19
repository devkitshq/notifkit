# @notifkit/provider-console

Console transport for [notifkit](https://github.com/devkitshq/notifkit). Prints
notifications to stdout instead of sending them, so you can exercise the whole
pipeline — routing, preferences, quiet hours, templates — without a provider
account or a real inbox.

```bash
npm install @notifkit/provider-console
```

```ts
import { ConsoleTransport } from "@notifkit/provider-console";

registry.register("email", new ConsoleTransport("email"));
```

Requires `notifkit` as a peer dependency. Documentation:
[notifkit.dev/docs](https://notifkit.dev/docs/). MIT licensed.
