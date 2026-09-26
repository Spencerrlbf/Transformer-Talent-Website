-- Bounded network batching for the shadow backfill; source rules are unchanged.
set local lock_timeout='2s';
set local statement_timeout='30s';

-- A bulk transaction can visit many identities, organizations, skills and
-- emails. Isolate it from other normalized writers before any row/index lock;
-- prelocking only advisory keys would invert the implicit unique-index order.
-- Individual writers keep concurrency through the shared side of this gate.
do $gate$
declare definition text; needle text:='perform pg_advisory_xact_lock(hashtext(v_cid::text));';
begin
 definition:=pg_get_functiondef('public.save_person(jsonb)'::regprocedure);
 if position(needle in definition)=0 or position('72005' in definition)>0 then
  raise exception 'Unexpected save_person lock definition';
 end if;
 execute replace(definition,needle,'perform pg_advisory_xact_lock_shared(72005,0);' || chr(10) || '  ' || needle);
end $gate$;

create function person_private.lock_backfill_items(p_items jsonb) returns void
language plpgsql set search_path='' as $$
begin
 perform pg_advisory_xact_lock(72005,0);
end $$;
revoke all on function person_private.lock_backfill_items(jsonb) from public,anon,authenticated;
grant execute on function person_private.lock_backfill_items(jsonb) to service_role;

create function public.person_backfill_save_many(p_run text,p_items jsonb) returns jsonb
language plpgsql set search_path='' set lock_timeout='2s' set statement_timeout='20s' as $$
declare item jsonb; results jsonb:='[]';
begin
 if p_items is null or jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 10 then raise exception 'Invalid save batch'; end if;
 if (select count(distinct (i->>'candidate_id')::uuid) from jsonb_array_elements(p_items) i)<>jsonb_array_length(p_items) then raise exception 'Duplicate or missing candidate'; end if;
 if not exists(select 1 from public.backfill_runs where run_id=p_run and status='running') then raise exception 'Run is not active'; end if;
 perform person_private.lock_backfill_items(p_items);
 for item in select value from jsonb_array_elements(p_items) loop
  results:=results||jsonb_build_array(jsonb_build_object('candidate_id',item->>'candidate_id')||public.person_backfill_save(p_run,(item->>'candidate_id')::uuid,item->'docs',(item->>'version')::bigint));
 end loop;
 return results;
end $$;

create function public.person_backfill_audit_many(p_run text,p_items jsonb) returns jsonb
language plpgsql set search_path='' set lock_timeout='2s' set statement_timeout='20s' as $$
declare item jsonb; results jsonb:='[]';
begin
 if p_items is null or jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Invalid audit batch'; end if;
 if (select count(distinct (i->>'candidate_id')::uuid) from jsonb_array_elements(p_items) i)<>jsonb_array_length(p_items) then raise exception 'Duplicate or missing candidate'; end if;
 if not exists(select 1 from public.backfill_runs where run_id=p_run and status='running') then raise exception 'Run is not active'; end if;
 perform pg_advisory_xact_lock_shared(72005,0);
 for item in select value from jsonb_array_elements(p_items) order by value->>'candidate_id' loop
  if jsonb_typeof(item->'checks') is distinct from 'object' then raise exception 'Missing checks'; end if;
  perform public.person_backfill_flag_missing_employers((item->>'candidate_id')::uuid);
  results:=results||jsonb_build_array(public.person_backfill_audit(p_run,(item->>'candidate_id')::uuid,(item->>'revision')::bigint,(item->>'version')::bigint,item->'checks'));
 end loop;
 return results;
end $$;
revoke all on function public.person_backfill_save_many(text,jsonb),public.person_backfill_audit_many(text,jsonb) from public,anon,authenticated;
grant execute on function public.person_backfill_save_many(text,jsonb),public.person_backfill_audit_many(text,jsonb) to service_role;
