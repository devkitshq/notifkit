<div align="center">

# notifkit

**You shouldn't have to build a notification system.**

Self-hosted notification infrastructure for product notifications. One API call handles email, SMS, push, and webhooks, with preferences, quiet hours, retries, fallback, scheduling, workflows, and delivery logs built in.

[![npm version](https://img.shields.io/npm/v/notifkit.svg?style=flat-square&color=6366f1)](https://www.npmjs.com/package/notifkit) [![npm downloads](https://img.shields.io/npm/dm/notifkit.svg?style=flat-square&color=6366f1)](https://www.npmjs.com/package/notifkit) [![Coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/devkitshq/notifkit/badges/coverage.json&style=flat-square)](https://github.com/devkitshq/notifkit/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178c6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Node.js](https://img.shields.io/badge/node-%3E%3D22.0.0-339933.svg?style=flat-square)](https://nodejs.org) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](./LICENSE)

[Documentation](https://notifkit.dev/docs/) · [Quickstart](https://notifkit.dev/docs/quickstart.html) · [Examples](https://notifkit.dev/docs/examples.html) · [notifkit.dev](https://notifkit.dev)

</div>

### Sending one notification is easy

```ts
await sendEmail({
  to: user.email,
  subject: "Order Shipped",
  ...
});
```

Sending them reliably is the hard part. Users opt out. People are asleep. Push tokens die. Providers throw 503s. Channels fail and need fallback. Somewhere along the way you need timezone-aware quiet hours, future scheduling, deduplication, multi-channel templates, delivery logs, unsubscribe handling, multi-step workflows, and a dead-letter queue nobody wants to maintain.

notifkit is that machinery. Your app makes one typed call, and notifkit decides who gets the notification, which channel to use, when to send it, whether the user is allowed to receive it, and what to do when delivery fails.

```ts
import { notifkit } from "notifkit";

await notifkit.notify({
  user: "usr_123",
  template: "order-shipped",
  channels: ["push", "email"],
  fallback: true,
});
```

That call tries push, then email if push fails. Preferences, consent, quiet hours, retries, deduplication, throttling, template rendering, and delivery tracking all happen behind it.

## How it runs

notifkit is an orchestration engine and a typed SDK.

```mermaid
flowchart TD
    App["Your Application / AI Agent<br/>Typed SDK · REST API · MCP Server"]

    App -->|"HTTP POST /v1/notify"| API

    API["Notifkit API Server<br/>Schema Validation · Auth · Multi-Tenancy<br/>Idempotency Gate · Priority Queue Ingestion"]

    API --> PG
    API --> REDIS

    PG[("PostgreSQL — Storage<br/>Users · Preferences<br/>Templates · Workflows<br/>Delivery Logs · DLQ")]
    REDIS[("Redis — Streams / ZSET<br/>Priority Queues<br/>Scheduled Sends<br/>Sliding Rate Limits")]

    subgraph WORKERS["Background Workers Pipeline"]
        direction LR
        ENRICH["Enricher<br/>(Resolve)"] --> ENGINE["Engine<br/>(Quiet Hours)"] --> DELIVER["Delivery<br/>(Rate Limits / CB)"]
        ENGINE --> SCHED["Scheduler<br/>(sendAt / QH)"]
        SCHED --> DELIVER
    end

    REDIS -->|"consume"| ENRICH
    ENRICH -.->|"read / write state"| PG
    DELIVER -.->|"delivery logs"| PG
    DELIVER -->|"Dispatch"| PROVIDERS

    PROVIDERS["Provider Transports<br/>Email: Resend · Push: Firebase (FCM) · SMS: Twilio<br/>Chat: Slack, Telegram, Discord, WhatsApp<br/>Webhooks: Custom HTTP"]

    classDef entry stroke:#6366f1,stroke-width:2px
    classDef store stroke:#0ea5e9,stroke-width:2px
    classDef work stroke:#22c55e,stroke-width:2px
    class App,API,PROVIDERS entry
    class PG,REDIS store
    class ENRICH,ENGINE,DELIVER,SCHED work
```

`NotifkitServer` runs the HTTP REST API router (`/v1/notify`, `/health`, `/metrics`) and the background worker pipelines: enricher, decision engine, scheduler, and delivery. `NotifkitClient` is the lightweight client your application uses to trigger notifications, sync templates, and manage users over HTTP.

### Topologies

In a single process, the API and all workers run in the same Node.js process (`services: ["all"]`), which works for small and medium apps, side projects, and staging. Distributed, you run stateless API servers (`services: ["api"]`) behind a load balancer and scale worker pools (`services: ["enricher", "engine", "delivery", "scheduler"]`) horizontally across Redis Streams consumer groups.

## Quickstart

### 1. Install

```bash
npm install notifkit @notifkit/provider-resend
```

### 2. Run the engine and dispatch your first notification

```ts
import { NotifkitServer, NotifkitClient } from "notifkit";
import { ResendTransport } from "@notifkit/provider-resend";

// 1. Start the server (runs API + workers; auto-starts Postgres & Redis in dev)
const server = new NotifkitServer({
  services: ["all"],
  port: 3000,
  providers: [new ResendTransport({ apiKey: process.env.RESEND_API_KEY! })],
});
await server.start();

// 2. Instantiate client and register a template
const notifkit = new NotifkitClient({ baseUrl: "http://localhost:3000" });

await notifkit.syncTemplates({
  templates: [
    {
      id: "order-shipped",
      channel: "email",
      content: { subject: "Order #{{orderId}} Shipped", text: "Your order is on the way!" },
    },
  ],
});

// 3. Register user and dispatch
await notifkit.addUser({ id: "usr_123", email: "alex@acme.com" });

await notifkit.notify({
  user: "usr_123",
  template: "order-shipped",
  channels: ["email"],
  data: { orderId: "9481" },
});
```

### 3. Or call the REST API directly

The Node.js SDK is optional. notifkit exposes a standard HTTP REST API, so you can dispatch notifications and manage resources from any language (cURL, Python, Go, and so on):

```bash
curl -X POST http://localhost:3000/v1/notify \
  -H "Content-Type: application/json" \
  -d '{
    "user": "usr_123",
    "template": "order-shipped",
    "channels": ["email"],
    "data": { "orderId": "9481" }
  }'
```

### Development vs. production

Locally, Docker is the only prerequisite: in development notifkit starts throwaway PostgreSQL and Redis containers for you. In production you need Node 22+, PostgreSQL, and Redis, and you run migrations by pointing `drizzle-kit` at `node_modules/notifkit/drizzle`.

## Running in production

notifkit runs in production at my own company, delivering 100K+ notifications a day across email, push, and OTPs. I built it because I needed it and didn't want to spend months rebuilding distributed notification plumbing or pay a SaaS per alert. It runs on your servers, with your provider accounts and your data.

### Reliability and failure testing

Every component of the pipeline is tested against failure:

```mermaid
flowchart LR
    S1["Redis Streams"] -->|"Kill Worker (SIGKILL)"| M1["Auto-Claim and Replay"] --> O1["Zero Lost Messages"]
    S2["Connection Loss"] -->|"Drop DB / Redis"| M2["Auto-Reconnect / Retry"] --> O2["In-Flight State Intact"]
    S3["10k+ Messages"] -->|"Burst"| M3["Concurrency and Limits"] --> O3["Flat Memory, No Leaks"]

    classDef fault stroke:#ef4444,stroke-width:2px
    classDef guard stroke:#6366f1,stroke-width:2px
    classDef result stroke:#22c55e,stroke-width:2px
    class S1,S2,S3 fault
    class M1,M2,M3 guard
    class O1,O2,O3 result
```

- Crash testing (`tests/chaos/crash.test.ts`): background worker processes are killed with `SIGKILL` during high-throughput message streaming. Consumer group Pending Entries List (PEL) re-claims mean no messages are lost and another worker takes over.
- Infrastructure recovery (`tests/chaos/recovery.test.ts`): PostgreSQL and Redis connections are severed and restored under live traffic, verifying client reconnection, worker backpressure, and durable state resumption.
- Load testing (`tests/chaos/load.test.ts`): bursts of 10,000+ notifications across parallel worker pools, checking queue drain speed, sliding-window rate limiters, and memory use over time.
- Race conditions and concurrency (`tests/race-conditions.test.ts`, `tests/idempotency.test.ts`): concurrent duplicate dispatches, overlapping quiet-hour boundary evaluations, atomic user updates, and 24-hour idempotency key deduplication.
- Real containers, no mocks: unit, integration, and chaos suites all run against real PostgreSQL and Redis containers via [Testcontainers](https://testcontainers.com).

## What you get

| The problem you don't want to build                  | How notifkit solves it                                               |
| :--------------------------------------------------- | :------------------------------------------------------------------- |
| "Should this user receive it?"                       | User preferences, topic opt-outs, and consent gates                  |
| "Is this a bad time to send?"                        | Timezone-aware quiet hours that defer non-urgent sends               |
| "What if push fails?"                                | Ordered multi-channel fallback (`push`, then `email`, then `sms`)    |
| "What if my worker crashes?"                         | Redis Streams consumer groups, retries, and durable idempotency      |
| "What if an event fires twice?"                      | 24-hour deduplication via idempotency keys                           |
| "Can I send this later?"                             | Priority scheduling with `sendAt` and cancellation before dispatch   |
| "Can I send this 3 days after signup?"               | Stateful multi-step workflows with `wait` and `waitForEvent`         |
| "How do I know what happened?"                       | Queryable delivery logs, Prometheus metrics, and campaign reporting  |
| "What happens when a provider goes down?"            | Circuit breakers, exponential backoff, and DLQ replay                |
| "What about bounces and spam complaints?"            | RFC 8058 one-click unsubscribe and automatic hard-bounce suppression |
| "What if I don't want another SaaS holding my data?" | Fully self-hosted on your PostgreSQL and Redis                       |

You decide what to say. notifkit gets it there.

## Scope

notifkit is the durable notification layer that runs inside your own stack. It is not a marketing automation suite, and it does not replace Customer.io, OneSignal, or SendGrid. You bring your own provider accounts and pay them directly.

First-party providers cover Resend, Firebase Cloud Messaging, Slack, Twilio, Telegram, Discord, and WhatsApp. Anything else is a `Transport` class with a `send()` method.

### How this compares to Novu

Novu is the established open-source project in this space, and if you want a notification platform with a dashboard, a visual workflow editor, and a drop-in in-app inbox component, use Novu. It is more mature, has a much larger community, and solves a broader problem.

notifkit is a narrower, more embeddable take on the same layer:

- **A library first, a platform second.** notifkit is an npm package you can run inside your existing Node process. Novu self-hosts as a set of services (API, worker, WebSocket server, dashboard SPA) that you deploy and operate alongside your app.
- **Postgres, not MongoDB.** notifkit stores state in PostgreSQL with Drizzle migrations and queues in Redis Streams. If Postgres is already your database, there is no new datastore to run.
- **Workflows as code.** Multi-step sequences are typed TypeScript, versioned in your repo, rather than built in a visual editor.
- **MIT, all of it.** There is no open-core split. Novu is MIT at the core with enterprise features under a commercial license; notifkit has no feature held back from the self-hosted build.
- **MCP as a first-class interface.** Agents operate the same infrastructure your app uses, including triage and delivery-log inspection.

What notifkit does not have: an in-app notification center or inbox component, a web dashboard for non-engineers, digest aggregation, or Novu's provider catalog. If you need those, Novu is the better fit.

## Agent-operable

https://github.com/user-attachments/assets/4dff98bb-37d3-44b4-bf46-9607c1cd89b5

An AI agent can operate notifkit directly. Connect the notifkit MCP server ([`@notifkit/mcp`](./packages/mcp)) to Claude Code, Cursor, Claude Desktop, Gemini, or any MCP-compatible agent:

```bash
npx -y @notifkit/mcp
```

### Ask your agent

```text
You: Why didn't usr_9182 receive their password reset?

Agent: The notification was suppressed because usr_9182's email
       address has a hard-bounce suppression from yesterday.
```

Your application and your AI agents use the same notification infrastructure. Through MCP an agent can:

- Send one-off notifications or campaigns to users, lists, and segments (`send_notification`, `send_campaign`)
- Diagnose delivery issues by inspecting message histories, provider responses, and quiet hours (`get_delivery_logs`, `get_notification`)
- Schedule future sends and cancel pending notifications (`list_scheduled`, `cancel_notification`)
- Check delivery, open, click, bounce, and complaint metrics (`list_campaigns`, `get_campaign_stats`)
- List, preview, and update templates with sample data (`list_templates`, `preview_template`, `upsert_template`)
- Look up users, contacts, preferences, and segment membership (`list_users`, `get_user_preferences`, `update_user_preferences`)
- Trigger workflows and inspect workflow runs (`create_workflow`, `trigger_workflow`, `get_workflow_run`)
- Manage bounce suppressions, check system queues, and replay dead-letter messages (`list_suppressions`, `get_dead_letters`, `replay_dead_letter`)

### The same task, with and without an agent

| Without an agent                                                                                                                                                               | With the notifkit MCP server                                                                                                                                                                                                                                                                                                                                                      |
| :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Query the database for contact info, open Twilio or Resend or write a throwaway script, format the payload, check the user's timezone by hand, send it, and hope it delivered. | **You:** _"Send an urgent update to alex@acme.com that his package was lost in transit and support is rushing a replacement. Text him if push doesn't deliver."_<br><br>**Agent:** Looks up `alex@acme.com`, renders the template, dispatches push with SMS fallback, bypasses quiet hours because the send is urgent, tracks delivery status, and confirms it reached his phone. |

[MCP documentation](https://notifkit.dev/docs/mcp.html)

## AI-assisted migration

Already have notification code scattered across your application? Point your coding agent at:

```text
https://notifkit.dev/llms-full.txt
```

It can read notifkit's API from there, find ad-hoc notification code in your repository, and refactor it into notifkit calls.

## Feature matrix

|                     |                                                                                        |
| :------------------ | :------------------------------------------------------------------------------------- |
| **Channels**        | `email`, `sms`, `push`, `webhook`, `telegram`, `discord`, `whatsapp`, `slack`          |
| **Targeting**       | A user, a list of users, a segment, or a topic                                         |
| **Priorities**      | `low`, `normal`, `high`, `critical`, on separate stream lanes                          |
| **Scheduling**      | Future sends with `sendAt`, quiet-hours deferral, cancellation                         |
| **Preferences**     | Per-user channel and topic opt-outs, quiet hours, contact-level overrides              |
| **Workflows**       | Multi-step sequences with `wait`, `waitForEvent`, and `notify` steps                   |
| **Reliability**     | Redis Streams, 24h idempotency, retries, DLQ, provider circuit breakers                |
| **Templates**       | `{{var}}` interpolation with destination-aware escaping                                |
| **AI**              | Optional LLM augmentation before render via the Vercel AI SDK                          |
| **Multi-tenancy**   | Projects with isolated keys, data, and rate limits                                     |
| **Consent**         | RFC 8058 one-click unsubscribe; complaints and hard bounces suppress automatically     |
| **Reporting**       | Campaign labels with delivery and engagement totals                                    |
| **Agent operation** | MCP server for sending, triage, campaigns, templates, workflows, and system operations |
| **Observability**   | Prometheus `/metrics`, `/health`, `/live`, `/ready`, and queryable delivery logs       |

## Providers

Bring your own provider accounts. First-party packages:

- [`@notifkit/provider-resend`](./packages/provider-resend): transactional email via Resend
- [`@notifkit/provider-fcm`](./packages/provider-fcm): push notifications via Firebase Cloud Messaging
- [`@notifkit/provider-slack`](./packages/provider-slack): Slack messages via Incoming Webhooks or the Web API
- [`@notifkit/provider-twilio`](./packages/provider-twilio): SMS via Twilio, with signature-verified delivery status callbacks
- [`@notifkit/provider-telegram`](./packages/provider-telegram): messages via a Telegram bot
- [`@notifkit/provider-discord`](./packages/provider-discord): messages via a Discord webhook
- [`@notifkit/provider-whatsapp`](./packages/provider-whatsapp): messages via Meta's WhatsApp Cloud API

For anything else, implement a `Transport`:

```ts
class MyTransport implements Transport {
  async send(message) {
    // Send through SES, Postmark, APNs,
    // SendGrid, a custom webhook, or anything else.
  }
}
```

The keys, the billing, and the deliverability stay yours.

## Documentation

Everything lives at [**notifkit.dev/docs**](https://notifkit.dev/docs/).

|                                                                                |                                                          |
| :----------------------------------------------------------------------------- | :------------------------------------------------------- |
| [Quickstart](https://notifkit.dev/docs/quickstart.html)                        | Install to first delivered notification                  |
| [How it works](https://notifkit.dev/docs/concepts.html)                        | Core concepts and the notification pipeline              |
| [Channels & fallback](https://notifkit.dev/docs/guides/routing.html)           | Multicast, ordered fallback, and custom transports       |
| [Preferences & quiet hours](https://notifkit.dev/docs/guides/preferences.html) | Preference, consent, and timing rules                    |
| [Templates & AI](https://notifkit.dev/docs/guides/templates.html)              | Interpolation, escaping, and per-channel content         |
| [Segments & scheduling](https://notifkit.dev/docs/guides/segments.html)        | Fan-out, priority lanes, `sendAt`, and idempotency       |
| [Workflows](https://notifkit.dev/docs/guides/workflows.html)                   | Multi-step sequences, recurring sends, and digests       |
| [Examples](https://notifkit.dev/docs/examples.html)                            | Runnable projects                                        |
| [Architecture](https://notifkit.dev/docs/architecture.html)                    | Streams, delivery guarantees, topologies, and data model |
| [Deployment](https://notifkit.dev/docs/deployment.html)                        | Docker, Compose, and production topologies               |
| [Operations](https://notifkit.dev/docs/operations.html)                        | Health, metrics, DLQ, key rotation, and shutdown         |
| [Reference](https://notifkit.dev/docs/reference.html)                          | API, payloads, and SDK methods                           |
| [MCP server](https://notifkit.dev/docs/mcp.html)                               | Operate notifkit from an AI agent                        |

## Why build this?

Notification infrastructure looks simple until you're responsible for it. Queues, retries, provider adapters, preference systems, quiet-hour logic, workflows, suppression handling, and operational tooling take months to build well. notifkit is what I built instead, and it's what I run.

## Contributing

Issues and pull requests are welcome. Stars help other people find the project.

```bash
npm install
npm run build
npm test
```

The test suite starts its own PostgreSQL and Redis containers, so Docker is the only thing you need running.

## Contact

Questions, bugs, or ideas: [contact.devkitshq@gmail.com](mailto:contact.devkitshq@gmail.com), or open an issue.

## License

MIT. Do what you like with it, including commercially. See [LICENSE](./LICENSE).
