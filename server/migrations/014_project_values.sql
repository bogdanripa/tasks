-- Shared key/value notes per project (e.g. staging_url) that any member, human or agent, can read and change.
create table project_values (
  project_id uuid not null references projects(id) on delete cascade,
  key text not null,
  value text not null,
  updated_by uuid references accounts(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (project_id, key)
);
