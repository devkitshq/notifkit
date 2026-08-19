<div align="center">

# notifkit

**Self-hosted notification infrastructure.**
One call delivers to email, SMS, push, and webhook — routed by preference, quiet hours, and consent.

[Documentation](https://notifkit.dev/docs/) · [Quickstart](https://notifkit.dev/docs/quickstart.html) · [Examples](https://notifkit.dev/docs/examples.html) · [notifkit.dev](https://notifkit.dev)

</div>

---

## Install

```bash
npm install notifkit
```

Node 22+, PostgreSQL, and Redis. Migrations ship in the package — point drizzle-kit at
`node_modules/notifkit/drizzle` — and in development notifkit starts throwaway Postgres
and Redis containers for you, so Docker is the only prerequisite to try it.

## What it does

Shipping one notification is easy. Shipping a notification _system_ is not: you end up with queues, retry logic, a preference store, quiet-hours maths, provider adapters, and a dead-letter queue nobody wants to own.

notifkit is that machinery, running on your servers. You describe **who** needs to know **what**; it works out **how** — the right channel, at a decent hour, only to people who said yes.

```ts
await notifkit.notify({
  user: "usr_123",
  template: "order-shipped",
  channels: ["push", "email"],
  fallback: true, // push first; email only if push fails
});
```

That call returns immediately. Behind it: preference and consent filtering, timezone-aware quiet hours, per-user throttling, template rendering, provider dispatch with retries and circuit breakers, and a durable log of what happened.

|                   |                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------- |
| **Channels**      | `email`, `sms`, `push`, `webhook`                                                   |
| **Targeting**     | A user, a list of users, a segment, or a topic                                      |
| **Priorities**    | `low`, `normal`, `high`, `critical` — separate stream lanes                         |
| **Scheduling**    | Future sends with `sendAt`, quiet-hours deferral, cancel before dispatch            |
| **Preferences**   | Per-user channel and topic opt-outs, quiet hours, contact-level overrides           |
| **Workflows**     | Multi-step sequences with `wait`, `waitForEvent`, and `notify` steps                |
| **Reliability**   | Redis Streams, 24h idempotency, backoff retries, DLQ, provider circuit breakers     |
| **Templates**     | `{{var}}` interpolation with escaping decided by the destination field              |
| **AI**            | Optional LLM augmentation before render, via the Vercel AI SDK                      |
| **Multi-tenancy** | Projects with isolated keys, data, and rate limits                                  |
| **Consent**       | RFC 8058 one-click unsubscribe; complaints and hard bounces suppress automatically  |
| **Reporting**     | Tag a send with a `campaign` label, then read delivery and engagement totals back   |
| **Agents**        | An MCP server ([`@notifkit/mcp`](./packages/mcp)) driving all of it from a terminal |
| **Observability** | Prometheus `/metrics`, `/health`, `/live`, `/ready`, and a queryable delivery log   |

Bring your own provider accounts — first-party packages ship for Resend and Firebase Cloud Messaging, and anything else is one `Transport` class with a `send()` method. Your keys, your billing, your deliverability.

**Requirements:** Node 22+, PostgreSQL, Redis. In development notifkit starts throwaway Postgres and Redis containers for you, so the only prerequisite to try it is Docker.

**What it is not:** a marketing automation suite. It is infrastructure for product notifications.

## Documentation

Everything lives at **[notifkit.dev/docs](https://notifkit.dev/docs/)**.

|                                                                                |                                                            |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| [Quickstart](https://notifkit.dev/docs/quickstart.html)                        | Install to first delivered notification, about ten minutes |
| [How it works](https://notifkit.dev/docs/concepts.html)                        | The five nouns and the pipeline they move through          |
| [Channels & fallback](https://notifkit.dev/docs/guides/routing.html)           | Multicast, ordered fallback, writing a transport           |
| [Preferences & quiet hours](https://notifkit.dev/docs/guides/preferences.html) | The four gates every notification passes                   |
| [Templates & AI](https://notifkit.dev/docs/guides/templates.html)              | Interpolation, escaping, per-channel content               |
| [Segments & scheduling](https://notifkit.dev/docs/guides/segments.html)        | Fan-out, priority lanes, `sendAt`, idempotency             |
| [Workflows](https://notifkit.dev/docs/guides/workflows.html)                   | Multi-step sequences, recurring sends, digests             |
| [Examples](https://notifkit.dev/docs/examples.html)                            | The five runnable projects in [`examples/`](./examples)    |
| [Architecture](https://notifkit.dev/docs/architecture.html)                    | Streams, delivery guarantees, topologies, data model       |
| [Deployment](https://notifkit.dev/docs/deployment.html)                        | Dockerfile, Compose, splitting API from workers            |
| [Operations](https://notifkit.dev/docs/operations.html)                        | Health, metrics, the DLQ, key rotation, shutdown           |
| [Reference](https://notifkit.dev/docs/reference.html)                          | Every endpoint, payload shape, and SDK method              |
| [MCP server](https://notifkit.dev/docs/mcp.html)                               | Send and report on campaigns from a terminal agent         |

## Star the repo

If notifkit saves you a month or two you were about to spend building this yourself, **[give it a star](https://github.com/devkitshq/notifkit)** — it is the cheapest way to help other people find it.

## Contributing

Issues and pull requests are welcome. `npm install && npm run build`, then `npm test` — the suite starts its own Postgres and Redis containers, so Docker is the only thing you need running.

## License

MIT. Do what you like with it, including commercially. See [LICENSE](./LICENSE).
