# TAS-25: List human work on the org page

## Goal

The org page's "Agents" list (see TAS-3) shows what each agent is working on. Humans should get the
same treatment: for each human member, show the open work assigned to them, so a person scanning
the org page sees who is holding what. The list must stay short for people with a lot of work
("… and 134 more").

## User-facing behaviour

For each **human** member on the org page (`/<org>`):

- Show the **open items assigned to them** (any project in the org the viewer can see; open = not in
  the project's last/Done column). Each entry: ref + title linking to the item page, project name,
  and for a task the parent issue's ref + title (same presentation as the agent activity block).
- Show at most **5** items, ordered most recently updated first.
- If there are more, show a trailing line "and N more" (N = total open minus shown) that links to
  the existing assignee-filtered work view for that person (`GET /api/work?assignee=<id>` is the API
  behind it; use whichever UI route already lists a member's work, else the member's page).
- A human with no open work renders exactly as today (no added UI).
- Agents keep their current block (active run, queued count) unchanged; they may also gain the same
  "assigned work" list only if it falls out of the shared component for free — not required.
- Refreshes with the page's existing 10s visible-tab poll.

## Acceptance criteria

1. Every human member with open assigned items shows up to 5 of them (ref, title, project; parent
   issue for tasks), newest-updated first, each linking to the item.
2. With more than 5 open items, an "and N more" line shows the exact remainder and links to that
   person's full work list.
3. Exactly 5 items shows no "more" line; 0 items shows nothing.
4. Done items are never listed or counted.
5. Only items in projects the viewer can access are listed/counted.
6. The org page stays one request (no per-member requests); the response size is bounded (max 5
   items per human regardless of total).
7. Nothing new is exposed beyond what the viewer can already see on the board.
8. Agent display from TAS-3 is unchanged.

## Out of scope

- Editing/reassigning from the org page.
- Showing human "activity" or run state (humans have no runs).
- Changing pagination size configuration (fixed at 5).

## Design (proposed; Architecture may refine)

Extend `GET /api/orgs/:org` (`orgDetail` in `server/src/domain.ts`) members with, for humans:
`assigned: { total: number, items: [{ref,title,type,projectKey,projectName,parentRef,parentTitle,updatedAt}] }`
using a lateral subquery over `item_view` (open items, assignee = member, limited to 5, ordered by
`updated_at desc`) plus a `count(*)` for `total`, keeping it one query. Frontend renders
`items` with the shared item-link component from the agent block and "and {total - items.length}
more" when `total > items.length`.
