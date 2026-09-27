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

## Design

No schema change. Everything needed already exists: `agent_runs` (one active row per agent, per the
one-run-at-a-time rule enforced elsewhere), `notifications` (`delivery_status`), and `item_view`.

### Backend: `GET /api/orgs/:org`

Extend the `members` query in `orgDetail` (`server/src/domain.ts`) with two `left join lateral`
subqueries, so the whole thing stays the one query the endpoint already runs — no N+1, no second
round trip:

```sql
select a.id, a.kind, a.name, a.email, a.avatar_url, m.role, m.skills,
       ... existing columns unchanged ...,
       run.id as active_run_id, run.created_at as active_run_started_at,
       run.item_ref, run.item_title, run.item_type, run.project_key,
       run.parent_ref, run.parent_title,
       coalesce(q.updates, 0) as queued_updates
from memberships m join accounts a on a.id = m.account_id
left join lateral (
  select r.id, r.created_at, v.ref as item_ref, v.title as item_title, v.type as item_type,
         v.project_key, par.ref as parent_ref, par.title as parent_title
  from agent_runs r
  join item_view v on v.id = r.item_id
  left join item_view par on par.id = v.parent_id
  where r.agent_id = a.id and r.status = 'fired' and r.finished_at is null
  order by r.created_at desc limit 1
) run on true
left join lateral (
  select count(*)::int as updates
  from notifications n left join item_view iv on iv.id = n.item_id
  where n.account_id = a.id and n.delivery_status = 'pending' and coalesce(lower(iv.status), '') <> 'backlog'
) q on true
where m.org_id = ${org.id} order by a.kind desc, a.name
```

The queued-updates subquery is exactly the agent detail page's existing `queue.updates` filter
(`routes.ts`, the `GET /api/agents/:id` query): `delivery_status = 'pending'` and the item not in
Backlog. It doesn't also test "not blocked" — it doesn't need to, because a blocked notification
never sits in `pending`: the delivery worker (`delivery.ts`) and the routine queue (`routine.ts`)
both flip a blocked notification's `delivery_status` to `'skipped'` as soon as they see it, before
it would ever count here. Reuse the identical query shape rather than re-deriving "not blocked" by
hand, so the two counts (agent page vs. org page) can never drift apart.

`workingSql`/`workingRunSql` (used by `listItems`, item detail, etc.) already express "the one
active run for X" as `status = 'fired' and finished_at is null`; the lateral subquery above is that
same predicate keyed on `agent_id` instead of `item_id`, `order by created_at desc limit 1` for
belt-and-suspenders even though the one-run-at-a-time rule means there's normally at most one row.

Runs this only matters for agents, but running it unconditionally for every member is harmless —
a human account has no `agent_runs`/relevant `notifications` rows, so both subqueries return null/0
for them and the frontend simply never reads `activeRun`/`queuedUpdates` off a human row.

Response shape, added per member (`members[]`) alongside the existing fields:

```ts
activeRun: null | {
  id: string;            // -> /runs/<id>, the live transcript
  itemRef: string;       // -> RefLink
  itemTitle: string;
  itemType: 'issue' | 'task';
  projectKey: string;    // look up the name in the `projects` array already in this same response
  startedAt: string;     // -> Time/timeAgo
  parent: null | { ref: string; title: string };  // set only when itemType === 'task'
}
queuedUpdates: number;   // 0 when nothing's queued
```

No new endpoint, no breaking change — both fields are additive on the existing response. Project
*name* is deliberately left out of the new SQL: the endpoint's own `projects` array already carries
`key -> name`, so the frontend maps `projectKey` to a name from data it already fetched instead of
another join.

### Frontend: `web/src/pages/Org.tsx`

Per agent `<li>` in the Agents list, when `m.activeRun` is set, add one wrapping line below the
existing name/badges row (`.people li` already sets `flex-wrap: wrap`, so a full-width child simply
drops to its own line — no new CSS mechanism needed):

- `<Working run={m.activeRun.id} />` from `ui.tsx` — the same component Board.tsx and ItemTable.tsx
  use, so the live-transcript link and the pulsing-dot treatment stay visually identical everywhere
  it appears.
- `<RefLink refStr={m.activeRun.itemRef} />` + `m.activeRun.itemTitle`.
- When `m.activeRun.parent` is set (task case): also `<RefLink refStr={m.activeRun.parent.ref} />` +
  its title, e.g. "on TAS-5 · for issue TAS-3 …".
- The project name, looked up from `data.projects` by `m.activeRun.projectKey`.
- `<Time iso={m.activeRun.startedAt} />` — reuses `timeAgo` verbatim, no new formatting.

When `m.queuedUpdates > 0`, render a `<span className="pill">N queued</span>` (the same `.pill`
class already used for counts elsewhere) next to the agent, independent of `activeRun` — so it shows
whether or not the agent currently has a run.

When neither is present, render nothing extra: the `<li>` is byte-for-byte what it renders today,
satisfying acceptance criterion 6.

Poll: copy `Agent.tsx`'s existing pattern verbatim —
`useEffect(() => { const t = setInterval(() => document.visibilityState === 'visible' && reload(), 10_000); return () => clearInterval(t); }, [reload])`
— calling the `reload()` already returned by this page's `useFetch`.

### Environments

`staging_url`/`production_url`/app ids were missing when this issue's spec was written; they're now
set as project values and confirmed against the platform: `tasks` (production, `main`, running,
always-on) at `https://tasks-coolify.bogdanripa.com`, and `tasks-dev` (staging, `dev`, running,
sleeps when idle) at `https://tasks-dev-coolify.bogdanripa.com` — matching what README.md already
documented. No further environment setup needed for this issue.
