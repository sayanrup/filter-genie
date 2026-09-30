-- Shared saved results for the Search Filter Generator.
-- Anyone who opens the website can read, add and delete saved results (no login).
-- Tighten the policies below (and add an auth column) if that stops being acceptable.

create table if not exists public.saved_runs (
  id text primary key,
  name text not null,
  model text not null,
  saved_at timestamptz not null default now(),
  -- The whole saved entry: filters (with and without context), comparison, and the inputs used.
  entry jsonb not null
);

create index if not exists saved_runs_saved_at_idx on public.saved_runs (saved_at desc);

alter table public.saved_runs enable row level security;

create policy "saved_runs are readable by everyone"
  on public.saved_runs for select using (true);

create policy "saved_runs can be added by everyone"
  on public.saved_runs for insert with check (true);

create policy "saved_runs can be deleted by everyone"
  on public.saved_runs for delete using (true);
