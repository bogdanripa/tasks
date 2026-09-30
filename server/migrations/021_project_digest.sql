-- TAS-22: daily project-changes digest. One row per person: the end of the
-- window covered by the last digest actually *sent* to them. The scheduler
-- advances it only after a successful send, so a failed send is retried over
-- the same events. Preferences live in email_prefs (topic 'project_digest').
create table if not exists digest_cursors (
  account_id    uuid primary key references accounts(id) on delete cascade,
  last_event_id bigint not null,
  sent_at       timestamptz not null
);
