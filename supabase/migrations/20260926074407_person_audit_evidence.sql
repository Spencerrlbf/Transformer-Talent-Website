-- Prepared audit evidence only. No legacy runner/checkpoint or feature flag changes.
set local lock_timeout='3s';
-- Two statements intentionally: existing events remain unattributed (NULL),
-- and adding the volatile default does not rewrite their transaction identity.
alter table public.person_change_events add column transaction_id xid8;
alter table public.person_change_events alter column transaction_id set default pg_current_xact_id();

create table public.person_audit_anchors (
 candidate_id uuid primary key references public.candidates(id) on delete restrict,
 kind text not null check(kind in ('legacy','receipt_created')),
 baseline_run text references public.backfill_runs(run_id),
 parser_version text not null default 'person-v3',
 legacy_doc jsonb,
 before_image jsonb not null check(jsonb_typeof(before_image)='object'),
 source_catalog jsonb not null default '[]' check(jsonb_typeof(source_catalog)='array'),
 revision bigint not null,
 captured_version bigint not null,
 creator_ref text,
 anchor_hash text not null,
 created_at timestamptz not null default clock_timestamp(),
 check ((kind='legacy' and baseline_run is not null and legacy_doc is not null and jsonb_typeof(legacy_doc)='object' and creator_ref is null)
     or (kind='receipt_created' and legacy_doc is null and baseline_run is null and creator_ref is not null))
);
create table public.person_audit_operations (
 id uuid primary key,
 candidate_id uuid not null references public.candidates(id) on delete restrict,
 writer text not null check(writer in ('application','refresh','directory','recruiter','projection','undo')),
 receipt_ref text not null,
 evidence jsonb not null default '{}' check(jsonb_typeof(evidence)='object'),
 transaction_id xid8 not null default pg_current_xact_id(),
 created_at timestamptz not null default clock_timestamp()
);
create index person_audit_operations_candidate_idx on public.person_audit_operations(candidate_id,created_at,id);
create table public.person_change_attributions (
 event_id bigint primary key references public.person_change_events(id) on delete restrict,
 candidate_id uuid not null references public.candidates(id) on delete restrict,
 operation_id uuid not null references public.person_audit_operations(id) on delete restrict,
 scope text not null,
 changed_fields text[] not null,
 event_hash text not null,
 created_at timestamptz not null default clock_timestamp()
);
create index person_change_attributions_candidate_idx on public.person_change_attributions(candidate_id,event_id);
-- Count committed markers, not max(sequence): a lower xid can commit later.
-- No candidate FK or shared counter row means receipt staging adds no lock
-- inversion against a transaction that already holds its candidate row.
create table public.person_audit_epochs (
 scope_kind text not null check(scope_kind in ('candidate','directory')),
 scope_key text not null,
 transaction_id xid8 not null default pg_current_xact_id(),
 created_at timestamptz not null default clock_timestamp(),
 primary key(scope_kind,scope_key,transaction_id)
);
create function person_private.audit_immutable() returns trigger
language plpgsql set search_path='' as $$begin raise exception 'audit_evidence_immutable';end$$;
revoke all on function person_private.audit_immutable() from public,anon,authenticated;
do $$declare t text;begin
 foreach t in array array['person_audit_anchors','person_audit_operations','person_change_attributions','person_audit_epochs'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select,insert on public.%I to service_role',t);
  execute format('create trigger person_audit_immutable before update or delete on public.%I for each row execute function person_private.audit_immutable()',t);
 end loop;
end$$;

create function person_private.audit_epoch() returns trigger
language plpgsql security definer set search_path='' as $$
declare old_data jsonb; new_data jsonb; old_semantic jsonb; new_semantic jsonb; item jsonb; k text; cid text; did text;
begin
 if tg_op<>'INSERT' then old_data:=to_jsonb(old);end if;
 if tg_op<>'DELETE' then new_data:=to_jsonb(new);end if;
 old_semantic:='{}';new_semantic:='{}';
 foreach k in array string_to_array(tg_argv[0],',') loop
  old_semantic:=old_semantic||jsonb_build_object(k,old_data->k);
  new_semantic:=new_semantic||jsonb_build_object(k,new_data->k);
 end loop;
 -- ready/claimed are operational phases; done/review carry admission meaning.
 if tg_table_name='person_refresh_attempts' then
  old_semantic:=old_semantic||jsonb_build_object('admission',case when old_data->>'phase' in ('done','review') then old_data->>'phase' else 'pending' end);
  new_semantic:=new_semantic||jsonb_build_object('admission',case when new_data->>'phase' in ('done','review') then new_data->>'phase' else 'pending' end);
 end if;
 if tg_op='UPDATE' and old_semantic is not distinct from new_semantic then return null;end if;
 perform pg_advisory_xact_lock_shared(72006,0);
 for item in select x from jsonb_array_elements(jsonb_build_array(old_data,new_data)) x where jsonb_typeof(x)='object' loop
  cid:=item->>'candidate_id';did:=coalesce(item->>'contact_id',item->>'directory_contact_id');
  if cid is not null then
   insert into public.person_audit_epochs(scope_kind,scope_key) values('candidate',cid) on conflict do nothing;
  end if;
  if did is not null then
   insert into public.person_audit_epochs(scope_kind,scope_key) values('directory',did) on conflict do nothing;
  end if;
 end loop;
 return null;
end$$;
revoke all on function person_private.audit_epoch() from public,anon,authenticated;
create trigger person_audit_epoch after insert or update or delete on public.person_application_receipts for each row execute function person_private.audit_epoch('application_id,candidate_id,created_person,documents,application_snapshot,harvest_ledger_id');
create trigger person_audit_epoch after insert or update or delete on public.person_refresh_attempts for each row execute function person_private.audit_epoch('queue_id,candidate_id,organization_id,linkedin_username,linkedin_url,ledger_id,ledger_snapshot,documents,result');
create trigger person_audit_epoch after insert or update or delete on public.person_directory_receipts for each row execute function person_private.audit_epoch('id,workspace_id,contact_id,candidate_id,created_person,snapshot_hash,snapshot,phase,documents,source_reviews,projected,result');
create trigger person_audit_epoch after insert or update or delete on public.person_recruiter_receipts for each row execute function person_private.audit_epoch('id,candidate_id,actor_id,input_hash,edited_at,requested_contact,before_contact,document,mode,result');
create trigger person_audit_epoch after insert or update or delete on public.person_directory_state for each row execute function person_private.audit_epoch('workspace_id,contact_id,latest_receipt_id,applied_receipt_id');
create trigger person_audit_epoch after insert or update or delete on public.person_directory_primary for each row execute function person_private.audit_epoch('candidate_id,kind,directory_contact_id,chosen_value,receipt_id');
create trigger person_audit_epoch after insert or update or delete on public.person_recruiter_primary for each row execute function person_private.audit_epoch('candidate_id,kind,chosen_value,receipt_id');
create trigger person_audit_epoch after insert on public.person_audit_anchors for each row execute function person_private.audit_epoch('candidate_id,kind,anchor_hash');
create trigger person_audit_epoch after insert on public.person_audit_operations for each row execute function person_private.audit_epoch('id,candidate_id,writer,receipt_ref,evidence');
create trigger person_audit_epoch after insert on public.person_change_attributions for each row execute function person_private.audit_epoch('event_id,candidate_id,operation_id,scope,changed_fields,event_hash');

create function person_private.attribute_change(p_event bigint,p_operation uuid,p_scope text) returns void
language plpgsql set search_path='' as $$
declare e public.person_change_events%rowtype; o public.person_audit_operations%rowtype; changed text[]; allowed text[]; expected_writer text;
begin
 select * into e from public.person_change_events where id=p_event;
 select * into o from public.person_audit_operations where id=p_operation;
 if e.id is null or o.id is null or e.candidate_id<>o.candidate_id then raise exception 'audit_event_identity';end if;
 if e.transaction_id is distinct from pg_current_xact_id() or o.transaction_id<>pg_current_xact_id() then raise exception 'audit_event_transaction';end if;
 select coalesce(array_agg(k order by k),'{}') into changed from (
  select jsonb_object_keys(coalesce(e.previous_payload,'{}')) k union select jsonb_object_keys(e.payload)
 ) keys where e.previous_payload->k is distinct from e.payload->k;
 case p_scope
 when 'profile' then allowed:=array['full_name','current_title','current_company','current_company_id','work_experience','education','education_schools','education_degrees','education_fields','top_skills','all_skills_text','previous_companies','headline','profile_summary','location','profile_picture_url','email','phone','updated_at'];
 when 'refresh_metadata' then expected_writer:='refresh';allowed:=array['linkedin_enrichment_date','calculated_experience_years','updated_at'];
 when 'directory_metadata' then expected_writer:='directory';allowed:=array['directory_contact_id','directory_sync_hash','source','status','follow_up_at','linkedin_enrichment_date','calculated_experience_years','updated_at'];
 when 'recruiter_contact' then expected_writer:='recruiter';allowed:=array['contact','updated_at'];
 when 'application_finalize' then expected_writer:='application';allowed:=array['candidate_id','pool_created_person','parsed_profile','updated_at'];
 when 'creation' then
  if o.writer not in ('application','directory') or e.operation<>'INSERT' or e.previous_payload is not null then raise exception 'audit_event_writer';end if;
  -- Only the minimal identity seed is attributable as creation. Nonempty
  -- imported facts must go through a separately captured profile publication.
  if exists(select 1 from jsonb_each(e.payload) x
   where not x.key=any(array['id','full_name','first_name','last_name','linkedin_username','linkedin_url','source','status','created_at','updated_at'])
    and x.value not in ('null'::jsonb,'[]'::jsonb,'{}'::jsonb,'""'::jsonb)
    and not (x.key='embedding_type' and x.value='"unknown"'::jsonb)
    and not (x.key='linkedin_enrichment_status' and x.value='"not_applicable"'::jsonb)
    and not (x.key='open_profile' and x.value='false'::jsonb)
  ) then raise exception 'audit_event_fields';end if;
  allowed:=changed;
 else raise exception 'audit_event_scope';end case;
 if expected_writer is not null and o.writer<>expected_writer then raise exception 'audit_event_writer';end if;
 if p_scope='application_finalize' then
  if e.operation is distinct from 'UPDATE' or e.previous_payload is null then raise exception 'audit_event_scope';end if;
  if e.source_row_id is null or o.receipt_ref is distinct from ('application:'||e.source_row_id) then raise exception 'audit_event_receipt';end if;
  if e.source_table is distinct from 'website_applications' or e.payload->>'organization_id' is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a' or e.payload->>'candidate_id' is distinct from o.candidate_id::text or (e.previous_payload->>'candidate_id' is not null and e.previous_payload->>'candidate_id'<>o.candidate_id::text) then raise exception 'audit_event_identity';end if;
 else
  if e.source_table is distinct from 'candidates' or e.source_row_id is distinct from o.candidate_id::text or e.payload->>'id' is distinct from o.candidate_id::text then raise exception 'audit_event_identity';end if;
  if p_scope<>'creation' and (e.operation<>'UPDATE' or e.previous_payload is null) then raise exception 'audit_event_scope';end if;
 end if;
 if not changed<@allowed then raise exception 'audit_event_fields';end if;
 insert into public.person_change_attributions(event_id,candidate_id,operation_id,scope,changed_fields,event_hash)
 values(e.id,e.candidate_id,o.id,p_scope,changed,md5(jsonb_build_array(e.id,e.candidate_id,e.source_table,e.source_row_id,e.operation,e.transaction_id::text,e.previous_payload,e.payload)::text));
end$$;
revoke all on function person_private.attribute_change(bigint,uuid,text) from public,anon,authenticated;
grant execute on function person_private.attribute_change(bigint,uuid,text) to service_role;
