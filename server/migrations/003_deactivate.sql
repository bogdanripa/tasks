-- Deleted agents are deactivated, not removed: their comments, items and history keep pointing at them.
alter table accounts add column deactivated_at timestamptz;
