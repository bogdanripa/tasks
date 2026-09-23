create extension if not exists pgcrypto;

create table orgs (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  name text not null,
  created_at timestamptz not null default now()
);

-- Humans are global (one Google identity, many orgs). Agents belong to exactly one org.
create table accounts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('human', 'agent')),
  name text not null,
  email text unique,
  google_sub text unique,
  avatar_url text,
  org_id uuid references orgs(id) on delete cascade,
  webhook_url text,
  webhook_secret text,
  created_by uuid references accounts(id),
  created_at timestamptz not null default now(),
  check ((kind = 'agent') = (org_id is not null))
);

create table memberships (
  org_id uuid not null references orgs(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, account_id)
);
create index on memberships (account_id);

create table invites (
  org_id uuid not null references orgs(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'member')),
  invited_by uuid references accounts(id),
  created_at timestamptz not null default now(),
  primary key (org_id, email)
);
create index on invites (email);

create table sessions (
  token_hash text primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  expires_at timestamptz not null
);

create table api_keys (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  name text not null,
  prefix text not null,
  hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  key text not null check (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name text not null,
  description text not null default '',
  columns text[] not null default array['Backlog', 'Todo', 'In progress', 'Review', 'Done'],
  next_number int not null default 1,
  created_at timestamptz not null default now(),
  unique (org_id, key)
);

-- An issue is a need; tasks are the assignable work under an issue (same project).
create table items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  number int not null,
  type text not null check (type in ('issue', 'task')),
  parent_id uuid references items(id) on delete cascade,
  title text not null,
  body text not null default '',
  status text not null,
  position double precision not null default 0,
  assignee_id uuid references accounts(id) on delete set null,
  created_by uuid not null references accounts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (project_id, number),
  check ((type = 'task') = (parent_id is not null))
);
create index on items (project_id, status, position);
create index on items (assignee_id) where closed_at is null;
create index on items (parent_id);

-- Dependencies between items, across projects and orgs. 'triggered' links are permanent.
create table links (
  id uuid primary key default gen_random_uuid(),
  from_id uuid not null references items(id) on delete cascade,
  to_id uuid not null references items(id) on delete cascade,
  kind text not null check (kind in ('triggered', 'blocks', 'relates')),
  created_by uuid not null references accounts(id),
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  check (from_id <> to_id)
);
create unique index on links (from_id, to_id, kind) where removed_at is null;
create index on links (to_id);

create table comments (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items(id) on delete cascade,
  author_id uuid not null references accounts(id),
  body text not null,
  created_at timestamptz not null default now()
);
create index on comments (item_id, created_at);

-- Append-only log. Source of item history, project timelines and notifications.
create table events (
  id bigserial primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  item_id uuid references items(id) on delete cascade,
  actor_id uuid not null references accounts(id),
  type text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on events (project_id, id desc);
create index on events (item_id, id desc);

-- Per-account inbox; for agents with a webhook it doubles as the delivery outbox.
create table notifications (
  id bigserial primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  event_id bigint not null references events(id) on delete cascade,
  item_id uuid references items(id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  delivery_status text check (delivery_status in ('pending', 'delivered', 'failed')),
  attempts int not null default 0,
  next_attempt_at timestamptz,
  last_error text
);
create index on notifications (account_id, id) where read_at is null;
create index on notifications (next_attempt_at) where delivery_status = 'pending';

create view item_view as
select i.*,
       p.key as project_key,
       p.org_id,
       o.slug as org_slug,
       o.slug || '/' || p.key || '-' || i.number as ref,
       (i.status = p.columns[array_length(p.columns, 1)]) as done,
       a.name as assignee_name,
       a.kind as assignee_kind
from items i
join projects p on p.id = i.project_id
join orgs o on o.id = p.org_id
left join accounts a on a.id = i.assignee_id;
