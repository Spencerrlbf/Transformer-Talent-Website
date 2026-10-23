-- One scalar JSON result: PostgREST max-rows cannot truncate decision evidence.
create or replace function public.person_catchup_contact_snapshot(p_candidate_ids uuid[])
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare contact_rows bigint; snapshot_bytes bigint;
begin
 if p_candidate_ids is null or cardinality(p_candidate_ids)>500
 or exists(select 1 from unnest(p_candidate_ids) x where x is null)
 or cardinality(p_candidate_ids)<>(select count(distinct x) from unnest(p_candidate_ids) x) then
  raise exception 'invalid contact snapshot ids';
 end if;
 -- Count and size individual rows before constructing aggregate JSON; never truncate.
 select count(*),coalesce(sum(octet_length(to_jsonb(c)::text)),0) into contact_rows,snapshot_bytes
 from (select * from public.candidate_contacts where candidate_id=any(p_candidate_ids) limit 10001) c;
 if contact_rows>10000 then raise exception 'contact_snapshot_capacity';end if;
 select snapshot_bytes+coalesce(sum(bytes),0) into snapshot_bytes from (
  select octet_length(to_jsonb(d)::text) bytes from public.person_recruiter_primary d where d.candidate_id=any(p_candidate_ids)
  union all select octet_length(to_jsonb(s)::text) from public.candidate_contact_summary s where s.candidate_id=any(p_candidate_ids)
  union all select octet_length(to_jsonb(s)::text) from public.candidate_profile_state s where s.candidate_id=any(p_candidate_ids)
 ) sized;
 -- Leave room for JSON container punctuation and the fixed identity/count envelope.
 if snapshot_bytes+16*(contact_rows+4*cardinality(p_candidate_ids))+cardinality(p_candidate_ids)*1024>8388608 then raise exception 'contact_snapshot_capacity';end if;
 return (
  select jsonb_build_object(
   'candidate_ids',to_jsonb(p_candidate_ids),
   'row_counts',(select coalesce(jsonb_agg(jsonb_build_object('candidate_id',requested.cid,'contacts',(select count(*) from public.candidate_contacts c where c.candidate_id=requested.cid),'decisions',(select count(*) from public.person_recruiter_primary d where d.candidate_id=requested.cid)) order by requested.cid),'[]'::jsonb) from unnest(p_candidate_ids) requested(cid)),
   'contacts',coalesce((select jsonb_agg(to_jsonb(c) order by c.candidate_id,c.kind,c.value_normalized) from public.candidate_contacts c where c.candidate_id=any(p_candidate_ids)),'[]'::jsonb),
   'decisions',coalesce((select jsonb_agg(to_jsonb(d) order by d.candidate_id,d.kind) from public.person_recruiter_primary d where d.candidate_id=any(p_candidate_ids)),'[]'::jsonb),
   'contact_summary',(select coalesce(jsonb_agg(coalesce(to_jsonb(s),case when not exists(select 1 from public.candidate_contacts c where c.candidate_id=requested.cid) then jsonb_build_object('candidate_id',requested.cid,'primary_email',null,'primary_phone',null,'secondary_email',null,'secondary_phone',null,'usable_emails','[]'::jsonb) end) order by requested.cid),'[]'::jsonb) from unnest(p_candidate_ids) requested(cid) left join public.candidate_contact_summary s on s.candidate_id=requested.cid),
   'profile_state',coalesce((select jsonb_agg(to_jsonb(s) order by s.candidate_id) from public.candidate_profile_state s where s.candidate_id=any(p_candidate_ids)),'[]'::jsonb)
  )
 );
end;
$$;
revoke all on function public.person_catchup_contact_snapshot(uuid[]) from public, anon, authenticated;
grant execute on function public.person_catchup_contact_snapshot(uuid[]) to service_role;
