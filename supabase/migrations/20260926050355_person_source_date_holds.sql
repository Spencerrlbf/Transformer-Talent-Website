-- A legacy cache-hit timestamp records reuse, not when Harvest fetched facts.
-- Retain those rows as unresolved evidence; never publish guessed chronology.
set local lock_timeout='2s';
set local statement_timeout='30s';
create table public.person_source_holds(
 candidate_id uuid not null references public.candidates(id) on delete cascade,
 ledger_id uuid not null,
 evidence_hash text not null,
 reason text not null check(reason='harvest_cache_date_unknown'),
 evidence jsonb not null,
 recorded_at timestamptz not null default clock_timestamp(),
 resolved_at timestamptz,
 resolution jsonb,
 primary key(candidate_id,ledger_id,evidence_hash),
 check((resolved_at is null)=(resolution is null))
);
create index person_source_holds_open_idx on public.person_source_holds(candidate_id) where resolved_at is null;
alter table public.person_source_holds enable row level security;
revoke all on public.person_source_holds from public,anon,authenticated;
grant all on public.person_source_holds to service_role;
create function person_private.hold_cache_date() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a' and new.provider='harvest'
  and new.status='ok' and new.cache_status='hit' and new.raw_payload is not null and new.candidate_id is not null then
  perform 1 from public.candidates where id=new.candidate_id for key share;
  if not found then return null;end if;
  insert into public.person_source_holds(candidate_id,ledger_id,evidence_hash,reason,evidence)
  values(new.candidate_id,new.id,md5(jsonb_build_array(new.created_at,new.raw_payload)::text),'harvest_cache_date_unknown',to_jsonb(new)) on conflict do nothing;
 end if;
 return null;
end $$;
revoke all on function person_private.hold_cache_date() from public,anon,authenticated;
-- Alphabetically follows person_capture_change, so the existing capture gate
-- and parent/capture locks already protect this transaction's final boundary.
create trigger person_source_date_hold after insert or update on public.candidate_enrichments
 for each row execute function person_private.hold_cache_date();
insert into public.person_source_holds(candidate_id,ledger_id,evidence_hash,reason,evidence)
select e.candidate_id,e.id,md5(jsonb_build_array(e.created_at,e.raw_payload)::text),'harvest_cache_date_unknown',to_jsonb(e)
from public.candidate_enrichments e join public.candidates c on c.id=e.candidate_id
where e.organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a' and e.provider='harvest'
 and e.status='ok' and e.cache_status='hit' and e.raw_payload is not null and e.candidate_id is not null;

-- A historical ledger can reference a person not yet present in the pool.
-- Keep legacy acceptance, and establish holds if that person is later created.
create function person_private.hold_existing_cache_dates() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into public.person_source_holds(candidate_id,ledger_id,evidence_hash,reason,evidence)
 select new.id,e.id,md5(jsonb_build_array(e.created_at,e.raw_payload)::text),'harvest_cache_date_unknown',to_jsonb(e)
 from public.candidate_enrichments e where e.candidate_id=new.id
 and e.organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a' and e.provider='harvest'
 and e.status='ok' and e.cache_status='hit' and e.raw_payload is not null on conflict do nothing;
 return null;
end $$;
revoke all on function person_private.hold_existing_cache_dates() from public,anon,authenticated;
create trigger person_source_date_hold after insert on public.candidates
 for each row execute function person_private.hold_existing_cache_dates();

-- Edit only the already-reviewed migration functions, with exact shape guards.
do $patch$
declare definition text; needle text;
begin
 definition:=pg_get_functiondef('public.save_person(jsonb)'::regprocedure);
 needle:='perform pg_advisory_xact_lock(hashtext(v_cid::text));';
 if position(needle in definition)=0 or position('source_date_unresolved' in definition)>0 then raise exception 'Unexpected writer definition';end if;
 execute replace(definition,needle,needle||chr(10)||'  if exists(select 1 from public.person_source_holds where candidate_id=v_cid and resolved_at is null) then raise exception ''source_date_unresolved'';end if;');
 definition:=pg_get_functiondef('public.person_backfill_page(text,integer)'::regprocedure);
 needle:='where (r.last_id is null or c.id>r.last_id)';
 if position(needle in definition)=0 then raise exception 'Unexpected page definition';end if;
 execute replace(definition,needle,needle||chr(10)||'   and not exists(select 1 from public.person_source_holds h where h.candidate_id=c.id and h.resolved_at is null)');
 definition:=pg_get_functiondef('public.person_backfill_audit(text,uuid,bigint,bigint,jsonb)'::regprocedure);
 needle:='if rev<>p_revision then';
 if position(needle in definition)=0 then raise exception 'Unexpected audit definition';end if;
 execute replace(definition,needle,'if exists(select 1 from public.person_source_holds where candidate_id=p_candidate and resolved_at is null) then raise exception ''source_date_unresolved'';end if;'||chr(10)||' '||needle);
 definition:=pg_get_functiondef('public.person_reconcile_record_many(text,jsonb)'::regprocedure);
 needle:='  if state=''verified'' then';
 if position(needle in definition)=0 then raise exception 'Unexpected record definition';end if;
 execute replace(definition,needle,'  if exists(select 1 from public.person_source_holds where candidate_id=cid and resolved_at is null) then'||chr(10)||'   state:=''review'';item:=jsonb_set(item,''{checks}'',item->''checks''||jsonb_build_object(''reason'',''harvest_cache_date_unknown''));'||chr(10)||'  end if;'||chr(10)||needle);
 definition:=pg_get_functiondef('public.person_reconcile_finish(text,boolean)'::regprocedure);
 needle:='state:=case when reviews>0 then';
 if position(needle in definition)=0 then raise exception 'Unexpected finish definition';end if;
 definition:=replace(definition,needle,'state:=case when reviews>0 or exists(select 1 from public.person_source_holds where resolved_at is null) then');
 needle:='''unresolved_review'',reviews,';
 if position(needle in definition)=0 then raise exception 'Unexpected finish accounting';end if;
 execute replace(definition,needle,needle||'''source_date_holds'',(select count(distinct candidate_id) from public.person_source_holds where resolved_at is null),');
 definition:=pg_get_functiondef('public.person_backfill_status(text,text,jsonb)'::regprocedure);
 needle:='notes=notes||p_notes,';
 if position(needle in definition)=0 then raise exception 'Unexpected status definition';end if;
 execute replace(definition,needle,'notes=notes||p_notes||jsonb_build_object(''source_date_holds'',(select count(distinct candidate_id) from public.person_source_holds where resolved_at is null)),');
end $patch$;
