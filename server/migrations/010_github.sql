-- GitHub: an organization installs the Tasks GitHub App once; each project points at one repository.
create table org_github (
  org_id uuid primary key references orgs(id) on delete cascade,
  installation_id bigint not null,
  account_login text not null,
  account_type text not null,
  installed_by uuid references accounts(id) on delete set null,
  created_at timestamptz not null default now()
);
create index on org_github (installation_id);

alter table projects add column github_repo text;                       -- owner/name
alter table projects add column github_base text not null default 'main';
alter table projects add column github_delivery text not null default 'pr' check (github_delivery in ('pr', 'merge'));
