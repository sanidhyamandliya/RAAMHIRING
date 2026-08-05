-- ============================================================
-- Apex Assessment — Relational schema (replaces public.kv)
-- Run in Supabase → SQL Editor
-- Safe to re-run (IF NOT EXISTS / drop policies)
-- ============================================================

-- 1) Colleges
create table if not exists public.colleges (
  id            text primary key,
  name          text not null,
  open          boolean not null default false,
  ended         boolean not null default false,
  start_time    bigint not null default 0,
  expire_time   bigint not null default 0,
  ended_at      bigint,
  accent        text default '#d4a843',
  welcome       text default '',
  land_title    text,
  land_eyebrow  text,
  created_at    timestamptz not null default now(),
  created_by    text default ''
);

-- 2) Candidates
create table if not exists public.candidates (
  id                uuid primary key default gen_random_uuid(),
  email             text not null unique,
  fname             text default '',
  lname             text default '',
  phone             text default '',
  college           text default '',
  college_id        text references public.colleges(id) on delete set null,
  pass_year         text default '',
  deg               text default '',
  prog              text default '',
  prog_key          text default '',
  status            text not null default 'in_progress'
                      check (status in ('in_progress','completed','terminated')),
  completed_rounds  int not null default 0,
  violations        int not null default 0,
  registered_at     timestamptz,
  submitted_at      timestamptz,
  device_id         text default '',
  cert_id           text,
  hr_status         text check (hr_status is null or hr_status in ('shortlist','review','hold','hired')),
  hired             boolean not null default false,
  hired_at          timestamptz,
  hired_by          text,
  deleted_at        timestamptz,
  deleted_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists candidates_status_idx on public.candidates (status);
create index if not exists candidates_deleted_idx on public.candidates (deleted_at);
create index if not exists candidates_email_idx on public.candidates (email);

-- 3) Per-round scores (one row per round)
create table if not exists public.candidate_scores (
  candidate_id  uuid not null references public.candidates(id) on delete cascade,
  round_index   int not null check (round_index between 0 and 5),
  score         int not null check (score between 0 and 100),
  updated_at    timestamptz not null default now(),
  primary key (candidate_id, round_index)
);

-- 4) Live event feed
create table if not exists public.events (
  id                uuid primary key default gen_random_uuid(),
  type              text not null,
  candidate_email   text,
  candidate_name    text,
  device_id         text,
  round_index       int,
  round_name        text,
  round_score       int,
  reason            text,
  violation_count   int,
  meta              jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists events_created_idx on public.events (created_at desc);
create index if not exists events_email_idx on public.events (candidate_email);
create index if not exists events_type_idx on public.events (type);

-- 5) Blocks
create table if not exists public.blocked_devices (
  device_id   text primary key,
  email       text default '',
  reason      text default 'termination',
  blocked_at  timestamptz not null default now()
);

create table if not exists public.blocked_emails (
  email       text primary key,
  device_id   text,
  reason      text default 'termination',
  blocked_at  timestamptz not null default now()
);

-- 6) Custom question banks (rounds 0–3)
create table if not exists public.custom_questions (
  round_index  int primary key check (round_index between 0 and 3),
  questions    jsonb not null default '[]'::jsonb,
  updated_at   timestamptz not null default now()
);

-- 7) updated_at trigger for candidates
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists candidates_set_updated_at on public.candidates;
create trigger candidates_set_updated_at
  before update on public.candidates
  for each row execute function public.set_updated_at();

-- 8) Realtime
do $$ begin
  alter publication supabase_realtime add table public.candidates;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.candidate_scores;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.events;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.colleges;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.blocked_devices;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.blocked_emails;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.custom_questions;
exception when duplicate_object then null;
end $$;

-- 9) RLS — open for campus-drive MVP (tighten later)
alter table public.candidates enable row level security;
alter table public.candidate_scores enable row level security;
alter table public.events enable row level security;
alter table public.colleges enable row level security;
alter table public.blocked_devices enable row level security;
alter table public.blocked_emails enable row level security;
alter table public.custom_questions enable row level security;

