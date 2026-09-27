-- Images pasted/uploaded into item descriptions and comments. No FK to items/comments:
-- an image is uploaded before the body that will reference it is saved (sometimes before
-- the user finishes typing at all), and a rejected or abandoned upload must never corrupt
-- the surrounding text. The only link is the `![](url)` reference inside the Markdown body.
create table images (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  uploaded_by uuid references accounts(id) on delete set null,
  mime_type text not null,
  byte_size integer not null,
  data bytea not null,
  created_at timestamptz not null default now()
);
create index on images (org_id);
