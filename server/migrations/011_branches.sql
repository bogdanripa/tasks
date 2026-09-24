-- A project names its production branch and its development branch (github_base: where work starts and
-- lands). The same branch for both means working directly on it, with no release step. How work moves
-- between them beyond that (PRs, who merges) belongs in the project guidelines.
alter table projects drop column if exists github_delivery;
alter table projects add column github_prod text not null default 'main';
