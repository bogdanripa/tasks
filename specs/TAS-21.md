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

## Decisions (TAS-23)

1. Provider and credentials arrive later (TAS-30): the sender sits behind a provider-agnostic interface configured by env vars.
2. Per-user time zone, inferred from the browser.
3. Subscribed by default; opt-out link in every email plus a setting in the app.

## Open questions (resolved above; kept for history)

1. Email provider and credentials (no email sending exists in the codebase today).
2. Time zone source: per-user profile setting auto-filled from the browser, or something else?
3. Opt-in vs. opt-out by default.

## Design

This issue builds **shared email infrastructure** (mailer, per-user time zone, preferences, unsubscribe tokens, daily scheduler) and the first consumer of it, the assigned-items summary. TAS-22 (project changes digest) adds a second consumer and must not rebuild any of the shared parts. Everything lives in the existing Fastify server (`server/src`); no new service.

### Data model (migration `020_email.sql`)

- `accounts.timezone text` (IANA name, nullable). Null = not yet known; the scheduler skips such users until it is set.
- `email_prefs (account_id uuid, topic text, scope text not null default '', enabled bool not null, updated_at timestamptz, primary key (account_id, topic, scope))`. A row is an explicit choice; **absence means the topic's default**, which lives in code (`assigned_summary` = on, `project_digest` = off). `scope` is `''` for topic-wide, or a project id for TAS-22's per-project toggles. Only human accounts.
- `email_sends (account_id uuid, topic text, local_date date, status text check (status in ('sending','sent','empty')), claimed_at timestamptz, sent_at timestamptz, primary key (account_id, topic, local_date))`. This is the once-per-user-per-day guarantee, and it holds across restarts, redeploys and two overlapping processes.

### Mailer (`server/src/mailer.ts`)

```ts
type Email = { to: string; subject: string; text: string; html?: string; headers?: Record<string,string> };
interface Transport { send(e: Email): Promise<void> }   // throws on failure
sendEmail(e: Email): Promise<void>                       // picks the transport from config, adds From
```

