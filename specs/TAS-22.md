# TAS-22: Daily email summary of changes to my projects

## Goal

Every day at 06:00 in the user's own time zone, email each human user a summary of what changed in
the projects they own since the last summary. Users can unsubscribe per project or from all of them.

## User-facing behaviour

- **Who:** human users (not agents) who own at least one project and are subscribed.
- **Owner:** the human who created the project (as `projectOwner()` in `domain.ts` resolves it; falls
  back to an org owner if the creator has left). See open question 1.
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
- Subscribed by default (see open question 2).

## Acceptance criteria

1. An owner of a project with changes since the last summary gets one email at ~06:00 local time listing them.
2. No changes in any owned project: no email.
3. Only projects the user owns appear; only events in those projects.
4. Users in different time zones get theirs at their own 06:00.
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

## Open questions

1. "Projects they own": the creator (as above), or all org owners/admins?
2. Opt-out (subscribed by default) as assumed here, or opt-in?
3. Email provider/credentials: being asked under TAS-21 (TAS-23).
