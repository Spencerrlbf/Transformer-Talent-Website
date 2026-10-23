-- PREPARED ONLY. TT first-intake proof; workflow/tenant completion follows.
set local lock_timeout='2s';set local statement_timeout='30s';
create table person_private.application_intake_stages(
 operation_id uuid not null references person_private.application_audit_operations(operation_id),
 kind text not null check(kind in ('projection','metadata','finalize','preferences')),
 work_id uuid not null references person_private.application_work(work_id),candidate_id uuid not null,
 transaction_id xid8 not null,receipt_hash text not null,payload jsonb not null,
 primary key(operation_id,kind)
);
create table person_private.application_intake_ready(
 work_id uuid primary key references person_private.application_work(work_id),
 application_id uuid not null unique references public.website_applications(id),candidate_id uuid not null,
 operation_id uuid not null references person_private.application_audit_operations(operation_id),
 transaction_id xid8 not null,receipt_hash text not null,write_mode text not null check(write_mode in ('live','shadow')),
 revision bigint not null,projection_disposition text not null check(projection_disposition in ('checked','shadow_existing')),
 preference_disposition text not null check(preference_disposition in ('applied','superseded','not_applicable')),
 ready_at timestamptz not null default clock_timestamp()
);
alter table person_private.application_intake_stages enable row level security;
alter table person_private.application_intake_ready enable row level security;
revoke all on person_private.application_intake_stages,person_private.application_intake_ready from public,anon,authenticated,service_role;