- `EMAIL_TRANSPORT=log` (the default while nothing is configured): writes the full email to the server log and succeeds. This is what lets TAS-21 and TAS-22 be verified before TAS-30 delivers credentials.
- `EMAIL_TRANSPORT=smtp`: `nodemailer` with `SMTP_URL` (`smtps://user:pass@host:465`). SMTP is offered by every provider (SES, SendGrid, Postmark, Resend, Mailgun, Gmail), so no provider SDK is coupled in. Adding an HTTP-API transport later is one more class implementing `Transport`.
- `EMAIL_FROM` (e.g. `Mustered <noreply@…>`) required for `smtp`. A misconfigured `smtp` transport fails at first send with a clear error, never at boot (the server must boot without credentials).
- Every message from this module carries `List-Unsubscribe` (`<https://…/api/email/unsubscribe?t=…>` and, for one-click, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`) — callers pass the token, the mailer does not guess the topic.

### Unsubscribe tokens and endpoints (`server/src/emailPrefs.ts`)

- Token = `base64url(v1|accountId|topic|scope)` + `.` + `base64url(HMAC-SHA256(key, payload))`, where `key = HMAC(SECRETS_KEY, "email-unsubscribe")`. Stateless, unguessable, no expiry (an old email must keep working), constant-time compare. It grants only "turn this topic/scope off for this account", so a leaked link is low-risk.
- `GET /api/email/unsubscribe?t=` (no auth, HTML): applies the change **immediately and idempotently**, shows "You're unsubscribed from … " with a "Re-subscribe" button (`POST /api/email/resubscribe?t=`). GET acting directly matches the spec's one-click requirement; the cost (a link scanner may unsubscribe a user) is accepted because it is instantly reversible from that page and from Settings.
- `POST /api/email/unsubscribe?t=` : RFC 8058 one-click, same effect, returns 200.
- Invalid token: 400 with a plain page, nothing changed. These routes are exempt from session auth but are documented via `route()` like all others.

### Preferences and time zone API (`routes.ts`)

- `GET /api/me/email` → `{ timezone: string|null, topics: { assignedSummary: boolean, projectDigest?: … } }` (TAS-22 extends `topics`).
- `PUT /api/me/email` `{ timezone?, assignedSummary? }` — validates the zone with `Intl.DateTimeFormat`, humans only.
- `PUT /api/me/timezone` `{ timezone }` sets it **only if currently null** (used by the auto-detect below, so it never overwrites a user's choice).
- `GET /api/me` also returns `timezone`.

### Time zone inference

Account creation happens server-side in the OAuth callback, which has no browser time zone. So: the web app, once signed in and `/api/me` says `timezone === null`, calls `PUT /api/me/timezone` with `Intl.DateTimeFormat().resolvedOptions().timeZone`. New and existing users are both covered on their next visit. Users who never visit again get no email until they do (a deliberate choice: sending at the wrong hour is worse than not sending; documented in the README). Settings lets the user change it (datalist of `Intl.supportedValuesOf('timeZone')`, as in Schedules.tsx).

### Daily scheduler (`server/src/mailScheduler.ts`)

Shared by both topics. Jobs register themselves:

```ts
registerDailyJob({
  topic: 'assigned_summary',
  hour: 7,                                   // local hour to send at (TAS-22 uses 6)
  defaultEnabled: true,
  // Return null when there is nothing to send. `after` runs once the email was sent (TAS-22 advances its window there).
  build(account, ctx: { localDate: string }): Promise<{ email: Omit<Email,'headers'|'to'>; unsubscribe: string /*token*/; after?: () => Promise<void> } | null>
})
```

- `startMailScheduler()` in `index.ts`, next to `startScheduler()`; one tick every `EMAIL_TICK_SECONDS` (default 60), non-overlapping like the watchdog.
- Per tick, per job, candidates are human accounts with a timezone and the topic enabled. For each: compute the user's local date and time (`Intl.DateTimeFormat` with the zone, DST-safe); eligible when local time is within `[hour:00, hour:00 + EMAIL_WINDOW_HOURS)` (default 6, so a failure is retried every tick until 13:00 local, and a restart at 07:30 still sends).
- **Claim:** `insert into email_sends (…, status 'sending') on conflict do nothing`; proceed only if a row was inserted, or an existing `sending` row is older than 10 minutes (crashed mid-send; taken over with an `update … where claimed_at < now() - 10 min`). `sent`/`empty` rows mean done for the day.
- Build → if null, mark `empty` (no email, not re-evaluated). Else `sendEmail`; on success mark `sent` then run `after`; on failure **delete the claim** and log `console.error('mail', …)`, so the next tick retries within the window. A failure for one user never stops the others or the tick, and nothing throws out of the interval.
- The scheduler is in-process like the other timers; `email_sends` is what makes two overlapping processes (a deploy) safe.

### Assigned-items summary (`server/src/assignedSummary.ts`)

- Build: open items (not done, `closed_at is null`, from `item_view`) whose assignee is the account, **restricted to orgs the account is currently a member of** (AC 8), including items in Backlog? **No: Backlog is excluded** (nobody is working on it; matches how agents' runs treat it). Grouped by project, ordered by project key then status column order then number. Task rows show the parent issue ref + title.
- Content: subject `Your open items: N in M projects` ; plain text plus simple HTML, each row = `REF  title — status` linking to `${PUBLIC_URL}/app/i/<org>/<ref>`; footer with an unsubscribe link and a link to Settings.
- Cap: 200 rows total with "and N more — see …/app/".
- Unsubscribe token: topic `assigned_summary`, scope `''`.

### Tests

Extend `server/scripts/smoke.ts` with the `log` transport captured through a test hook (`EMAIL_TRANSPORT=log`, plus `MAIL_TEST_NOW` / an exported `mailTick(now)` so time can be simulated across two zones): one email per user per local date; none when empty; different zones fire at their own 07:00; second tick no duplicate; failing transport is retried and doesn't advance the claim; token tamper rejected; unsubscribe stops it and re-subscribe restores it; items in an org the user left are excluded.

### Work breakdown

See the plan comment on TAS-21. Infra tasks (1–4) are what TAS-22's build tasks depend on.