do $$ declare t text;
begin
  foreach t in array array[
    'candidates','candidate_scores','events','colleges',
    'blocked_devices','blocked_emails','custom_questions'
  ]
  loop
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select using (true)', t, t);
    execute format('create policy %I_insert on public.%I for insert with check (true)', t, t);
    execute format('create policy %I_update on public.%I for update using (true) with check (true)', t, t);
    execute format('create policy %I_delete on public.%I for delete using (true)', t, t);
  end loop;
end $$;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

-- ============================================================
-- 10) Resumes — uploaded at registration, stored in Storage
-- ============================================================
create table if not exists public.resumes (
  id              uuid primary key default gen_random_uuid(),
  candidate_email text not null,
  file_path       text not null,
  file_name       text not null,
  file_size       int,
  mime_type       text,
  uploaded_at     timestamptz not null default now()
);

create index if not exists resumes_email_idx on public.resumes (candidate_email);

do $$ begin
  alter publication supabase_realtime add table public.resumes;
exception when duplicate_object then null;
end $$;

alter table public.resumes enable row level security;
drop policy if exists resumes_read on public.resumes;
drop policy if exists resumes_insert on public.resumes;
create policy resumes_read on public.resumes for select using (true);
create policy resumes_insert on public.resumes for insert with check (true);

grant select, insert on public.resumes to anon, authenticated;

-- Storage bucket for resume files (public — matches the rest of this schema's
-- open-MVP RLS posture; tighten to signed URLs later if resumes need to be private)
insert into storage.buckets (id, name, public)
values ('resumes', 'resumes', true)
on conflict (id) do nothing;

drop policy if exists resumes_obj_insert on storage.objects;
drop policy if exists resumes_obj_read on storage.objects;
create policy resumes_obj_insert on storage.objects for insert to anon, authenticated with check (bucket_id = 'resumes');
create policy resumes_obj_read on storage.objects for select to anon, authenticated using (bucket_id = 'resumes');

-- ============================================================
-- 11) Post-test rating & feedback
-- ============================================================
alter table public.candidates add column if not exists rating int check (rating between 1 and 5);
alter table public.candidates add column if not exists feedback text default '';

-- ============================================================
-- Optional: migrate existing kv rows → relational tables
-- Run once after the CREATE statements above if you have old data.
-- ============================================================
-- Uncomment to migrate:

