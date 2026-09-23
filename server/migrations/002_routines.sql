-- Agents can be driven by a Claude Code routine ("Call via API" trigger) instead of a webhook.
alter table accounts add column routine_url text;
alter table accounts add column routine_token_enc text; -- AES-GCM, see crypto.ts

-- Short-lived keys minted per routine run.
alter table api_keys add column expires_at timestamptz;

alter table notifications drop constraint notifications_delivery_status_check;
alter table notifications add constraint notifications_delivery_status_check
  check (delivery_status in ('pending', 'delivered', 'failed', 'skipped'));

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references accounts(id) on delete cascade,
  item_id uuid references items(id) on delete cascade,
  key_id uuid references api_keys(id) on delete set null,
  reasons text[] not null,
  status text not null check (status in ('fired', 'failed')),
  session_url text,
  error text,
  created_at timestamptz not null default now(),
  -- Set when the run updates its task's status (its last step), or by the idle timeout.
  finished_at timestamptz
);
create index on agent_runs (agent_id, item_id, created_at desc);

-- Set when Anthropic answers 429: no routine in the org fires until then (Retry-After).
create table routine_pauses (
  org_id uuid primary key references orgs(id) on delete cascade,
  until timestamptz not null,
  reason text
);
