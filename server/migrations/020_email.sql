-- Email infrastructure (TAS-21, shared with TAS-22).
-- Null timezone = not yet known; the mail scheduler skips such accounts until it is set.
alter table accounts add column timezone text;

-- A row is an explicit choice; absence means the topic's default, which lives in code.
-- scope is '' for topic-wide, or a project id for per-project toggles.
create table email_prefs (
  account_id uuid not null references accounts(id) on delete cascade,
  topic text not null,
  scope text not null default '',
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (account_id, topic, scope)
);

-- The once-per-user-per-day guarantee, across restarts, redeploys and overlapping processes.
create table email_sends (
  account_id uuid not null references accounts(id) on delete cascade,
  topic text not null,
  local_date date not null,
  status text not null check (status in ('sending', 'sent', 'empty')),
  claimed_at timestamptz not null default now(),
  sent_at timestamptz,
  primary key (account_id, topic, local_date)
);
