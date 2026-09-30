# TAS-22: Daily email summary of changes to my projects

## Goal

Every day at 06:00 in the user's own time zone, email each human user a summary of what changed in
the projects they own since the last summary. Users can unsubscribe per project or from all of them.

## User-facing behaviour

- **Who:** human users (not agents) who own at least one project and have opted in.
- **Owner:** every **org owner and admin** of the org the project belongs to (decided by Bogdan Ripa in
  TAS-24). Agents and plain members are never recipients.
- **When:** once a day at 06:00 in the user's time zone (same per-user time zone setting as TAS-21).
- **What:** for each owned project with changes since the previous summary, grouped by project: the
  events from the project's event log (items created, status changes, assignments, comments, items
  done), each with actor, item ref + title, link. Newest last, capped per project with "and N more".
- **If nothing changed** in any owned project: no email. Projects with no changes are omitted.
- **Window:** from the last summary sent (or the previous 24h for a first email) to now. Nothing is
  lost if a day is skipped, and nothing is reported twice.
- **At most one email per user per day.**
- **Unsubscribe:** every email has a per-project "unsubscribe from this project" link for each project
  section, an "unsubscribe from all project summaries" link, and a `List-Unsubscribe` header
  (one-click = all). Links are signed tokens, need no login, and are not guessable. The app's settings
  page lists the user's owned projects with a toggle each, plus a master toggle, so they can
  re-subscribe.
- **Opt-in:** nobody receives the summary until they enable it (decided in TAS-24). Settings page has a master toggle plus a toggle per owned project; enabling the master toggle subscribes to all owned projects, and each project can then be switched off. Emails also carry the unsubscribe links above.

## Acceptance criteria

1. An org owner/admin who has opted in, and whose org has a project with changes since the last summary gets one email at ~06:00 local time listing them.
2. No changes in any owned project: no email.
3. Only projects the user owns appear; only events in those projects.
4. Users who have not opted in get nothing. Users in different time zones get theirs at their own 06:00.
5. No duplicate email for the same user and local date; no event appears in two summaries.
6. Per-project unsubscribe removes that project from later emails and leaves the others; unsubscribe-all
   stops all emails. Both work without signing in and can be reverted in settings.
7. A send failure never crashes the server; it is logged and retried within the day's window, and the
   window is not advanced until the email is sent.
8. Email content excludes agent-run/internal noise (e.g. run start/end events).

## Out of scope

Per-event notification emails, configurable time/frequency, projects the user only belongs to,
agent recipients, HTML theming beyond a simple readable layout.

## Dependencies

Shares email delivery, the per-user time zone setting and the daily scheduler with TAS-21. Build that
infrastructure once (under TAS-21) and reuse it here; this issue adds the change digest and the
per-project subscription.

## Decisions (from TAS-24)

1. Owners = all org owners/admins.
2. Opt-in (unlike TAS-21, which is subscribed by default).
3. Email provider and credentials: Bogdan will provide them later; tracked in a separate task (see the issue comments). Time zone: per-user, inferred from the browser at account creation (TAS-23).

## Design

TAS-22 is the **second consumer** of the email infrastructure designed in `specs/TAS-21.md` (mailer with `log`/`smtp` transports, `email_prefs`/`email_sends`, signed unsubscribe tokens and endpoints, `accounts.timezone`, `registerDailyJob` scheduler). None of that is rebuilt here; this issue adds one job, one cursor table, per-project preferences and their UI. All in the Fastify server (`server/src`) and the web Settings page.

### Verifying before credentials exist

`EMAIL_TRANSPORT=log` (the default) writes the full digest to the server log and succeeds, and the scheduler exposes `mailTick(now)` (TAS-38) so tests simulate 06:00 in several zones. Nothing in this design needs real SMTP; TAS-30 only switches the transport.

### Data model (migration `021_project_digest.sql`, after TAS-21's `020_email.sql`)

- `digest_cursors (account_id uuid primary key references accounts(id) on delete cascade, last_event_id bigint not null, sent_at timestamptz not null)`: the end of the window covered by the last digest *sent* to this person. One row per person, not per project.
- No other tables. Preferences reuse `email_prefs` with `topic = 'project_digest'`:
  - `scope = ''` is the **master** switch. Default **off** (opt-in, `defaultEnabled: false`).
  - `scope = <projectId>` with `enabled = false` is an explicit per-project opt-out. Absence means "on while the master is on".
  - Effective subscription to project P = master on **and** no `enabled = false` row for P.
  - Turning the master **on** deletes that person's per-project rows (subscribes to all owned projects, per the spec). Turning it off leaves them alone; it is the master that stops the mail.

### Who is a recipient, what is "owned"

