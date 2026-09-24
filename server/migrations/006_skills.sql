-- Skills route work: members have skills (per org), an item can need one, a column can default to one.
alter table memberships add column skills text[] not null default '{}';
alter table items add column skill text;
alter table projects add column column_skills jsonb not null default '{}'; -- { "<column>": "<skill>" }
create index on memberships using gin (skills);

-- item_view selected i.* when it was created; recreate it so it picks up the new column.
drop view item_view;
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
