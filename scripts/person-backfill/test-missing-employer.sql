\set ON_ERROR_STOP 1
begin;
do $$
declare cid uuid:=gen_random_uuid(); d jsonb;
begin
 insert into candidates(id,linkedin_username,full_name) values(cid,cid::text,'Synthetic Missing Employer');
 d:=jsonb_build_object('candidate_id',cid,'mode','replace_lists','source',jsonb_build_object('source','legacy_import','source_ref',cid,'fetched_at','2025-01-01T00:00:00Z','payload_hash','unknown-job','parser_version','person-v3','raw_in','inline'),'jobs','[{"row_key":"unknown-job","title":"Engineer","company":{"name":"Unknown employer","normalized_name":"unknown employer","identity":"n:unknown employer","is_placeholder":true},"start_year":2020}]'::jsonb);
 perform save_person(d);
 perform person_backfill_flag_missing_employers(cid);
 perform person_backfill_flag_missing_employers(cid);
 assert (select count(*) from candidate_experiences where candidate_id=cid and removed_at is null)=1,'job retained';
 assert exists(select 1 from candidate_experiences e join companies c on c.id=e.company_id where e.candidate_id=cid and c.is_placeholder and c.linkedin_id is null),'job linked only to explicit placeholder';
 assert (select count(*) from identity_conflicts where kind='missing_employer' and cid=any(candidate_ids))=1,'missing employer flagged once';
 assert not has_function_privilege('anon','public.person_backfill_flag_missing_employers(uuid)','EXECUTE'),'review writer restricted';
 raise notice 'PASS missing employer keeps job and creates idempotent review item';
end $$;
rollback;
