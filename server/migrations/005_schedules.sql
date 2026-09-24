-- Recurring items: "every day at 9:00, add <title> to <column> assigned to <someone>".
create table schedules (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  cron text not null,
  timezone text not null,
  enabled boolean not null default true,
  title text not null,
  body text not null default '',
  status text,                                     -- column; null = the first one
  assignee_id uuid references accounts(id) on delete set null,
  parent_id uuid references items(id) on delete set null, -- set: create a task under this issue
  skip_if_open boolean not null default false,
  created_by uuid not null references accounts(id),
  created_at timestamptz not null default now(),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_item_id uuid references items(id) on delete set null,
  last_error text
);
create index on schedules (next_run_at) where enabled;
