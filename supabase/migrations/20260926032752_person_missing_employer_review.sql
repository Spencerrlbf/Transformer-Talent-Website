-- Preserve a titled source job with no employer without inventing an identity.
-- Called only after the backfill's source and stored-row checks pass.
set local lock_timeout='2s';
set local statement_timeout='30s';
create function public.person_backfill_flag_missing_employers(p_candidate uuid)
returns integer language plpgsql set search_path='' as $$
declare n integer;
begin
 insert into public.identity_conflicts(kind,candidate_ids,incoming,evidence_hash,source_id)
 select 'missing_employer',array[p_candidate],jsonb_build_object('job_id',e.id,'row_key',e.row_key,'reason','source_has_no_employer_identity'),
  md5('missing-employer|'||p_candidate::text||'|'||e.row_key),e.source_id
 from public.candidate_experiences e join public.companies c on c.id=e.company_id
 where e.candidate_id=p_candidate and e.source='person' and e.removed_at is null
   and c.is_placeholder and c.normalized_name='unknown employer'
 on conflict(kind,evidence_hash) where status='open' do nothing;
 get diagnostics n=row_count;
 return n;
end $$;
revoke all on function public.person_backfill_flag_missing_employers(uuid) from public,anon,authenticated;
grant execute on function public.person_backfill_flag_missing_employers(uuid) to service_role;