create function person_private.intake_hash(p_value jsonb) returns text language sql immutable set search_path='' as $$select encode(sha256(convert_to(p_value::text,'UTF8')),'hex')$$;
create function person_private.intake_final_fields(p_row jsonb) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('candidate_id',p_row->'candidate_id','pool_created_person',p_row->'pool_created_person','parsed_profile',p_row->'parsed_profile','resume_text',p_row->'resume_text','name',p_row->'name','contact',p_row->'contact')
$$;
create function person_private.intake_preference_fields(p_row jsonb) returns jsonb language sql immutable set search_path='' as $$select jsonb_build_array(p_row->'follow_up_at',p_row->'role_preferences',p_row->'visa_status')$$;
create function person_private.intake_stage_record(p_operation uuid,p_kind text,p_payload jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare ctx jsonb;stage person_private.application_intake_stages;
begin
 ctx:=person_private.intake_mutation_context(p_operation);
 if not (ctx->>'first')::boolean then raise exception 'intake_stage_history';end if;
 insert into person_private.application_intake_stages values(p_operation,p_kind,(ctx->>'work_id')::uuid,(ctx->>'candidate_id')::uuid,pg_current_xact_id(),person_private.intake_hash(ctx->'receipt'),p_payload) on conflict do nothing;
 select * into strict stage from person_private.application_intake_stages where operation_id=p_operation and kind=p_kind;
 if stage.work_id<>(ctx->>'work_id')::uuid or stage.candidate_id<>(ctx->>'candidate_id')::uuid or stage.transaction_id<>pg_current_xact_id() or stage.receipt_hash<>person_private.intake_hash(ctx->'receipt') or stage.payload<>p_payload then raise exception 'intake_stage_replay';end if;
end$$;

-- Validate retained proof by immutable private references, never today's mutable
-- candidate/preferences or whichever intent happens to be newest now.
create function person_private.intake_ready_proof(p person_private.application_intake_ready,ctx jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare b person_private.application_candidates;s person_private.application_intake_stages;m person_private.intake_metadata_witnesses;pref jsonb;own_intent person_private.application_intents;newer person_private.application_intents;expected_scope text;e public.person_change_events;attribution public.person_change_attributions;decision person_private.application_preference_decisions;
begin
 select * into b from person_private.application_candidates where work_id=(ctx->>'work_id')::uuid;
 if p.work_id is null or p.work_id<>b.work_id or p.application_id<>b.application_id or p.candidate_id<>b.candidate_id or p.transaction_id<>b.transaction_id or p.receipt_hash<>person_private.intake_hash(ctx->'receipt') or not exists(select 1 from person_private.application_audit_operations where operation_id=p.operation_id and work_id=p.work_id and candidate_id=p.candidate_id and transaction_id=p.transaction_id) then raise exception 'intake_ready_scope';end if;
 for expected_scope in select unnest(array['metadata','finalize','preferences']) loop
  select * into s from person_private.application_intake_stages where operation_id=p.operation_id and kind=expected_scope;
  if s.operation_id is null or s.work_id<>p.work_id or s.candidate_id<>p.candidate_id or s.transaction_id<>p.transaction_id or s.receipt_hash<>p.receipt_hash then raise exception 'intake_ready_stage';end if;
 end loop;
 select * into m from person_private.intake_metadata_witnesses where operation_id=p.operation_id;
 select * into s from person_private.application_intake_stages where operation_id=p.operation_id and kind='metadata';
 if m.operation_id is null or m.work_id<>p.work_id or m.candidate_id<>p.candidate_id or m.receipt_hash<>p.receipt_hash or s.payload->>'mode' is distinct from p.write_mode or s.payload->>'metadata_hash' is distinct from m.after_metadata_hash then raise exception 'intake_ready_metadata';end if;
 if p.projection_disposition='checked' then
  select * into s from person_private.application_intake_stages where operation_id=p.operation_id and kind='projection';
  if s.operation_id is null or s.work_id<>p.work_id or s.candidate_id<>p.candidate_id or s.transaction_id<>p.transaction_id or s.receipt_hash<>p.receipt_hash or (s.payload->>'revision')::bigint is distinct from p.revision then raise exception 'intake_ready_projection';end if;
 elsif p.write_mode<>'shadow' or b.created_person then raise exception 'intake_ready_projection';end if;
 select payload into pref from person_private.application_intake_stages where operation_id=p.operation_id and kind='preferences';
 if pref->>'disposition' is distinct from p.preference_disposition then raise exception 'intake_ready_preferences';end if;
 if p.preference_disposition='not_applicable' then
  if ctx->'receipt'->'application_snapshot'->>'source'='future' then raise exception 'intake_ready_preferences';end if;
 else
  select * into own_intent from person_private.application_intents where application_id=p.application_id;
  if own_intent.application_id is null or pref->>'intent_order' is distinct from own_intent.intent_order::text or pref->>'input_hash' is distinct from person_private.intake_hash(own_intent.input_snapshot) then raise exception 'intake_ready_preferences';end if;
  if p.preference_disposition='superseded' then
   select * into newer from person_private.application_intents where application_id=(pref->>'newer_application_id')::uuid;
   if newer.application_id is null or newer.organization_id<>own_intent.organization_id or newer.linkedin_username<>own_intent.linkedin_username or newer.intent_order<=own_intent.intent_order or newer.intent_order::text is distinct from pref->>'newer_order' or (pref->>'observed_order')::bigint<=newer.intent_order then raise exception 'intake_ready_preferences';end if;
  end if;
 end if;
 for s in select * from person_private.application_intake_stages where operation_id=p.operation_id and (kind='finalize' or (kind='preferences' and p.preference_disposition='applied')) loop
  select * into e from public.person_change_events where id=(s.payload->>'event_id')::bigint;
  select * into attribution from public.person_change_attributions where event_id=e.id;
  if e.id is null or e.transaction_id<>p.transaction_id or e.candidate_id<>p.candidate_id or e.operation<>'UPDATE' or e.source_table<>(case when s.kind='finalize' then 'website_applications' else 'candidates' end) or e.source_row_id<>(case when s.kind='finalize' then p.application_id::text else p.candidate_id::text end) or attribution.operation_id is distinct from p.operation_id or attribution.scope is distinct from 'application_'||s.kind or attribution.event_hash is distinct from s.payload->>'event_hash' or attribution.event_hash is distinct from md5(jsonb_build_array(e.id,e.candidate_id,e.source_table,e.source_row_id,e.operation,e.transaction_id::text,e.previous_payload,e.payload)::text) then raise exception 'intake_ready_event';end if;
  if s.kind='preferences' then
   select * into decision from person_private.application_preference_decisions where event_id=e.id;
   if decision.event_id is null or decision.application_id<>p.application_id or decision.candidate_id<>p.candidate_id or decision.event_hash<>attribution.event_hash or decision.decision_order::text is distinct from s.payload->>'decision_order' then raise exception 'intake_ready_preferences';end if;
  end if;
 end loop;
end$$;
create function person_private.intake_ready_replay(ctx jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare ready person_private.application_intake_ready;
begin
 select * into ready from person_private.application_intake_ready where work_id=(ctx->>'work_id')::uuid;
 if found then perform person_private.intake_ready_proof(ready,ctx);return true;end if;
 if not (ctx->>'first')::boolean then raise exception 'intake_ready_history';end if;
 return false;
end$$;

-- Private cores preserve the reviewed mutation implementation. Public wrappers
-- add checked stage evidence; no service caller can skip directly to a core.
alter function public.person_application_project(uuid,bigint,jsonb) set schema person_private;
alter function person_private.person_application_project(uuid,bigint,jsonb) rename to intake_project_core;
alter function public.person_application_candidate_details(uuid,text,jsonb,text) set schema person_private;
alter function person_private.person_application_candidate_details(uuid,text,jsonb,text) rename to intake_details_core;
alter function public.person_application_finalize(uuid) set schema person_private;
alter function person_private.person_application_finalize(uuid) rename to intake_finalize_core;
alter function public.person_application_preferences(uuid) set schema person_private;
alter function person_private.person_application_preferences(uuid) rename to intake_preferences_core;
revoke all on function person_private.intake_project_core(uuid,bigint,jsonb),person_private.intake_details_core(uuid,text,jsonb,text),person_private.intake_finalize_core(uuid),person_private.intake_preferences_core(uuid) from public,anon,authenticated,service_role;

create function public.person_application_project(p_operation uuid,p_revision bigint,p_envelope jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb;replay boolean;result jsonb;c jsonb;s public.person_projection_state;
begin
 ctx:=person_private.intake_mutation_context(p_operation);replay:=person_private.intake_ready_replay(ctx);
 result:=person_private.intake_project_core(p_operation,p_revision,p_envelope);
 if not replay then
  select to_jsonb(x) into strict c from public.candidates x where id=(ctx->>'candidate_id')::uuid;
  select * into strict s from public.person_projection_state where candidate_id=(ctx->>'candidate_id')::uuid;
  perform person_private.intake_stage_record(p_operation,'projection',jsonb_build_object('revision',s.revision::text,'profile_hash',s.profile_hash,'row_hash',person_private.intake_hash(person_private.projection_profile(c))));
 end if;
 return result;
end$$;
create function public.person_application_candidate_details(p_operation uuid,p_mode text,p_vector jsonb default null,p_text_hash text default null) returns void language plpgsql security definer set search_path='' as $$
declare ctx jsonb;m person_private.intake_metadata_witnesses;
begin
 ctx:=person_private.intake_mutation_context(p_operation);if person_private.intake_ready_replay(ctx) then return;end if;
 perform person_private.intake_details_core(p_operation,p_mode,p_vector,p_text_hash);
 select * into strict m from person_private.intake_metadata_witnesses where operation_id=p_operation;
 perform person_private.intake_stage_record(p_operation,'metadata',jsonb_build_object('mode',p_mode,'metadata_hash',m.after_metadata_hash));
end$$;
create function public.person_application_finalize(p_operation uuid) returns void language plpgsql security definer set search_path='' as $$
declare ctx jsonb;s person_private.application_intake_stages;app jsonb;attribution public.person_change_attributions;
begin
 ctx:=person_private.intake_mutation_context(p_operation);if person_private.intake_ready_replay(ctx) then return;end if;
 select * into s from person_private.application_intake_stages where operation_id=p_operation and kind='finalize';
 if found then
  select to_jsonb(x) into strict app from public.website_applications x where id=(ctx->>'application_id')::uuid;
  if s.payload->>'row_hash' is distinct from person_private.intake_hash(person_private.intake_final_fields(app)) then raise exception 'intake_stage_replay';end if;return;
 end if;
 perform person_private.intake_finalize_core(p_operation);
 select * into strict attribution from public.person_change_attributions where operation_id=p_operation and scope='application_finalize' order by event_id desc limit 1;
 select to_jsonb(x) into strict app from public.website_applications x where id=(ctx->>'application_id')::uuid;
 perform person_private.intake_stage_record(p_operation,'finalize',jsonb_build_object('event_id',attribution.event_id::text,'event_hash',attribution.event_hash,'row_hash',person_private.intake_hash(person_private.intake_final_fields(app))));
end$$;
create function public.person_application_preferences(p_operation uuid) returns void language plpgsql security definer set search_path='' as $$
declare ctx jsonb;snapshot jsonb;own_intent person_private.application_intents;newer person_private.application_intents;key text;payload jsonb;stage person_private.application_intake_stages;attribution public.person_change_attributions;decision person_private.application_preference_decisions;c jsonb;
begin
 ctx:=person_private.intake_mutation_context(p_operation);if person_private.intake_ready_replay(ctx) then return;end if;snapshot:=ctx->'receipt'->'application_snapshot';
 select * into stage from person_private.application_intake_stages where operation_id=p_operation and kind='preferences';
 if found then
  if stage.payload->>'disposition'='applied' then
   select to_jsonb(x) into strict c from public.candidates x where id=(ctx->>'candidate_id')::uuid;
   if stage.payload->>'row_hash' is distinct from person_private.intake_hash(person_private.intake_preference_fields(c)) then raise exception 'intake_stage_replay';end if;
  end if;return;
 end if;
 if snapshot->>'source' is distinct from 'future' then
  perform person_private.intake_stage_record(p_operation,'preferences',jsonb_build_object('disposition','not_applicable'));return;
 end if;
 select * into own_intent from person_private.application_intents where application_id=(ctx->>'application_id')::uuid;
 if own_intent.application_id is null or nullif(snapshot->>'person_intent_hash','') is null or nullif(snapshot->>'follow_up_at','') is null then raise exception 'intake_preference_input';end if;
 foreach key in array array['organization_id','linkedin_username','person_intent_hash','source','follow_up_at','preferred_roles','preferred_locations','preferred_workplace','comp_expectation','visa_status'] loop
  if own_intent.input_snapshot->key is distinct from snapshot->key then raise exception 'intake_preference_input';end if;
 end loop;
 payload:=jsonb_build_object('intent_order',own_intent.intent_order::text,'input_hash',person_private.intake_hash(own_intent.input_snapshot));
 select * into newer from person_private.application_intents where organization_id=own_intent.organization_id and linkedin_username=own_intent.linkedin_username and intent_order>own_intent.intent_order order by intent_order desc limit 1;
 if found then
  perform person_private.intake_stage_record(p_operation,'preferences',payload||jsonb_build_object('disposition','superseded','newer_application_id',newer.application_id,'newer_order',newer.intent_order::text,'observed_order',nextval('person_private.application_intent_order')::text));return;
 end if;
 if not person_private.application_preference_witness((ctx->>'application_id')::uuid,snapshot) then raise exception 'intake_preference_input';end if;
 perform person_private.intake_preferences_core(p_operation);
 select * into strict attribution from public.person_change_attributions where operation_id=p_operation and scope='application_preferences' order by event_id desc limit 1;
 select * into strict decision from person_private.application_preference_decisions where event_id=attribution.event_id;
 select to_jsonb(x) into strict c from public.candidates x where id=(ctx->>'candidate_id')::uuid;
 perform person_private.intake_stage_record(p_operation,'preferences',payload||jsonb_build_object('disposition','applied','event_id',attribution.event_id::text,'event_hash',attribution.event_hash,'decision_order',decision.decision_order::text,'row_hash',person_private.intake_hash(person_private.intake_preference_fields(c))));
end$$;

create function public.person_application_intake_ready(p_operation uuid) returns void language plpgsql security definer set search_path='' as $$
declare ctx jsonb;ready person_private.application_intake_ready;m jsonb;projected jsonb;finalized jsonb;pref jsonb;c jsonb;app jsonb;revision bigint;state public.person_projection_state;
begin
 ctx:=person_private.intake_mutation_context(p_operation);if person_private.intake_ready_replay(ctx) then return;end if;
 select payload into m from person_private.application_intake_stages where operation_id=p_operation and kind='metadata';
 select payload into projected from person_private.application_intake_stages where operation_id=p_operation and kind='projection';
 select payload into finalized from person_private.application_intake_stages where operation_id=p_operation and kind='finalize';
 select payload into pref from person_private.application_intake_stages where operation_id=p_operation and kind='preferences';
 if m is null or finalized is null or pref is null then raise exception 'intake_ready_stage';end if;
 select rev into strict revision from public.candidate_profile_state where candidate_id=(ctx->>'candidate_id')::uuid;
 select to_jsonb(x) into strict c from public.candidates x where id=(ctx->>'candidate_id')::uuid;
 select to_jsonb(x) into strict app from public.website_applications x where id=(ctx->>'application_id')::uuid;
 if m->>'metadata_hash' is distinct from person_private.intake_metadata_hash(c) or finalized->>'row_hash' is distinct from person_private.intake_hash(person_private.intake_final_fields(app)) or (pref->>'disposition'='applied' and pref->>'row_hash' is distinct from person_private.intake_hash(person_private.intake_preference_fields(c))) then raise exception 'intake_ready_actual';end if;
 ready.work_id:=(ctx->>'work_id')::uuid;ready.application_id:=(ctx->>'application_id')::uuid;ready.candidate_id:=(ctx->>'candidate_id')::uuid;ready.operation_id:=p_operation;ready.transaction_id:=pg_current_xact_id();ready.receipt_hash:=person_private.intake_hash(ctx->'receipt');ready.write_mode:=m->>'mode';ready.revision:=revision;ready.preference_disposition:=pref->>'disposition';ready.ready_at:=clock_timestamp();
 if ready.write_mode='live' or (ctx->>'created')::boolean then
  select * into state from public.person_projection_state where candidate_id=ready.candidate_id;
  if projected is null or (projected->>'revision')::bigint is distinct from revision or state.revision is distinct from revision or projected->>'profile_hash' is distinct from state.profile_hash or projected->>'row_hash' is distinct from person_private.intake_hash(person_private.projection_profile(c)) then raise exception 'intake_ready_projection';end if;
  ready.projection_disposition:='checked';
 else ready.projection_disposition:='shadow_existing';end if;
 perform person_private.intake_ready_proof(ready,ctx);
 insert into person_private.application_intake_ready select ready.*;
 perform person_private.application_context();
end$$;
-- Preserve the existing exact receipt/source checks and add readiness at commit.
do $$declare body text;needle text:=' return null;';begin
 body:=pg_get_functiondef('person_private.application_binding_complete()'::regprocedure);
 if array_length(string_to_array(body,needle),1)<>2 then raise exception 'intake_binding_definition';end if;
 body:=replace(body,needle,' if not exists(select 1 from person_private.application_intake_ready where work_id=new.work_id and application_id=new.application_id and candidate_id=new.candidate_id and transaction_id=new.transaction_id) then raise exception ''intake_ready_required'';end if;'||chr(10)||' perform person_private.intake_ready_proof(x,person_private.intake_mutation_context(x.operation_id)) from person_private.application_intake_ready x where x.work_id=new.work_id;'||chr(10)||needle);
 execute body;
end$$;
revoke all on function person_private.intake_hash(jsonb),person_private.intake_final_fields(jsonb),person_private.intake_preference_fields(jsonb),person_private.intake_stage_record(uuid,text,jsonb),person_private.intake_ready_proof(person_private.application_intake_ready,jsonb),person_private.intake_ready_replay(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.person_application_project(uuid,bigint,jsonb),public.person_application_candidate_details(uuid,text,jsonb,text),public.person_application_finalize(uuid),public.person_application_preferences(uuid),public.person_application_intake_ready(uuid) from public,anon,authenticated,service_role;
grant execute on function public.person_application_project(uuid,bigint,jsonb),public.person_application_candidate_details(uuid,text,jsonb,text),public.person_application_finalize(uuid),public.person_application_preferences(uuid),public.person_application_intake_ready(uuid) to service_role;
