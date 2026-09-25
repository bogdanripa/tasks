-- Agents that Tasks runs or starts (in-house, Claude routines) work in the project's repository. Without one,
-- their work waits on a task asking a human to connect it; this is that task (one open at a time per project).
alter table projects add column repo_setup_item_id uuid references items(id) on delete set null;
