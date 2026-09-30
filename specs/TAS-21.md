# TAS-21: Daily email summary of assigned issues

## Goal

Every day at 7:00 in the user's own time zone, email each human user a summary of the open items
assigned to them. Users can unsubscribe.

## User-facing behaviour

- **Who:** human users (not agents) who are subscribed. New and existing users are subscribed by
  default (see open question 3).
- **When:** once a day at 07:00 in the user's time zone. The time zone comes from the user's profile
  setting (default: detected from the browser and saved; see open question 2).
- **What:** open items (not in the last/Done column) assigned to the user, across all their
  projects/orgs, grouped by project: ref, title, status, link to the item. Tasks show their parent issue.
- **If none:** no email is sent.
- **At most one email per user per day**, even after a restart or redeploy.
- **Unsubscribe:** every email has a one-click unsubscribe link (signed token, no login needed) and a
  `List-Unsubscribe` header. The user can also toggle the subscription in their settings in the app,
  and re-subscribe there. Unsubscribing stops these summaries only.

## Acceptance criteria

1. A subscribed user with open assigned items gets one email at ~07:00 local time listing them.
2. A user with no open assigned items gets nothing.
3. Users in different time zones each get theirs at their own 07:00.
4. No duplicate email for the same user and local date.
5. The unsubscribe link works without signing in, is not guessable, and stops further emails.
6. The app has a setting to see/change subscription status and time zone.
7. A failure to send never crashes the server; it is logged and retried within the day's window.
8. Email content only includes items the user can already see.

## Out of scope

Per-item notification emails, digest customisation (time, frequency, filters), agent recipients,
HTML template theming beyond a simple readable layout.

## Open questions (asked of the issue's author)

1. Email provider and credentials (no email sending exists in the codebase today).
2. Time zone source: per-user profile setting auto-filled from the browser, or something else?
3. Opt-in vs. opt-out by default.
