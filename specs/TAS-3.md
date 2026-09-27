# TAS-3: Show what agents are doing on the org page

## Goal

On an organization's page (`/<org>`, e.g. `https://tasks-coolify.bogdanripa.com/app/home`), show
next to each agent what it's currently doing, so a human can see agent activity across the org at a
glance without opening every agent's page.

## User-facing behaviour

In the "Agents" list on the org page, for each agent:

- **If the agent has an active run** (it's currently working on an item):
  - The item it's working on: ref + title, linking to the item's page.
  - If that item is a **task**, also show the **issue it belongs to** (the parent issue's ref +
    title) — a task is worked in service of its issue, and "which issue" is what a human scanning
    the page wants to know first.
  - **Which project** the item is in (project name).
  - **How long since the run started** (e.g. "started 12m ago"), using the same relative-time
    formatting already used elsewhere in the app (`Time`/`timeAgo`).
  - A link to the live run transcript where one exists, consistent with the "working" pill already
    used on the Board and item table (`Working` component → `/runs/<id>`).
- **If the agent has updates queued** (pending notifications waiting for its next run — same thing
  the agent's own Activity tab calls "Queued: N updates"): show that count, whether or not it
  currently has an active run.
- **If the agent is idle** (no active run, nothing queued): show the page as it looks today — no
  extra block, no regression to name/kind badge/skills/connected-state display.
- The page should refresh this periodically while open, matching the existing poll-while-visible
  pattern already used on the Agent detail page (every 10s, only while the tab is visible), so this
  is "reasonably live" without a manual reload.

## Acceptance criteria

1. Visiting an org page (`/<org>`) shows, for every agent member with an active run, the ref + title
   of the item it's working on and the project it's in.
2. When the active item is a task, the parent issue's ref + title is also shown.
3. Elapsed time since the run started is shown for an active run, using the app's existing relative
   time formatting.
4. Clicking the shown item navigates to that item's page; where a run id is known, the "working"
   indicator links to `/runs/<id>`, exactly like it does on the Board and item tables.
5. If the agent has one or more updates queued, that count is visible next to the agent (e.g. "2
   queued"), independent of whether it currently has an active run.
6. Agents with no active run and no queued updates render exactly as they do today: no added UI,
   no layout regression.
7. The information updates while the org page is left open, without requiring a manual reload
   (polling while the tab is visible, matching the Agent page's existing 10s interval).
8. Nothing shown here exposes information that isn't already visible to anyone who can see the org
   page today (no webhook URLs, API keys, or other admin-only agent settings leak into this view).
9. No N+1 query blow-up: the org page's one request stays one request (or a small constant number)
   regardless of how many agents/items are involved.

## Out of scope

- Changing the Agent detail page (`/agents/:id`) itself — it already shows this agent's own queue
  and runs in full; this issue is only about surfacing a summary on the org page.
- Showing a full run history or transcript inline — link out to `/runs/<id>` as already exists.
- Any change to how runs are queued, throttled, or fired — this is a read-only display feature over
  existing `agent_runs` / `notifications` data.
- Showing activity for humans (this issue is specifically about agents, per the request).