/*
-- Candidates from apex_candidates/ (old kv-store paths)
insert into public.candidates (
  email, fname, lname, phone, college, college_id, pass_year, deg,
  prog, prog_key, status, completed_rounds, violations,
  registered_at, submitted_at, device_id, cert_id,
  hr_status, hired, hired_at, hired_by
)
select
  coalesce(data->>'email', ''),
  coalesce(data->>'fname', ''),
  coalesce(data->>'lname', ''),
  coalesce(data->>'phone', ''),
  coalesce(data->>'college', ''),
  nullif(data->>'collegeId', ''),
  coalesce(data->>'passYear', ''),
  coalesce(data->>'deg', ''),
  coalesce(data->>'prog', ''),
  coalesce(data->>'progKey', ''),
  case
    when data->>'status' in ('in_progress','completed','terminated') then data->>'status'
    else 'in_progress'
  end,
  coalesce((data->>'completedRounds')::int, 0),
  coalesce((data->>'violations')::int, 0),
  nullif(data->>'registeredAt', '')::timestamptz,
  nullif(data->>'submittedAt', '')::timestamptz,
  coalesce(data->>'deviceId', ''),
  data->>'certId',
  case when data->>'hrStatus' in ('shortlist','review','hold','hired') then data->>'hrStatus' else null end,
  coalesce((data->>'hired')::boolean, false),
  nullif(data->>'hiredAt', '')::timestamptz,
  data->>'hiredBy'
from public.kv
where path like 'apex_candidates/%'
  and path not like 'apex_candidates/%/%'
  and coalesce(data->>'email', '') <> ''
on conflict (email) do update set
  fname = excluded.fname,
  lname = excluded.lname,
  status = excluded.status,
  completed_rounds = excluded.completed_rounds,
  violations = excluded.violations,
  submitted_at = excluded.submitted_at,
  hired = excluded.hired,
  hr_status = excluded.hr_status,
  updated_at = now();

-- Scores arrays → candidate_scores
insert into public.candidate_scores (candidate_id, round_index, score)
select c.id, (ord - 1)::int, (elem)::int
from public.kv k
join public.candidates c on c.email = k.data->>'email'
cross join lateral jsonb_array_elements_text(coalesce(k.data->'scores', '[]'::jsonb))
  with ordinality as t(elem, ord)
where k.path like 'apex_candidates/%'
  and k.path not like 'apex_candidates/%/%'
  and elem ~ '^[0-9]+$'
on conflict (candidate_id, round_index) do update set score = excluded.score;

-- Events
insert into public.events (type, candidate_email, candidate_name, device_id, round_index, round_name, round_score, reason, violation_count, meta, created_at)
select
  coalesce(data->>'type', 'unknown'),
  coalesce(data->>'candidateEmail', data->>'email'),
  coalesce(data->>'candidateName', trim(coalesce(data->>'fname','') || ' ' || coalesce(data->>'lname',''))),
  data->>'deviceId',
  coalesce((data->>'roundJustCompleted')::int, (data->>'round')::int) - 1,
  data->>'roundName',
  (data->>'roundScore')::int,
  data->>'reason',
  (data->>'count')::int,
  data - 'type' - 'ico' - 'time' - '_ts',
  to_timestamp(coalesce((data->>'_ts')::bigint, extract(epoch from now())::bigint * 1000) / 1000.0)
from public.kv
where path like 'apex_events/%';

-- Colleges
insert into public.colleges (id, name, open, ended, start_time, expire_time, ended_at, accent, welcome, land_title, land_eyebrow, created_by)
select
  regexp_replace(path, '^apex_colleges/', ''),
  coalesce(data->>'name', ''),
  coalesce((data->>'open')::boolean, false),
  coalesce((data->>'ended')::boolean, false),
  coalesce((data->>'startTime')::bigint, 0),
  coalesce((data->>'expireTime')::bigint, 0),
  (data->>'endedAt')::bigint,
  data->>'accent',
  coalesce(data->>'welcome', ''),
  data->>'landTitle',
  data->>'landEyebrow',
  coalesce(data->>'createdBy', '')
from public.kv
where path like 'apex_colleges/%'
on conflict (id) do update set
  name = excluded.name,
  open = excluded.open,
  ended = excluded.ended;

-- Blocks
insert into public.blocked_devices (device_id, email, reason, blocked_at)
select coalesce(data->>'deviceId', regexp_replace(path, '^apex_blocked/', '')),
       coalesce(data->>'email', ''),
       coalesce(data->>'reason', 'termination'),
       coalesce(nullif(data->>'blockedAt','')::timestamptz, now())
from public.kv where path like 'apex_blocked/%'
on conflict (device_id) do nothing;

insert into public.blocked_emails (email, device_id, reason, blocked_at)
select coalesce(data->>'email', ''),
       data->>'deviceId',
       coalesce(data->>'reason', 'termination'),
       coalesce(nullif(data->>'blockedAt','')::timestamptz, now())
from public.kv where path like 'apex_blocked_emails/%' and coalesce(data->>'email','') <> ''
on conflict (email) do nothing;

-- Custom questions
insert into public.custom_questions (round_index, questions)
select
  (regexp_match(path, 'round(\d+)'))[1]::int,
  coalesce(data->'questions', '[]'::jsonb)
from public.kv
where path ~ '^apex_custom_questions/round[0-3]$'
on conflict (round_index) do update set questions = excluded.questions;
*/
