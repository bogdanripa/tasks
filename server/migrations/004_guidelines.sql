-- How to work in a project / organization. Sent to agents with every run, shown on settings pages.
alter table projects add column guidelines text not null default '';
alter table orgs add column guidelines text not null default '';
