-- Org and project connectors are available; each agent switches on the ones it uses (its own always apply).
create table agent_connectors (
  agent_id uuid not null references accounts(id) on delete cascade,
  connector_id uuid not null references connectors(id) on delete cascade,
  primary key (agent_id, connector_id)
);
