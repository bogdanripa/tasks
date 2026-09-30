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
