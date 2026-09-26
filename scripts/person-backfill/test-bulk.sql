\set ON_ERROR_STOP 1
begin;
do $$
declare a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); d jsonb; items jsonb; result jsonb; got boolean:=false; checks jsonb;
begin
 insert into candidates(id,linkedin_username,full_name) values(a,a::text,'Synthetic Bulk A'),(b,b::text,'Synthetic Bulk B');
 perform person_backfill_start('test-bulk','test-commit','person-v3',10,2,false);
 d:=jsonb_build_object('candidate_id',a,'mode','contacts_only','source',jsonb_build_object('source','legacy_import','source_ref','synthetic','fetched_at','2025-01-01T00:00:00Z','payload_hash','bulk-a','parser_version','person-v3','raw_in','inline'),'contacts','[]'::jsonb);
 items:=jsonb_build_array(jsonb_build_object('candidate_id',a,'docs',jsonb_build_array(d),'version',0),jsonb_build_object('candidate_id',b,'docs',jsonb_build_array(d),'version',0));
 begin perform person_backfill_save_many('test-bulk',items); exception when others then got:=true; end;
 assert got, 'invalid second person rejected';
 assert not exists(select 1 from candidate_sources where candidate_id in(a,b)), 'whole failed mini-batch rolled back';
 items:=jsonb_set(items,'{1,docs,0,candidate_id}',to_jsonb(b));
 result:=person_backfill_save_many('test-bulk',items);
 assert jsonb_array_length(result)=2, 'result per input candidate';
 assert result->0->>'candidate_id'=a::text and result->1->>'candidate_id'=b::text, 'input order retained';
 assert (select processed=0 from backfill_runs where run_id='test-bulk'), 'bulk save does not checkpoint';
 perform person_backfill_save_many('test-bulk',items);
 assert (select count(*) from candidate_sources where candidate_id in(a,b))=2, 'retry is idempotent';
 checks:=jsonb_build_array(jsonb_build_object('candidate_id',a,'revision',result->0->'revision','version',0,'checks','{}'::jsonb),jsonb_build_object('candidate_id',b,'revision',999,'version',0,'checks','{}'::jsonb));
 got:=false;
 begin perform person_backfill_audit_many('test-bulk',checks); exception when others then got:=true; end;
 assert got, 'bad final revision rejects audit';
 assert not exists(select 1 from person_backfill_people where run_id='test-bulk' and status<>'saved'), 'no partial audit after failure';
 checks:=jsonb_set(checks,'{1,revision}',result->1->'revision');
 perform person_backfill_audit_many('test-bulk',checks);
 perform person_backfill_checkpoint('test-bulk',jsonb_build_array(a,b));
 assert (select processed=2 from backfill_runs where run_id='test-bulk'), 'every verified person counted exactly once';
 assert not has_function_privilege('anon','person_backfill_save_many(text,jsonb)','execute');
 assert not has_function_privilege('authenticated','person_backfill_audit_many(text,jsonb)','execute');
 raise notice 'PASS bulk rollback, ordered results, idempotency, audit revision, checkpoint and service-only access';
end $$;
rollback;