Human accounts with `accounts.timezone` set, master on, and at least one project in an org where `memberships.role in ('owner','admin')`. Owned projects = all projects of those orgs, computed at send time (a person demoted or removed from an org stops receiving that org's events immediately; AC 3, and it keeps the email to what they can see). Agents and plain members never qualify.

### Job (`server/src/projectDigest.ts`)

Registers with the shared scheduler at startup, next to the assigned-summary job:

```ts
registerDailyJob({ topic: 'project_digest', hour: 6, defaultEnabled: false, build })
```

`build(account, { localDate })`:

1. Owned, subscribed project ids (rules above). None → `null` (scheduler records `empty`, no mail).
2. Window: `events.id > cursor.last_event_id` and `events.created_at > now() - interval '7 days'` (no cursor: `created_at > now() - interval '24 hours'`). Upper bound `hi = max(events.id)` read at the start of the build, so events arriving during the build fall into the next window and none appears twice. The 7-day floor stops someone who re-enables after a long pause from receiving stale history; within a normal skipped day nothing is lost (AC 5).
3. Events: `project_id = any(owned)`, `type` in the **allowlist** `item.created`, `item.updated`, `comment.created`, `item.deleted`. Everything else (all `agent.*`, `watchdog.*`, `item.no_reviewer`, `link.*`, `task.added` which duplicates the task's own `item.created`, org/member/project admin events) is excluded, which satisfies AC 8 and stays safe when new event types appear (allowlist, not blocklist). Ordered by `id` ascending (newest last).
4. No events → `null`.
5. Render per project (ordered by org name, project key), one line per event: actor name, verb, `REF title` linked to `${PUBLIC_URL}/app/i/<org>/<ref>`: created; `status A → B` (with "done" when `B` is the project's last column); assigned `X → Y`; other field changes named; commented; deleted. Title and ref come from the event's `data`, falling back to `item_view`. Cap **50 events per project** and 300 overall, then "and N more — see <project link>". Plain text plus simple HTML.
6. Subject: `Project changes: N updates in M projects`. Each project section carries its own "Unsubscribe from <project>" link (token topic `project_digest`, scope project id); the footer has "Unsubscribe from all project summaries" (scope `''`) and a Settings link. The `unsubscribe` token returned to the scheduler (for `List-Unsubscribe`, one-click) is the scope `''` one. Tokens come from TAS-37's `emailPrefs` (exported `unsubscribeToken(accountId, topic, scope)`).
7. `after`: upsert `digest_cursors` with `last_event_id = hi`, `sent_at = now()`. The scheduler calls it only after the send succeeded, so a failed send leaves the window where it was and the retry (every tick until the window ends) covers the same events (AC 7).

Once-a-day and no-duplicate guarantees come from `email_sends` (TAS-38), not from this module.

### Unsubscribe and preferences (extends TAS-37, no new endpoints there)

- The shared `GET/POST /api/email/unsubscribe` and `/resubscribe` handlers already apply "topic + scope off/on". TAS-22 adds the topic's scope semantics and the wording of the confirmation page: scope `''` → "You're unsubscribed from all project summaries", a project id → "You're unsubscribed from <project name>" (unknown/deleted project: generic text, still 200). Re-subscribe of a project while the master is off enables the master **and** writes explicit `enabled = false` rows for the person's other owned projects, so one click never subscribes them to more than they had.
- `GET /api/me/email` gains `topics.projectDigest: { enabled: boolean, projects: [{ id, orgSlug, key, name, enabled }] }`. `projects` lists only projects the person owns (owner/admin orgs); `enabled` is the effective per-project state.
- `PUT /api/me/email` accepts `projectDigest?: boolean` (master; turning on clears per-project opt-outs).
- `PUT /api/me/email/projects/:projectId` `{ enabled: boolean }`: per-project toggle. 403 if the person does not own the project, 400 if the master is off. Humans only, like the rest.

### Settings UI

Extends TAS-40's email section: a master "Daily project changes (06:00)" toggle, and beneath it one toggle per owned project (disabled while the master is off), with a note that the summary goes out at 06:00 in the time zone shown above and only when something changed. Reflects state after unsubscribing by email link (re-fetch on load).

### Tests

Extend `server/scripts/smoke.ts` (log transport, `mailTick(now)`): opt-in required (nothing sent before enabling); owner/admin of the org gets it, plain member and agent do not; only owned projects' events; two zones fire at their own 06:00; empty window sends nothing and a later change sends only the later event; second tick no duplicate and no event reported twice across two days; failing transport keeps the cursor and the retry contains the same events; run/watchdog events excluded; per-project unsubscribe drops only that project, unsubscribe-all stops the mail, re-subscribe restores; master-on clears per-project opt-outs; tampered token rejected; 50-event cap shows "and N more".

### Work breakdown

Under TAS-22, all depending on the TAS-21 infrastructure (TAS-35 migration, TAS-36 mailer, TAS-37 prefs/tokens/tz API, TAS-38 scheduler); the exact tasks and links are in the plan comment on TAS-22. QA is also blocked by TAS-30 (credentials), same as TAS-41.
