# @notifkit/mcp

An [MCP](https://modelcontextprotocol.io) server for notifkit. Point a terminal agent at your notifkit deployment and it can send notifications, manage templates and users, build workflows, and read the delivery log — without you writing a script for each one.

Speaks stdio, so it works with Claude Code, Claude Desktop, and any other MCP client.

## Install

```sh
npm install -g @notifkit/mcp
```

Or skip the install and let your client run it with `npx -y @notifkit/mcp`.

## Configure

Three environment variables, all of them required:

| Variable              | Required | Notes                                                                                                                               |
| --------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `NOTIFKIT_API_KEY`    | yes      | Your `ADMIN_API_KEY`, or a project API key. The server exits without it                                                             |
| `NOTIFKIT_URL`        | yes      | Base URL of your notifkit API. Falls back to `http://localhost:3000`, so set it unless the API is there                             |
| `NOTIFKIT_PROJECT_ID` | yes      | Which project the admin key acts on, sent as `x-project-id`. Without it an admin key gets `400` on everything except `/v1/projects` |

The examples below use your `ADMIN_API_KEY`, which carries no project of its own — it needs `NOTIFKIT_PROJECT_ID` to know which project to act on. A project-scoped key already carries its project, so if you swap one in, drop the `NOTIFKIT_PROJECT_ID` line. Prefer that where you can: it is scoped to a single project and can be revoked without rotating the admin key. Mint one with `create_project_key` or `POST /v1/projects/:id/keys`.

### Claude Code

```sh
claude mcp add notifkit \
  --env NOTIFKIT_URL=http://localhost:3000 \
  --env NOTIFKIT_API_KEY=your_admin_api_key \
  --env NOTIFKIT_PROJECT_ID=6f1c9c1e-3b7a-4d2e-9f04-2c8a5b1d7e33 \
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
        "NOTIFKIT_API_KEY": "your_admin_api_key",
        "NOTIFKIT_PROJECT_ID": "6f1c9c1e-3b7a-4d2e-9f04-2c8a5b1d7e33"
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

`send_campaign` takes raw email addresses, phone numbers, or push tokens — no user records needed up front. It creates one per recipient, keyed off the address itself, so re-sending to the same list updates those people rather than duplicating them. Duplicates and case differences within a list are collapsed before sending.

## The `raw_email` Pattern (One-off Sends from Terminal)

Instead of hardcoding a new template in backend code for every custom message, register a single generic pass-through template once:

```json
{
  "id": "raw_email",
  "channel": "email",
  "content": {
    "subject": "{{subject}}",
    "html": "{{{body}}}"
  }
}
```

Because triple braces `{{{body}}}` preserve unescaped HTML, your agent in Claude Code or Cursor can dispatch arbitrary one-off formatted emails directly from terminal prompts:

> **You:** "Send an email to alex@acme.corp saying their invoice is ready at https://app.acme.corp/inv/9481"
> **Agent:** → `send_campaign({ template: "raw_email", emails: ["alex@acme.corp"], data: { subject: "Invoice #9481 Ready", body: "<p>Download: <a href='...'>Invoice #9481</a></p>" } })`

## Tools

**Campaigns & Sending**

| Tool                  | What it does                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `send_campaign`       | Send a template to a list of recipients across `email`, `sms`, `push`, `webhook`, or `whatsapp` with campaign tagging |
| `send_notification`   | Send to existing users, a segment, or a topic with `sendAt` scheduling and priority lanes                             |
| `list_campaigns`      | Recent campaign labels with size and last activity (supports `search`, `channel`, date range)                         |
| `get_campaign_stats`  | Sent, delivered, failed, opened, clicked, bounced, complained, unsubscribed, with rates                               |
| `list_segments`       | Every segment tag in use — the valid audiences to broadcast to                                                        |
| `list_scheduled`      | Sends queued for the future, including quiet-hours deferrals                                                          |
| `get_delivery_logs`   | Per-message detail with filters for template, channel, status, campaign, or user search                               |
| `get_notification`    | Status and delivery attempts for a specific task                                                                      |
| `cancel_notification` | Cancel a pending scheduled or quiet-hours deferred notification                                                       |

**Templates** — `list_templates`, `get_template`, `upsert_template`, `delete_template`, `preview_template`, `render_template`

**Users** — `list_users` (with `search`, `segment`, `language`, `timezone`, `channel` filters), `get_user`, `upsert_user`, `update_user`, `delete_user`, `get_user_contacts`, `add_user_contact`, `delete_user_contact`, `get_user_preferences`, `update_user_preferences`

**Workflows** — `create_workflow`, `list_workflows` (with `search`), `trigger_workflow`, `get_workflow_run`, `cancel_workflow_run`, `ingest_event`

**Operations** — `get_system_health`, `get_system_metrics`, `get_dead_letters`, `replay_dead_letter`, `delete_dead_letter`, `list_projects`, `create_project`, `update_project`, `delete_project`, `list_project_keys`, `create_project_key`, `delete_project_key`

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
