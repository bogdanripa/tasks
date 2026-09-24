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

## Web layout

- `/` and `/docs/` are the public site: static HTML in `web/site`.
- `/app/` is the app: React, built with Vite under `base: '/app/'`.
- `npm run build -w web` puts both in `web/dist`.
- **In production:** CI uploads `web/dist` to pironman's static host behind the CDN. Requests for files not in the bundle (`/api`, `/auth`, `/mcp`, `/app/*` deep links) go to the container, which serves the same `web/dist` as a fallback.
- **Old links:** app paths from before `/app` existed redirect there.

## API reference

`GET /api/help` is generated at runtime from the routes the server registers. Each route is declared with `route()` in `server/src/routes.ts` with a summary and Zod schemas. The same schemas validate requests and document them, so the reference can't drift from the code. Routes marked `agent: true` also go into the compact reference in routine payloads. The smoke test fails if any `/api` route is undocumented.

## Local development

```bash
docker compose up -d        # Postgres on :5434
cp .env.example .env        # DEV_LOGIN=1 lets you sign in with just an email
npm install
npm run dev                 # API on :3000, app on http://localhost:5180/app/
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

### Starter setup

- **New organization:** it comes with three agents (opt out with the checkbox, or `starterAgents: false`):
  - **PM** (`product`)
  - **Lead** (`architecture`, `review`)
  - **Dev** (`db`, `backend`, `frontend`)
  - **QA** (`qa`)

  Each has a role description that fills its routine Instructions. The org page lists agents that aren't connected yet.
- **New project:** in an org with members covering `product`, a build skill and `qa`, it's set up for them (the checkbox is on by default; `setup: "blank"` opts out):
  - Todo routes to `product`
  - Review hands tasks to `review`
  - guidelines start from the agent pipeline template (`server/templates/agent-pipeline.md`, also at `/api/templates/agent-pipeline`)

### Skills and routing

Members (people and agents) have **skills** per organization (e.g. `product`, `architecture`, `db`, `backend`, `frontend`, `qa`). An item can **need** a skill, and a board column can have a **default skill** (e.g. Todo → `product`).

- **Routing rule:** an open item with no assignee goes to the least busy member with the item's skill, or failing that, the column's default skill. This happens when the item is created, when it changes column or skill, when a member gains a skill, and when an assignee leaves.
- **What routing never does:** override an assignee someone chose, or re-route an explicit unassign.
- **When nobody has the skill:** the item waits and the board shows "needs `db`".
- **What agents see:** every run gets the team roster by skill. Agents hand work over by creating tasks with a skill and no assignee, and express order with `blocks` links.
- **Pipeline template:** the project Guidelines tab has an *agent pipeline* template (product → architecture → parallel builders → QA → product check → PR or merge) as a starting point.
- **Visibility:** the issue page shows each task's state (ready, working, waiting on …, done), and the board shows *working* while an agent run is active.
- **Done notification:** the person who created an item is notified when it's done.
- **Code review:** a column can **hand off** tasks to a skill (e.g. Review → `review`). A task moved there goes to the least busy member with the skill who isn't its author. The reviewer approves by moving it to Done, or moves it back and it returns to the author. Issues aren't handed off.
- **Definition of done:** agents can't close an issue with open tasks. When the last task closes, the issue's owner gets a run whose payload asks for the definition-of-done check before delivering.
- **Ending a run:** a run can end without changing status with `POST /api/runs/end` (e.g. an issue left waiting on its tasks).

### Recurring tasks

In a project's settings, a schedule adds an item on a timer: "every weekday at 9:00, add *Pi health check {date}* to Todo, assigned to Pironman".

- **Timing:** daily, weekdays, weekly or monthly at a time in a chosen timezone, or any 5-field cron. Timezones are handled across daylight saving.
- **Placeholders:** `{date}` and `{weekday}` in the title and description are filled in.
- **What it creates:** an issue, or a task under a chosen issue, in any column, assigned to anyone. Assigned agents are pinged as usual, unless the item lands in Backlog.
- **Options:** skip a run while the previous item is still open; pause or resume; Run now.
- **Ownership:** items are created as whoever last saved the schedule.
- **Scheduler:** runs in the server. After downtime, a schedule runs once to catch up, not once per missed slot.
- **Columns:** renaming a column updates schedules that use it; removing it sends them to the first column.

### Where the rules live

| Rules | Where |
| --- | --- |
| How to work with Tasks (move to In progress, comment, set status, the API) | Generated by Tasks into every run's payload, so it's always current |
| How to work in a project / organization | **Guidelines** on the project and organization settings pages (Markdown), sent with every run and returned by `get_item` |
| Who an agent is: role and hard limits | The routine's Instructions on claude.ai |
| How to work in the code | `CLAUDE.md` in the repo |

When they conflict: the agent's hard limits win, then project guidelines, then organization guidelines.

### Agents Tasks runs itself

An organization adds API keys for **OpenAI, Anthropic, Google Gemini, xAI Grok** or any **OpenAI-compatible** endpoint (Settings → AI providers). Keys are tested against the provider, stored encrypted, and never returned.

An agent set to **Run in Tasks** (Connection tab) picks a provider, a model and a step limit. Tasks then runs it itself:

- **Same flow as a routine:** the same queue, quiet period, Backlog and blocked rules, review hand-off and definition-of-done check.
- **Tools instead of curl:** the model gets the same assignment, but with Tasks' actions as tools (`get_item`, `update_item`, `comment`, `create_issue`, `create_task`, `link_items`, `list_items`, `search`, `list_members`, `end_run`), acting as the agent.
- **Transcript:** each run is recorded step by step, with tokens, at `/app/runs/<id>`.
- **Limits:** up to 3 runs at a time per server, a step limit per agent, and 30 minutes per run.
- **Failures:** transient provider errors are retried with backoff (3 attempts); a rejected key fails the run with the provider's message.
- **Restarts:** runs cut short by a restart are queued again at startup.

Code: `server/src/llm.ts` (providers, models) and `server/src/runtime.ts` (the loop and tools).

### GitHub

An admin installs the **Tasks GitHub App** for the organization (Settings → GitHub → Connect GitHub) and chooses the repositories on GitHub. The installation is only linked after checking, through the admin's own GitHub sign-in, that their account can access it. Each project then picks a repository, a base branch and a delivery mode (Project settings → Repository):

- **Per-run token:** every run gets an installation token limited to the project's repository (contents, pull requests, Pages), valid for an hour.
- **In-house agents** get repository tools: `repo_list_files`, `repo_read_file`, `repo_write_files` (commits to a branch), `repo_open_pull_request`, `repo_merge_pull_request`, `repo_publish_pages`.
- **Routine agents** get a clone URL with the token, and a `curl` for opening a pull request.
- **Delivery:** `pr` means agents open a pull request for a human to merge. `merge` means agents merge into the base branch themselves.
- **Webhooks:** pull requests and commits that mention `KEY-N` show up in that item's history.

Server env: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_PRIVATE_KEY_B64`. The app's callback URL is `/api/github/callback` and its webhook URL is `/api/github/webhook`. Code: `server/src/github.ts`.

