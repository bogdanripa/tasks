-- A column can hand tasks to a skill on entry (e.g. Review → review); the task returns to its author
-- (handed_off_from) if it's sent back.
alter table projects add column column_handoffs jsonb not null default '{}'; -- { "<column>": "<skill>" }
alter table items add column handed_off_from uuid references accounts(id) on delete set null;

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
