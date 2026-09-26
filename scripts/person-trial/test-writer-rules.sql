\set ON_ERROR_STOP 1
begin;
create function pg_temp.doc(cid uuid, src text, at_time text, h text, parser text, title text)
returns jsonb language sql as $$
 select jsonb_build_object('candidate_id',cid,'mode','replace_lists','source',
 jsonb_build_object('source',src,'source_ref','same-input','fetched_at',at_time,'payload_hash',h,'parser_version',parser,'raw_in','inline'),
 'identities','[]'::jsonb,'contacts','[]'::jsonb,'header',jsonb_build_object('current_title',title))
$$;
do $$
declare cid uuid := gen_random_uuid(); d jsonb; newer jsonb; r jsonb; jid uuid;
begin
 insert into candidates(id,linkedin_username,full_name) values(cid,cid::text,'Synthetic Rules Test');
 d := pg_temp.doc(cid,'directory','2026-09-20T00:00:00Z','a','person-v3','Staff Engineer');
 perform save_person(d);
 assert (select header->'current_title'->>'value' from candidate_profile_state where candidate_id=cid)='Staff Engineer', 'directory title with no list is saved';
 perform save_person(pg_temp.doc(cid,'legacy_import','2025-01-01T00:00:00Z','z','person-v3','Engineer'));
 assert (select header->'current_title'->>'value' from candidate_profile_state where candidate_id=cid)='Staff Engineer', 'older header cannot overwrite';
 perform save_person(pg_temp.doc(cid,'directory','2026-09-21T00:00:00Z','blank','person-v3',''));
 assert (select header->'current_title'->>'value' from candidate_profile_state where candidate_id=cid)='Staff Engineer', 'empty header cannot blank';
 perform save_person(pg_temp.doc(cid,'recruiter','2026-01-01T00:00:00Z','manual','person-v3','Principal Engineer'));
 perform save_person(pg_temp.doc(cid,'harvest','2026-09-22T00:00:00Z','harvest','person-v3','Engineer'));
 assert (select header->'current_title'->>'value' from candidate_profile_state where candidate_id=cid)='Principal Engineer', 'recruiter priority is preserved';
 perform save_person(pg_temp.doc(cid,'recruiter','2025-01-01T00:00:00Z','old-manual','person-v3','Old Manual'));
 assert (select header->'current_title'->>'value' from candidate_profile_state where candidate_id=cid)='Principal Engineer', 'older manual arrival cannot reverse a newer manual edit';
 raise notice 'PASS title, blank, freshness and recruiter precedence';
end $$;
do $$
declare cid uuid := gen_random_uuid(); d jsonb; newer jsonb; jid uuid;
begin
 insert into candidates(id,linkedin_username,full_name) values(cid,cid::text,'Synthetic Replay Test');
 d := pg_temp.doc(cid,'legacy_import','2025-01-01T00:00:00Z','z','person-v2','Old Title') ||
 jsonb_build_object('jobs',jsonb_build_array(jsonb_build_object('row_key','original','title','Engineer','company',jsonb_build_object('name','Replay Example','linkedin_username','replay-example','identity','u:replay-example','normalized_name','replay example'),'start_year',2020,'start_month',1,'is_current',true,'sort_order',0)));
 perform save_person(d);
 select id into jid from candidate_experiences where candidate_id=cid and source='person';
 newer := jsonb_set(jsonb_set(jsonb_set(d,'{source,payload_hash}','"a"'),'{source,parser_version}','"person-v3"'),'{header,current_title}','"Corrected Title"');
 newer := jsonb_set(newer,'{jobs,0,row_key}','"enriched-key"');
 newer := jsonb_set(newer,'{jobs,0,company,linkedin_id}','"55500001"');
 newer := jsonb_set(newer,'{jobs,0,company,identity}','"li:55500001"');
 perform save_person(newer);
 assert (select header->'current_title'->>'value' from candidate_profile_state where candidate_id=cid)='Corrected Title', 'new parser replays same original source date';
 assert (select id from candidate_experiences where candidate_id=cid and source='person' and removed_at is null)=jid, 'unambiguous company identity enrichment keeps job id';
 assert (select row_key from candidate_experiences where id=jid)='enriched-key', 'job adopts corrected identity key';
 assert (select s.parser_version from candidate_sources s join candidate_profile_state ps on ps.lists_source_id=s.id where ps.candidate_id=cid)='person-v3', 'overall list owner follows the corrected parser';
 assert (save_person(newer)->>'status')='unchanged', 'exact replay is a no-op';
 perform save_person(jsonb_set(d,'{source,payload_hash}','"zz"'));
 assert (select header->'current_title'->>'value' from candidate_profile_state where candidate_id=cid)='Corrected Title', 'older parser cannot retake equal-date source';
 assert (select count(*) from candidate_experiences where candidate_id=cid and source='person' and removed_at is null)=1, 'no duplicate active job';
 raise notice 'PASS version-aware replay and stable company/job identity';
end $$;
do $$
declare c1 uuid := gen_random_uuid(); c2 uuid := gen_random_uuid(); d1 jsonb; d2 jsonb;
begin
 insert into candidates(id,linkedin_username,full_name) values(c1,c1::text,'Synthetic Order A'),(c2,c2::text,'Synthetic Order B');
 d1:=pg_temp.doc(c1,'directory','2026-01-01T00:00:00Z','a','person-v3','Title A');
 d2:=pg_temp.doc(c1,'directory','2026-01-01T00:00:00Z','z','person-v3','Title Z');
 perform save_person(d1);perform save_person(d2);
 perform save_person(jsonb_set(d2,'{candidate_id}',to_jsonb(c2)));perform save_person(jsonb_set(d1,'{candidate_id}',to_jsonb(c2)));
 assert (select header->'current_title'->>'value' from candidate_profile_state where candidate_id=c1)='Title Z', 'equal dates use deterministic hash tie-break';
 assert (select header->'current_title'->>'value' from candidate_profile_state where candidate_id=c2)='Title Z', 'reverse arrival has same result';
 raise notice 'PASS equal-date arrival order';
end $$;
do $$
declare cid uuid := gen_random_uuid(); d jsonb;
begin
 insert into candidates(id,linkedin_username,full_name) values(cid,cid::text,'Synthetic Contact Test');
 d:=pg_temp.doc(cid,'recruiter','2026-01-01T00:00:00Z','bad-manual','person-v3','Engineer') || jsonb_build_object('contacts',jsonb_build_array(jsonb_build_object('kind','email','value_normalized','invalid@example.com','is_manual',true,'status','active','quality','bad','result','invalid')));
 perform save_person(d);
 assert (select rank is null and status='invalid' from candidate_contacts where candidate_id=cid), 'manual choice never promotes known invalid email';
 perform save_person(jsonb_set(jsonb_set(d,'{source,payload_hash}','"manual-no-check"'),'{contacts,0}', '{"kind":"email","value_normalized":"invalid@example.com","is_manual":true,"status":"active"}'));
 assert (select rank is null and status='invalid' from candidate_contacts where candidate_id=cid), 'manual edit without new verification cannot revive invalid address';
 raise notice 'PASS invalid manual contact is retained but not ranked';
end $$;
rollback;
