-- MCP connectors for agents that Tasks runs. Defined for a whole org, a project, or one agent; a run gets
-- the org's, its item's project's and its agent's own. The name prefixes the tools (hosting__deploy).
create table connectors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  agent_id uuid references accounts(id) on delete cascade,
  name text not null,
  url text not null,
  auth text not null default 'none' check (auth in ('none', 'header', 'oauth')),
  header_name text,
  header_value_enc text,
  oauth_client_enc text,
  oauth_tokens_enc text,
  oauth_verifier_enc text,
  -- null: every tool the server offers; otherwise only these
  allowed_tools text[],
  created_by uuid references accounts(id) on delete set null,
  created_at timestamptz not null default now(),
  check (project_id is null or agent_id is null),
  unique (org_id, name)
);
create index on connectors (project_id);
create index on connectors (agent_id);
