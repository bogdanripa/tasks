# TAS-34: Email on assigned tasks

## Goal

When an item (task or issue) is assigned to a **human**, that person receives an email telling them,
so they don't have to be looking at the app to notice new work.

## User-facing behaviour

- Whenever an item's assignee becomes a human account (on creation with an assignee, or on a change of
  assignee, from the web app, REST API or MCP), that human is emailed.
- The email contains: who assigned it (name), the item ref and title, its type (task/issue), the
  parent issue (for a task), the project, and a link to the item (`PUBLIC_URL/app/i/<org>/<KEY-N>`).
  Plain text plus a simple HTML part. No item body beyond a short excerpt.
- Sent to the email on the human's account (the Google sign-in address).
- **No email when:** the assignee is an agent; the human assigns the item to themselves; the assignee
  is unchanged; the assignment is cleared.
- Sending is best-effort and asynchronous: a mail failure never fails or slows the assignment; it is
  logged (metadata only, no body).
- If mail isn't configured on a deployment (no SMTP settings), nothing is sent and a single startup
  warning says so; the app works as before.

## Configuration

Server env vars (documented in README and `.env.example`): `SMTP_URL` (e.g. `smtps://user:pass@host:465`)
and `MAIL_FROM`. Unset = emails disabled.

## Acceptance criteria

1. Assigning a task to human B (by human A or by an agent) sends B one email with the contents above.
2. Creating an item already assigned to a human sends one email.
3. Reassigning to the same person, self-assigning, assigning to an agent, or unassigning sends none.
4. With mail unconfigured or the SMTP server failing, the assignment still succeeds and the failure is logged.
5. Covered by an automated test using a fake/stub transport (no real SMTP in tests).

## Out of scope

- Per-user notification preferences / unsubscribe, digests, emailing for comments, mentions or status
  changes, emailing agents, email-based replies.

## Design

**Correction to the brief.** Mail code *does* exist (TAS-21/36–44): `server/src/mailer.ts` (`sendEmail`, `Transport`,
`setTransportForTests`), env `EMAIL_TRANSPORT` (`log` default | `smtp`), `EMAIL_FROM`, `SMTP_URL`, and the README's
Email section. This feature **reuses that**; it adds no transport, no new env vars and no migration. Deviations from
the spec's Configuration/"unconfigured" wording, all consequences of reusing it:

- The sender var is `EMAIL_FROM` (not `MAIL_FROM`). With `EMAIL_TRANSPORT` unset the mailer's `log` transport writes the
  email to the server log instead of "nothing is sent"; this is the established behaviour and satisfies "app works as
  before". No extra startup warning is added (the mailer already fails only at send time, which we log).
- No preference/unsubscribe topic (spec: out of scope). Do not add `TOPIC_DEFAULTS` entries or `unsubscribeUrl`.

### Where assignment happens

Every place that writes `items.assignee_id` in `server/src/domain.ts` (REST, MCP and web all go through it):

| Site | Cause |
| --- | --- |
| `createItem` (insert with `assignee`) | AC 2 |
| `updateItem` (`changes.assignee && assignee`) | AC 1 |
| `routeItem` (skill routing picks a member) | a human may hold the skill |
| `handOff` → reviewer, and → author on changes requested | a human may be the reviewer/author |

### Components

1. **After-commit hook in `db.ts`.** `afterCommit(tx, fn)` stores `fn` in a `WeakMap<tx, Array<() => void>>`; `mutate`
   runs them **after `sql.begin` resolves** (never on rollback), each wrapped so a throw or rejection is caught and
   logged, and not awaited by the caller (fire-and-forget: the assignment never waits on SMTP).
2. **`server/src/assignmentMail.ts`** exporting `emailAssignment(tx, actor, { itemId, assigneeId, previousAssigneeId })`:
   - Decide *synchronously in the tx* (cheap, no I/O beyond one select): skip when `assigneeId` is null, equals
     `previousAssigneeId`, equals `actor.id`; then `afterCommit(tx, …)` does the rest.
   - After commit: load the assignee (`kind = 'human'`, `email` not null, `deactivated_at is null`, else return — this is
     the agent check) and the item from `item_view` (+ parent ref/title, project name, actor name); build
     `Email` = `{ to, subject: "<actor> assigned you <ref>: <title>", text, html }`; `await sendEmail(...)`; on error
     `console.error('assignment email failed', { ref, to: <account id, not address>, error: err.message })`.
   - Body: assigner name, type (task/issue), `ref` + title, parent (`ref — title`, tasks only), project name, link
     `${config.publicUrl}/app/i/<org>/<KEY-N>`, body excerpt ≤ 200 chars (whitespace-collapsed, `…` if cut). HTML is the
     same fields in a simple template; **escape every interpolated value** (titles are user input). Logs carry metadata
     only — never subject/body/address.
3. **Wiring:** call `emailAssignment` beside each existing `notify(…, 'assigned' | 'review_requested' | 'changes_requested')`
   in the four sites above, passing the previous assignee id (`null` on create/route; `cur.assigneeId` in hand-off;
   `item.assigneeId` in update). Because it compares before/after, reassigning to the same person, self-assignment,
   agents, and unassigning are all no-ops (AC 3). Actor is the `actor` argument (agent or human).
4. **README:** one bullet in the Email section describing assignment emails and that they reuse the mailer settings.

No API, data-model or frontend changes.

### Tests (AC 5)

`server/scripts/assignment-mail-smoke.ts`, `npm run smoke:assignment-mail -w server`, DB-backed like
`project-digest-smoke.ts`, with `setTransportForTests` capturing sends and `await`ing a short flush (export a
`flushMail()` test hook from `db.ts` that awaits outstanding after-commit promises — no sleeps). Cases: assign to human
by human; assign by agent; create-with-assignee; skill-routing and review hand-off to a human; **no email** for same
assignee, self-assign, agent assignee, unassign; transport that throws → `updateItem` still resolves and the failure is
logged; HTML escaping of a `<script>` title; rollback (a failing later statement in the same `mutate`) sends nothing.
Also add it to the `npm run smoke` documentation list in README if smoke scripts are listed there.

### Build plan

1. `backend`: items 1–4 above plus the smoke script (one task; the pieces are small and touch the same lines).
2. `qa`: on staging, with `EMAIL_TRANSPORT=log`, exercise the acceptance criteria through the UI and read the emails from
   the staging server log (`apps_logs`), including the failing-transport case if staging has SMTP configured.
