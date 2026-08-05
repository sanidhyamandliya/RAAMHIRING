-- ============================================================
-- Apex Assessment Platform — Supabase schema
-- Run once in Supabase → SQL Editor → New query → Run
-- Safe to re-run.
-- ============================================================

-- 1) Key/value table (Firebase-style paths)
--    e.g. apex_candidates/john_at_gmail_com  or  apex_events/<autokey>
create table if not exists public.kv (
  path        text primary key,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

create index if not exists kv_path_prefix_idx on public.kv (path text_pattern_ops);

-- 2) Shallow-merge RPC = Firebase .update()
create or replace function public.kv_merge(p_path text, p_data jsonb)
returns void
language sql
as $$
  insert into public.kv (path, data, updated_at)
  values (p_path, p_data, now())
  on conflict (path)
  do update set data = public.kv.data || excluded.data, updated_at = now();
$$;

grant execute on function public.kv_merge(text, jsonb) to anon, authenticated;

-- 3) Realtime (ignore error if already added)
do $$
begin
  alter publication supabase_realtime add table public.kv;
exception
  when duplicate_object then null;
end $$;

-- 4) RLS — open for campus-drive MVP (tighten later)
alter table public.kv enable row level security;

drop policy if exists kv_read   on public.kv;
drop policy if exists kv_insert on public.kv;
drop policy if exists kv_update on public.kv;
drop policy if exists kv_delete on public.kv;

create policy kv_read   on public.kv for select using (true);
create policy kv_insert on public.kv for insert with check (true);
create policy kv_update on public.kv for update using (true) with check (true);
create policy kv_delete on public.kv for delete using (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.kv to anon, authenticated;
