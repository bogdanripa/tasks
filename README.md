# Tasks

A task tracker where humans and AI agents work together. It has Trello's simplicity and the parts of Jira that matter when agents hand work to each other.

- **Issues** describe a need. **Tasks** are the assignable pieces of work under an issue.
- **Humans** sign in with Google. **Agents** are accounts in an org that use API keys.
- **Assigning work to an agent pings it** in one of three ways: a **Claude Code routine** run, a signed webhook, or waking an MCP long-poll (`wait_for_work`).
- **An issue can be triggered by another issue**, in any project and even in another org you belong to. These `triggered` links are permanent. `blocks` and `relates` links can be removed.
- **Every change is an event** in one append-only log. That log powers each item's history, each project's timeline and every notification.
- **MCP server** at `/mcp` (Streamable HTTP, stateless, `Authorization: Bearer <api key>`).

## Layout

```
server/            Fastify + Postgres (postgres.js), TypeScript
  migrations/      plain SQL, applied at startup
  src/domain.ts    all business rules; REST and MCP both go through it
  src/routes.ts    REST API for the web UI
  src/mcp.ts       MCP tools for agents
  src/delivery.ts  delivery worker (webhooks, routine queue) + long-poll
  src/routine.ts   Claude Code routine runs: queue, payload, run tokens
  src/auth.ts      Google OAuth, sessions, API keys
  scripts/         seed.ts (demo data), smoke.ts (end-to-end checks)
web/               React + Vite single-page app, served by the server in production
```

## API reference

`GET /api/help` is generated at runtime from the routes the server registers. Each route is declared with `route()` in `server/src/routes.ts` with a summary and Zod schemas. The same schemas validate requests and document them, so the reference can't drift from the code. Routes marked `agent: true` also go into the compact reference in routine payloads. The smoke test fails if any `/api` route is undocumented.

## Local development

```bash
docker compose up -d        # Postgres on :5434
cp .env.example .env        # DEV_LOGIN=1 lets you sign in with just an email
npm install
npm run dev                 # API on :3000, UI on http://localhost:5180
npm run seed                # demo org; sign in as demo@example.com
npm run smoke               # end-to-end checks against the running API
```

## Agents

Create an agent on the organization page. You get an API key (shown once) and a ready-made command:

```bash
claude mcp add --transport http tasks https://<host>/mcp --header "Authorization: Bearer tsk_…"
```

Tools: `whoami`, `list_projects`, `list_members`, `get_inbox`, `mark_read`, `wait_for_work`, `my_work`, `list_items`, `get_item`, `create_issue`, `create_task`, `update_item`, `comment`, `link_items`, `project_timeline`, `search`.

**Webhooks.** An agent with a webhook URL gets a `POST` for every notification. Each request carries these headers:

- `X-Tasks-Event` (the reason)
- `X-Tasks-Delivery`
- `X-Tasks-Timestamp`
- `X-Tasks-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>`

A failed delivery is retried with exponential backoff, up to 8 attempts.

Notification reasons:

- `assigned`
- `commented`
- `status_changed`
- `task_added`
- `unblocked`: something that blocked your item is done.
- `triggered_item_done`: an issue your item triggered is done.
- `all_tasks_done`: every task under your issue is done.

### Routine agents (Claude Code cloud routines)

Each agent can have its own routine at claude.ai/code/routines with a **Call via API** trigger. The agent page walks through the setup: the Instructions to paste, the domain the routine's cloud environment must allow (**Network access → Custom**), and where to paste the routine's URL and token. The token is stored encrypted with `SECRETS_KEY`.

- **What fires a run:** any change someone else makes to a task assigned to the agent. That covers assignment, comments, status/title/description edits, links, new tasks under an issue, and blockers or triggered items finishing. The agent's own changes never wake itself.
- **Payload:** each run's `text` payload carries the task, what changed since the last run, and a **run token**. The run token is a fresh API key acting as the agent, which expires after 4 hours, or 10 minutes after the run ends. The run talks to Tasks with `curl`. The payload ends with a compact API reference (one line per endpoint).
- **Queue:**
  - One run at a time per agent, taking the oldest pending update first. Updates that arrive meanwhile wait in the queue; none are dropped.
  - Edits within 10 seconds of each other are batched into one run.
  - A run ends when it sets its task's status, or after 20 minutes without API activity.
- **Limits:**
  - A `429` from Anthropic pauses every routine in the org until `Retry-After`. Queued updates wait.
  - At most 10 runs per agent per task per hour, which guards against two agents pinging each other forever. Beyond that, updates wait for the window.
- **History:** each run shows up in the task's history with a link to its session, and on the agent page.

## Deploying (pironman)

The image is built for `linux/arm64`. It listens on `:80` on IPv4 and IPv6 and exposes `/healthz`. It needs:

| Env | |
| --- | --- |
| `DATABASE_URL` | injected by pironman when the app has a Postgres DB |
| `PUBLIC_URL` | e.g. `https://tasks-coolify.bogdanripa.com` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth web client; redirect URI `${PUBLIC_URL}/auth/google/callback` |
| `SECRETS_KEY` | long random string; encrypts routine tokens at rest (required) |

Keep the app always on (`sleep_when_idle: false`). Webhook retries and agent long-polls need a live process.
