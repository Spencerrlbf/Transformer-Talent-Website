\set ON_ERROR_STOP 1
begin;
do $$
declare cid uuid:=gen_random_uuid(); v1 bigint; v2 bigint; original_at timestamptz;
begin
 insert into candidates(id,linkedin_username,full_name) values(cid,cid::text,'Synthetic Capture');
 select version into v1 from person_change_queue where candidate_id=cid;
 assert v1 is not null, 'new candidate is captured';
 select updated_at into original_at from candidates where id=cid;
 update candidates set current_title='Changed Without Timestamp' where id=cid;
 select version into v2 from person_change_queue where candidate_id=cid;
 assert v2>v1, 'update without updated_at is captured';
 assert (select updated_at=original_at from candidates where id=cid), 'fixture omitted timestamp update';
 assert (select count(*) from person_change_events where candidate_id=cid)=2, 'durable event evidence retained';
 assert exists(select 1 from person_change_events where candidate_id=cid and payload->>'current_title'='Changed Without Timestamp'), 'changed profile evidence retained';
 insert into candidate_emails(candidate_id,email_address) values(cid,'captured@example.com');
 assert (select version>v2 from person_change_queue where candidate_id=cid), 'contact-only save captured';
 v1:=(select count(*) from person_change_events where candidate_id=cid);
 insert into website_applications(candidate_id,organization_id,name,email) values(cid,gen_random_uuid(),'Synthetic Tenant','tenant@example.com');
 assert (select count(*) from person_change_events where candidate_id=cid)=v1, 'tenant application never copied into pool evidence';
 insert into website_applications(candidate_id,organization_id,name,email) values(cid,'801865a7-6533-41d2-9c45-e4a90e6ad51a','Synthetic TT','tt@example.com');
 assert (select count(*) from person_change_events where candidate_id=cid)=v1+1, 'TT application captured';
 assert not has_table_privilege('anon','public.person_change_events','SELECT'), 'anonymous users cannot read change evidence';
 assert not has_function_privilege('authenticated','public.person_backfill_save(text,uuid,jsonb,bigint)','EXECUTE'), 'authenticated cannot run migration';
 raise notice 'PASS capture, evidence and privileges';
end $$;
do $$
declare cid uuid:=gen_random_uuid(); d jsonb; rev1 bigint; qv bigint; got boolean:=false;
begin
 insert into candidates(id,linkedin_username,full_name) values(cid,cid::text,'Synthetic Atomic Backfill');
 perform person_backfill_start('test-atomic','test-commit','person-v3',10,2,false);
 select version into qv from person_change_queue where candidate_id=cid;
 d:=jsonb_build_object('candidate_id',cid,'mode','contacts_only','source',jsonb_build_object('source','legacy_import','source_ref','synthetic','fetched_at','2025-01-01T00:00:00Z','payload_hash','h1','parser_version','person-v3','raw_in','inline'),'contacts','[]'::jsonb);
 begin
  perform person_backfill_save('test-atomic',cid,jsonb_build_array(d,jsonb_set(d,'{candidate_id}','"not-a-uuid"')),qv);
 exception when others then got:=true;
 end;
 assert got, 'injected document failure observed';
 assert not exists(select 1 from candidate_sources where candidate_id=cid), 'failed person transaction rolls back all source documents';
 perform person_backfill_save('test-atomic',cid,jsonb_build_array(d),qv);
 select rev into rev1 from candidate_profile_state where candidate_id=cid;
 -- Simulate interruption after commit, before audit/checkpoint.
 perform person_backfill_save('test-atomic',cid,jsonb_build_array(d),qv);
 assert (select rev=rev1 from candidate_profile_state where candidate_id=cid), 'restart after save does not mutate normalized state';
 assert (select processed=0 from backfill_runs where run_id='test-atomic'), 'save alone never advances checkpoint';
 update candidates set current_company='Arrived During Backfill' where id=cid;
 perform person_backfill_audit('test-atomic',cid,rev1,qv,'{}'::jsonb);
 assert exists(select 1 from person_change_queue where candidate_id=cid and version>qv), 'new concurrent change cannot be acknowledged by an old read';
 perform person_backfill_checkpoint('test-atomic',to_jsonb(array[cid]));
 perform person_backfill_checkpoint('test-atomic',to_jsonb(array[cid]));
 assert (select processed=1 from backfill_runs where run_id='test-atomic'), 'checkpoint restart never double-counts';
 raise notice 'PASS atomic person save, killed/restarted run and concurrent intake';
end $$;
do $$
declare cid uuid:=gen_random_uuid(); aid uuid:=gen_random_uuid(); tenant uuid:=gen_random_uuid(); n bigint;
begin
 insert into candidates(id,linkedin_username,full_name) values(cid,cid::text,'Synthetic Transition');
 insert into website_applications(id,candidate_id,organization_id,name,email) values(aid,cid,tenant,'CLIENT_PRIVATE_MARKER','private@example.com');
 update website_applications set organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a',name='Synthetic TT Transition',email='tt-transition@example.com' where id=aid;
 assert not exists(select 1 from person_change_events where candidate_id=cid and previous_payload->>'name'='CLIENT_PRIVATE_MARKER'), 'previous tenant input never copied into TT evidence';
 select count(*) into n from person_change_events where candidate_id=cid;
 update website_applications set organization_id=tenant,name='CLIENT_NEW_MARKER' where id=aid;
 assert (select count(*) from person_change_events where candidate_id=cid)=n+1, 'TT source removal captured';
 assert not exists(select 1 from person_change_events where candidate_id=cid and payload->>'name'='CLIENT_NEW_MARKER'), 'new tenant input never copied into TT evidence';
 raise notice 'PASS organization transitions retain only TT evidence';
end $$;
rollback;
