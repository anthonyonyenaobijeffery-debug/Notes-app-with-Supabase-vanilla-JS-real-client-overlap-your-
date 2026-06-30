-- ============================================================
-- Notes table. updated_at is the field the app uses for both
-- realtime sync and optimistic-concurrency conflict detection.
-- ============================================================
create table if not exists notes (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default '',
  content     text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- The database — not the client — owns updated_at. Every UPDATE
-- bumps it automatically via this trigger, so the timestamp the
-- client compares against can't be forged or forgotten in JS.
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_notes_updated_at on notes;
create trigger trg_notes_updated_at
before update on notes
for each row
execute function set_updated_at();

-- RLS is required before the anon key can touch the table.
-- This policy allows full public access — fine for a demo,
-- NOT for production data.
alter table notes enable row level security;

drop policy if exists "public full access (demo only)" on notes;
create policy "public full access (demo only)"
on notes
for all
using (true)
with check (true);

-- Add the table to Supabase's realtime publication so row
-- changes stream to every connected client over websockets.
alter publication supabase_realtime add table notes;
