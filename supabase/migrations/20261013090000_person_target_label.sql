-- Project-held identity for the runtime target proof. A physical clone of a
-- project (the copy restored from production's backup) keeps pg_control_system's
-- identifier, so that identifier alone cannot tell the copy from production:
-- on 2026-10-13 both reported 7550817586112808987. The database therefore
-- carries the project ref it belongs to, written ONCE by an operator with an
-- explicit value and never inferred from the environment. Every consumer of
-- public.person_target_identity() (server gate, operator CLIs, sweep
-- preparation, ownership recovery and cleanup) requires the label to be present
-- and equal to PERSON_TARGET_PROJECT_REF; a missing label is refused, a label
-- for another project is refused, and nothing relabels a database to match.
--
-- Operator step after installing this file (session endpoint, psql):
--   select person_private.target_label('<project ref>');     -- or 'local'
-- The function inserts the label when none exists, returns the existing row
-- when it already names the same project, and refuses any other value
-- (target_label_exists). Rows cannot be updated, deleted or truncated
-- (target_identity_immutable). The table and the function are not reachable
-- through PostgREST (person_private is not exposed; all grants revoked).
-- Safe on a fresh install and on a database that already has the chain.
set local lock_timeout='2s';set local statement_timeout='30s';
create table if not exists person_private.target_identity (
 singleton boolean primary key default true check(singleton),
 project_ref text not null check(project_ref='local' or project_ref ~ '^[a-z]{20}$'),
 labelled_at timestamptz not null default now(),
 labelled_by text not null default current_user,
 note text check(note is null or length(note)<=200)
);
alter table person_private.target_identity enable row level security;
revoke all on person_private.target_identity from public,anon,authenticated,service_role;

create or replace function person_private.target_identity_immutable() returns trigger
language plpgsql set search_path='' as $$
begin
 raise exception 'target_identity_immutable' using errcode='P0001';
end$$;
revoke all on function person_private.target_identity_immutable() from public,anon,authenticated,service_role;
create or replace trigger target_identity_immutable before update or delete or truncate
 on person_private.target_identity for each statement
 execute function person_private.target_identity_immutable();

create or replace function person_private.target_label(p_ref text) returns jsonb
language plpgsql set search_path='' as $$
declare existing text;
begin
 if p_ref is null or not (p_ref='local' or p_ref ~ '^[a-z]{20}$') then
  raise exception 'target_label_invalid' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(72021);
 select project_ref into existing from person_private.target_identity where singleton;
 if existing is null then
  insert into person_private.target_identity(project_ref) values(p_ref);
 elsif existing<>p_ref then
  raise exception 'target_label_exists' using errcode='P0001';
 end if;
 return (select jsonb_build_object('project_ref',project_ref,'labelled_at',labelled_at,'labelled_by',labelled_by,'created',existing is null)
         from person_private.target_identity where singleton);
end$$;
revoke all on function person_private.target_label(text) from public,anon,authenticated,service_role;

-- The runtime identity now carries the label (null until an operator labels the
-- database; consumers refuse null). Same grants as 20261003090000.
create or replace function public.person_target_identity() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'system_identifier',(select system_identifier::text from pg_control_system()),
  'project_ref',(select project_ref from person_private.target_identity where singleton),
  'labelled_at',(select labelled_at from person_private.target_identity where singleton),
  'database',current_database(),
  'server_version',current_setting('server_version'),
  'observed_at',now());
$$;
revoke all on function public.person_target_identity() from public,anon,authenticated;
grant execute on function public.person_target_identity() to service_role;