### Routine agents (Claude Code cloud routines)

Each agent can have its own routine at claude.ai/code/routines with a **Call via API** trigger. The agent page walks through the setup: the Instructions to paste, the domain the routine's cloud environment must allow (**Network access → Custom**), and where to paste the routine's URL and token. The token is stored encrypted with `SECRETS_KEY`.

- **What fires a run:** any change someone else makes to a task assigned to the agent. That covers assignment, comments, status/title/description edits, links, new tasks under an issue, and blockers or triggered items finishing. The agent's own changes never wake itself. Items in a **Backlog** column never start runs or webhook pings (the inbox still records them); moving an item out of Backlog starts one. Likewise, items with an unfinished **blocker** (a `blocks` link from an open item) don't start runs; the last blocker finishing sends "unblocked", which does. Agents can use this to wait on humans: create a task for the human that blocks their own.
- **Payload:** each run's `text` payload carries the full current task (title, status, columns, description), what changed since the last run with before/after (status, title, assignee, a diff of the description, full comment text), and a **run token**. The run token is a fresh API key acting as the agent, which expires after 4 hours, or 10 minutes after the run ends. The run talks to Tasks with `curl`. The payload ends with a compact API reference (one line per endpoint).
- **Queue:**
  - One run at a time per agent, taking the oldest pending update first. Updates that arrive meanwhile wait in the queue; none are dropped.
  - Quiet period: an agent is pinged only once nobody has touched the item for `AGENT_QUIET_SECONDS` (default 120). Every change restarts the timer, so a human can finish editing and the agent gets all of it in one run. This applies to webhooks too.
  - The agent's first step is moving the task to the board's in-progress column ("In progress", "Doing", "WIP" or "Working"); the payload names the column. That move doesn't end the run.
  - A run ends when it sets its task to any other status, or calls `POST /api/runs/end`. An agent is busy while it has an unfinished run.
  - A run that never calls Tasks within 10 minutes (usually a missing network allowlist) is released, with a hint in the task's history. So is a run idle for 2 hours. Admins can end a run by hand on the agent's Activity tab.
  - An agent is woken by work it gives itself (a task it creates for itself, a blocker it finishes, the last task under its issue), but not by its own edits or comments.
  - Payloads stay under the routine API's limit: long comments are shortened first, then the oldest comments are dropped; assignments, status changes and blocker news are always kept.
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
