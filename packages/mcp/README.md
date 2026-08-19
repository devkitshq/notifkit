# @notifkit/mcp

An [MCP](https://modelcontextprotocol.io) server for notifkit. Point a terminal agent at your notifkit deployment and it can send notifications, manage templates and users, build workflows, and read the delivery log — without you writing a script for each one.

Speaks stdio, so it works with Claude Code, Claude Desktop, and any other MCP client.

## Install

```sh
npm install -g @notifkit/mcp
```

Or skip the install and let your client run it with `npx -y @notifkit/mcp`.

## Configure

Three environment variables:

| Variable              | Required               | Notes                                      |
| --------------------- | ---------------------- | ------------------------------------------ |
| `NOTIFKIT_API_KEY`    | yes                    | A project API key, or your `ADMIN_API_KEY` |
| `NOTIFKIT_URL`        | no                     | Defaults to `http://localhost:3000`        |
| `NOTIFKIT_PROJECT_ID` | only with an admin key | Which project the admin key should act on  |

A project-scoped key already carries its project, so it needs no `NOTIFKIT_PROJECT_ID`. Mint one with `POST /v1/projects/:id/keys`. Prefer that over the admin key — it is scoped to a single project and can be revoked on its own.

### Claude Code

```sh
claude mcp add notifkit \
  --env NOTIFKIT_URL=http://localhost:3000 \
  --env NOTIFKIT_API_KEY=nk_your_project_key \
  -- npx -y @notifkit/mcp
```

### Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "notifkit": {
      "command": "npx",
      "args": ["-y", "@notifkit/mcp"],
      "env": {
        "NOTIFKIT_URL": "http://localhost:3000",
        "NOTIFKIT_API_KEY": "nk_your_project_key"
      }
    }
  }
}
```

## The two-sentence workflow

The thing this exists for:

> **You:** "Send the spring-sale template to these 200 addresses." _(paste)_
> **Agent:** → `send_campaign` → "Queued 200 as `spring-sale-aug-13`."
>
> _(next day)_ **You:** "How did the spring sale do?"
> **Agent:** → `list_campaigns` → `get_campaign_stats` → "194 delivered, 4 bounced, 2 suppressed. 71 opened (37%), 12 clicked (6%)."

`send_campaign` takes raw email addresses — no user records needed up front. It creates one per address, keyed off the address itself, so re-sending to the same list updates those people rather than duplicating them. Duplicates and case differences within a list are collapsed before sending.

## Tools

**Campaigns**

| Tool                 | What it does                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `send_campaign`      | Send a template to a list of email addresses, tagged with a label you can report on later    |
| `list_campaigns`     | Recent campaign labels with size and last activity — how "the one from yesterday" gets found |
| `get_campaign_stats` | Sent, delivered, failed, opened, clicked, bounced, complained, unsubscribed, with rates      |

**Sending**

| Tool                | What it does                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `send_notification` | Send to existing users, a segment, or a topic. Takes `sendAt` to schedule and `campaign` to make it reportable. |
| `list_segments`     | Every segment tag in use — the valid audiences to broadcast to                                                  |
| `list_scheduled`    | Sends queued for the future, including quiet-hours deferrals                                                    |
| `get_delivery_logs` | Per-message detail, when the campaign totals are not enough                                                     |

**Suppressions** — `list_suppressions`, `suppress_address`, `unsuppress_address`

**Templates** — `list_templates`, `get_template`, `upsert_template`

**Users** — `list_users`, `get_user`, `upsert_user`, `add_user_contact`

**Workflows** — `create_workflow`, `list_workflows`, `trigger_workflow`, `get_workflow_run`, `cancel_workflow_run`, `ingest_event`

**Operations** — `get_system_health`, `get_dead_letters`, `replay_dead_letter`

Project and API-key management is deliberately not exposed: minting and revoking credentials is not something an agent should do on your behalf. Use the HTTP API for that.

## Reading the numbers

**Audience size is not delivery count.** Every send passes the same gates as any other notification — suppressions, opt-outs, quiet hours, throttling — so a list of 200 delivers to fewer than 200, by design. `send_campaign` reports what was _queued_; `get_campaign_stats` reports what actually happened.

**An untracked open rate is not a zero open rate.** Opens and clicks arrive from provider webhooks. On SMS and push there is nothing to report; on email, nothing arrives unless the webhook is configured. `get_campaign_stats` returns a `warnings` array saying which of those applies, and the tool description tells the agent to pass it on rather than reporting a flat 0%.

**Watch the complaint rate.** Above roughly 0.3%, mailbox providers start throttling or junking your mail — and that hits your transactional email too, since it is the same sending domain.

## Sequences

Multi-step sends — onboarding, drips, reminders — are workflows rather than campaigns: `create_workflow` defines the steps, `trigger_workflow` enrols each user.

> _"Make an onboarding drip: welcome email, wait 3 days, then the tips email unless they've already sent an `activated` event."_

## Safety

`send_campaign`, `send_notification`, `trigger_workflow`, and `replay_dead_letter` reach real people and cannot be recalled. Read-only tools are annotated as such so clients can auto-approve them and prompt on the rest; `cancel_workflow_run` and `unsuppress_address` are marked destructive.

Suppressions deserve particular care. A suppressed address is usually someone who asked not to be contacted, or an address that no longer exists. Removing a suppression to improve a delivery figure is how a sending domain gets blocked — the tool description tells the agent to confirm first, and you should treat an unprompted suggestion to do it as a red flag.

Point the server at a staging deployment while you get a feel for it.

## Development

```sh
npm run build      # tsc
npm run typecheck
```

The server holds no state and imports nothing from the notifkit core package — it is a thin, self-contained HTTP client, so running it costs you a Node process and nothing else.
