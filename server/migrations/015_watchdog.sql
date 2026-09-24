-- The watchdog's memory per stalled item: nudges sent in its current status, and when a human was pinged.
create table watchdog_state (
  item_id uuid primary key references items(id) on delete cascade,
  status text not null,
  nudges int not null default 0,
  last_nudged_at timestamptz,
  escalated_at timestamptz
);
