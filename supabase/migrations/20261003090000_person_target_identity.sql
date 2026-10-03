-- Runtime identity of the database cluster, so a REST client and a PostgreSQL
-- client can be proved to reach the same physical database before an operator
-- tool, worker or server path takes effect (RR-06/RR-07). A restored copy is a
-- different cluster: its pg_control_system identifier differs even though every
-- row and organization id was copied. Read-only; service_role only; no
-- candidate data. Safe on a fresh install and on a database that already has
-- the earlier chain installed.
create or replace function public.person_target_identity() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'system_identifier',(select system_identifier::text from pg_control_system()),
  'database',current_database(),
  'server_version',current_setting('server_version'),
  'observed_at',now());
$$;
revoke all on function public.person_target_identity() from public,anon,authenticated;
grant execute on function public.person_target_identity() to service_role;
