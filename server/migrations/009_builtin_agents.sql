-- Tasks can run agents itself: an org stores LLM provider keys; an agent picks a provider and model.
create table ai_providers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  provider text not null check (provider in ('openai', 'anthropic', 'google', 'xai', 'openai-compatible')),
  label text not null,
  api_key_enc text not null,          -- AES-GCM, see crypto.ts
  base_url text,                      -- openai-compatible only (OpenRouter, a local server, …)
  created_by uuid references accounts(id) on delete set null,
  created_at timestamptz not null default now()
);
create index on ai_providers (org_id);

alter table accounts add column runtime_provider_id uuid references ai_providers(id) on delete set null;
alter table accounts add column runtime_model text;
alter table accounts add column runtime_max_steps int not null default 40;

alter table agent_runs add column runtime text not null default 'routine' check (runtime in ('routine', 'builtin'));
alter table agent_runs add column notification_ids bigint[] not null default '{}';
alter table agent_runs add column model text;
alter table agent_runs add column input_tokens int not null default 0;
alter table agent_runs add column output_tokens int not null default 0;
alter table agent_runs add column steps int not null default 0;

-- What an in-house run did, step by step (prompt, model text, tool calls and results, errors).
create table run_steps (
  id bigserial primary key,
  run_id uuid not null references agent_runs(id) on delete cascade,
  kind text not null check (kind in ('system', 'prompt', 'text', 'tool_call', 'tool_result', 'error', 'note')),
  content jsonb not null,
  created_at timestamptz not null default now()
);
create index on run_steps (run_id, id);
