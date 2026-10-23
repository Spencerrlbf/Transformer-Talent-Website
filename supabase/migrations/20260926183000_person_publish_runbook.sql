-- Prepared for the approved cutover runbook. Additive only: no candidate row is
-- rewritten, no writer is enabled and the profile write guard is created OFF.
set local lock_timeout='2s';
set local statement_timeout='30s';

-- 1. Which publish run wrote a before-image, so an undo can be scoped to a run
--    even when the run's own checkpoint was lost between commit and record.
alter table public.person_projection_history add column run_id text;
create index person_projection_history_run_idx
  on public.person_projection_history(run_id, id) where restored_at is null;

-- 2. Durable progress for the batched projection publish and its undo.
create table public.person_publish_runs (
 run_id text primary key check (run_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
 mode text not null check (mode in ('publish','undo')),
 status text not null check (status in ('running','paused','complete','failed')),
 commit_sha text not null,
 last_id uuid,
 processed integer not null default 0,
 counts jsonb not null default '{}' check (jsonb_typeof(counts)='object'),
 notes jsonb not null default '{}' check (jsonb_typeof(notes)='object'),
 started_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 finished_at timestamptz
);
create table public.person_publish_results (
 run_id text not null references public.person_publish_runs(run_id),
 candidate_id uuid not null references public.candidates(id) on delete restrict,
 status text not null,
 revision bigint,
 history_id bigint references public.person_projection_history(id),
 changed_fields text[] not null default '{}',
 email_collision boolean not null default false,
 created_at timestamptz not null default clock_timestamp(),
 primary key (run_id, candidate_id)
);
create index person_publish_results_status_idx on public.person_publish_results(run_id, status);
alter table public.person_publish_runs enable row level security;
alter table public.person_publish_results enable row level security;
revoke all on public.person_publish_runs, public.person_publish_results from public, anon, authenticated;
grant all on public.person_publish_runs, public.person_publish_results to service_role;

-- 3. The profile write guard. While enabled, a change to any compatibility
--    profile column of public.candidates must belong to a transaction that
--    opened an audited person operation for that candidate (person_audit_operations,
--    same transaction). Workflow columns (status, notes, follow_up_at, contact,
--    directory/refresh metadata, embeddings) are not guarded. INSERTs are not
--    guarded here: transactional creation is admitted by its receipt anchor.
--    Created disabled. Toggle only through person_write_guard_set (service role).
create table person_private.write_guard (
 id boolean primary key default true check (id),
 enabled boolean not null default false,
 note text,
 changed_at timestamptz not null default clock_timestamp()
);
insert into person_private.write_guard(id, enabled, note) values (true, false, 'created disabled');
revoke all on person_private.write_guard from public, anon, authenticated;

create function person_private.profile_write_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if not exists (select 1 from person_private.write_guard g where g.id and g.enabled) then return new; end if;
 if (old.full_name, old.current_title, old.current_company, old.current_company_id, old.work_experience,
     old.education, old.education_schools, old.education_degrees, old.education_fields, old.top_skills,
     old.all_skills_text, old.previous_companies, old.headline, old.profile_summary, old.location,
     old.profile_picture_url, old.email, old.phone)
    is distinct from
    (new.full_name, new.current_title, new.current_company, new.current_company_id, new.work_experience,
     new.education, new.education_schools, new.education_degrees, new.education_fields, new.top_skills,
     new.all_skills_text, new.previous_companies, new.headline, new.profile_summary, new.location,
     new.profile_picture_url, new.email, new.phone) then
  if not exists (select 1 from public.person_audit_operations o
                 where o.candidate_id = new.id and o.transaction_id = pg_current_xact_id()) then
   raise exception 'person_profile_write_guard'
     using errcode = 'P0001',
           hint = 'Profile columns of public.candidates change only inside an audited person operation.';
  end if;
 end if;
 return new;
end $$;
revoke all on function person_private.profile_write_guard() from public, anon, authenticated;
-- BEFORE the AFTER capture trigger, so a rejected write leaves no event.
create trigger person_profile_write_guard before update on public.candidates
  for each row execute function person_private.profile_write_guard();

create function public.person_write_guard_status() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('enabled', g.enabled, 'note', g.note, 'changed_at', g.changed_at)
 from person_private.write_guard g where g.id;
$$;
create function public.person_write_guard_set(p_enabled boolean, p_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if p_enabled is null or p_note is null or length(p_note) not between 1 and 200 then
  raise exception 'person_write_guard_invalid';
 end if;
 update person_private.write_guard set enabled = p_enabled, note = p_note, changed_at = clock_timestamp() where id;
 return public.person_write_guard_status();
end $$;
revoke all on function public.person_write_guard_status() from public, anon, authenticated;
revoke all on function public.person_write_guard_set(boolean, text) from public, anon, authenticated;
grant execute on function public.person_write_guard_status() to service_role;
grant execute on function public.person_write_guard_set(boolean, text) to service_role;
