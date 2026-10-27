<div align="center">

# notifkit

**You shouldn't have to build a notification system.**

Self-hosted notification infrastructure for product notifications. One API call handles push, email, SMS, chat, and webhooks, with preferences, quiet hours, retries, fallback, scheduling, workflows, an admin dashboard, and delivery logs built in.

[![npm version](https://img.shields.io/npm/v/notifkit.svg?style=flat-square&color=6366f1)](https://www.npmjs.com/package/notifkit) [![npm downloads](https://img.shields.io/npm/dm/notifkit.svg?style=flat-square&color=6366f1)](https://www.npmjs.com/package/notifkit) [![Coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/devkitshq/notifkit/badges/coverage.json&style=flat-square)](https://github.com/devkitshq/notifkit/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178c6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Node.js](https://img.shields.io/badge/node-%3E%3D22.0.0-339933.svg?style=flat-square)](https://nodejs.org) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](./LICENSE)

[Documentation](https://notifkit.dev/docs/) · [Quickstart](https://notifkit.dev/docs/quickstart.html) · [Examples](https://notifkit.dev/docs/examples.html) · [notifkit.dev](https://notifkit.dev)

https://github.com/user-attachments/assets/ad8955bd-4205-4d47-8dfc-9010abd3ad62
[note: this video is generated using claude]

</div>

Like Knock or Courier, except it runs on the PostgreSQL and Redis you already have, your workflows live in your code, and there is no per-message bill.

```ts
await notifkit.notify({
  user: "usr_123",
  template: "order-shipped",
  channels: ["push", "email"],
  fallback: true,
});
```

That call tries push, then email if push fails. Preferences, consent, quiet hours, retries, deduplication, throttling, template rendering, and delivery tracking all happen behind it.

## Why notifkit

- **Doesn't lose messages.** Redis Streams consumer groups, 24-hour idempotency, retries, circuit breakers and a replayable dead-letter queue. [Chaos-tested](./tests/chaos): workers killed with `SIGKILL` mid-stream, Redis and PostgreSQL restarted under load, Redis wiped, and 100k messages with flat memory.
- **Runs on a small box.** 200 notifications/sec sustained on 2 vCPUs, over a 15-minute soak with provider failures, retries and webhooks. [Method and numbers →](https://notifkit.dev/articles/notifications-on-a-25-dollar-server.html)
- **Runs in production.** About 260K notifications a day (8M a month) of email, push and OTPs at our own company.
- **Your stack, your data.** PostgreSQL and Redis you already run, provider accounts you already have, and nothing that bills per send. Trust me it will save you $$$
- **Workflows in code.** Multi-step sequences that wait days, block on events and survive restarts, written in TypeScript and kept in git.

## Quickstart

You need Node 22+ and Docker running. In development notifkit starts throwaway PostgreSQL and Redis containers for you.

```bash
npm create notifkit@latest my-app   # or: npx notifkit create my-app
cd my-app
npm run dev                         # leave it running
```

In a second terminal:

```bash
npm run setup                       # create a project, save its API key to .env
npm run send                        # send a test notification
```

The default provider prints notifications to the server terminal, so you need no provider account to try it. Pass `--provider resend`, `twilio` or `fcm` to start with a real one. See [create-notifkit](./packages/create-notifkit) for the options.

To add notifkit to an app you already have, or to see what each generated file does, follow the [full quickstart](https://notifkit.dev/docs/quickstart.html). For production, see [Deployment](https://notifkit.dev/docs/deployment.html).

## How it compares

|                  | notifkit                    | Novu                                           |
| :--------------- | :-------------------------- | :--------------------------------------------- |
| Self-hosted      | Yes                         | Yes                                            |
| Storage          | PostgreSQL + Redis          | MongoDB + Redis                                |
| Workflows        | TypeScript in your codebase | Code via a bridge endpoint, or a visual editor |
| Channel fallback | Built in: `fallback: true`  | Built from workflow step conditions            |
| In-app inbox UI  | No                          | Yes                                            |
| Admin dashboard  | Yes                         | Yes                                            |
| MCP server       | Yes                         | Yes                                            |
| License          | MIT, no paid edition        | MIT core, commercial enterprise modules        |

**Knock and Courier** are hosted SaaS. Both have a free tier of about 10k notifications a month; past that, Knock's Starter plan is $250/month for 50k plus $5 per extra 1,000, and Courier bills per send. notifkit costs whatever your Postgres and Redis cost. _(Pricing checked October 2026. See their pricing pages for current numbers.)_

If you need an in-app inbox or 75 provider adapters today, Novu is the more complete choice. Choose notifkit if you want reliability features like provider fallback without a commercial license, a small codebase you can read, and published failure testing.

Longer comparisons: [Novu](https://notifkit.dev/docs/vs/novu.html) · [Knock](https://notifkit.dev/docs/vs/knock.html) · [Courier](https://notifkit.dev/docs/vs/courier.html)

## What it handles

| The question                                | What notifkit does                                                  |
| :------------------------------------------ | :------------------------------------------------------------------ |
| "What happens when a provider goes down?"   | Circuit breakers, exponential backoff, DLQ replay                   |
| "What if a worker dies mid-send?"           | Consumer groups reclaim and replay in-flight messages               |
| "Will a retried request send twice?"        | Same `X-Idempotency-Key` within 24 hours is delivered once          |
| "What if push fails?"                       | Falls back to the next channel you listed: SMS, then email          |
| "What if the user is asleep?"               | Quiet hours in the user's timezone; the send waits for the window   |
| "What about OTPs during a marketing blast?" | `critical` runs on its own lane and skips quiet hours               |
| "What if they unsubscribed?"                | RFC 8058 one-click unsubscribe; bounces and complaints suppress too |
| "Can several apps share one deployment?"    | Projects, each with its own API keys, data and rate limit           |
| "Can my Python or Go service use it?"       | Yes. It is a REST API; the TypeScript SDK is optional               |

## Providers

Bring your own provider accounts. First-party packages:

- [`@notifkit/provider-resend`](./packages/provider-resend): transactional email via Resend
- [`@notifkit/provider-fcm`](./packages/provider-fcm): push notifications via Firebase Cloud Messaging
- [`@notifkit/provider-twilio`](./packages/provider-twilio): SMS via Twilio, with signature-verified delivery status callbacks
- [`@notifkit/provider-slack`](./packages/provider-slack): Slack messages via Incoming Webhooks or the Web API
- [`@notifkit/provider-telegram`](./packages/provider-telegram): messages via a Telegram bot
- [`@notifkit/provider-discord`](./packages/provider-discord): messages via a Discord webhook
- [`@notifkit/provider-whatsapp`](./packages/provider-whatsapp): messages via Meta's WhatsApp Cloud API
- [`@notifkit/provider-console`](./packages/provider-console): prints instead of sending, for development and tests

For anything else, implement a `Transport`:

```ts
class MyTransport implements Transport {
  async send(message) {
    // Send through SES, Postmark, APNs,
    // SendGrid, a custom webhook, or anything else.
  }
}
```

## Run it from your AI agent

Connect the notifkit MCP server to Claude Code, Cursor, or any MCP client:

```bash
claude mcp add notifkit \
  --env NOTIFKIT_URL=http://localhost:3000 \
  --env NOTIFKIT_API_KEY=nk_live_... \
  -- npx -y @notifkit/mcp
```

Then ask things like "why didn't usr_9182 get their password reset?" or "how did yesterday's spring-sale campaign do?". [MCP docs →](https://notifkit.dev/docs/mcp.html)

Already have notification code scattered across your app? Point your coding agent at `https://notifkit.dev/llms-full.txt` and ask it to refactor that code into notifkit calls.

## Admin dashboard

Templates, workflows, and routing live in your code. The dashboard at `/admin` is an optional ops console: a live activity feed, delivery logs, queue depth per priority lane, workflow runs step by step, dead-letter replay, scheduled-send cancellation, and project and API key management.

To sign in, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` before starting the server, then open `http://localhost:3000/admin`.

## Documentation

Everything lives at **[notifkit.dev/docs](https://notifkit.dev/docs/)**: [concepts](https://notifkit.dev/docs/concepts.html), [routing and fallback](https://notifkit.dev/docs/guides/routing.html), [preferences](https://notifkit.dev/docs/guides/preferences.html), [workflows](https://notifkit.dev/docs/guides/workflows.html), [architecture](https://notifkit.dev/docs/architecture.html), [operations](https://notifkit.dev/docs/operations.html) and the [API reference](https://notifkit.dev/docs/reference.html).

## Contributing

Issues and pull requests are welcome.

```bash
npm install
npm run build
npm run build:dashboard
npm test
```

The test suite starts its own PostgreSQL and Redis containers, so Docker is the only thing you need running.

Questions, bugs, or ideas: [contact.devkitshq@gmail.com](mailto:contact.devkitshq@gmail.com), or open an issue. If notifkit saved you from building notification plumbing, a [star](https://github.com/devkitshq/notifkit) helps other developers find it.

## License

MIT. Use it for anything, including commercially. Every feature is in this repository: there is no paid edition and no hosted tier.
