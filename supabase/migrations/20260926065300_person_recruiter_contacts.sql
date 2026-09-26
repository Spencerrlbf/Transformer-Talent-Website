-- Prepared for the approved application cutover; no profile rewrite.
set local lock_timeout='3s';
create table public.person_recruiter_receipts (
 id uuid primary key,
 candidate_id uuid not null references public.candidates(id) on delete restrict,
 actor_id uuid not null,
 input_hash text not null,
 edited_at timestamptz not null,
 requested_contact jsonb not null,
 before_contact jsonb,
 effective_contact jsonb,
 document jsonb not null,
 mode text not null check(mode in ('shadow','live')),
 result jsonb
);
create index person_recruiter_receipts_candidate_idx on public.person_recruiter_receipts(candidate_id,edited_at);
-- Absent row uses historical manual ranks. Explicit null withdraws that
-- preference, using the ordinary eligible directory/verified fallback.
create table public.person_recruiter_primary (
 candidate_id uuid not null references public.candidates(id) on delete restrict,
 kind text not null check(kind in ('email','phone')),
 chosen_value text,
 receipt_id uuid not null references public.person_recruiter_receipts(id),
 primary key(candidate_id,kind)
);
alter table public.person_recruiter_receipts enable row level security;
alter table public.person_recruiter_primary enable row level security;
revoke all on public.person_recruiter_receipts,public.person_recruiter_primary from public,anon,authenticated;
grant all on public.person_recruiter_receipts,public.person_recruiter_primary to service_role;

create or replace function public.person_contact_ranks(p_candidate uuid)
returns table (id uuid, new_rank bigint) language sql stable set search_path = '' as $$
 select x.id, case when x.eligible then row_number() over (partition by x.kind, x.eligible order by
  x.tier,x.manual_at desc nulls last,x.personal desc,x.legacy_primary desc,x.verified_at desc nulls last,
  x.first_seen_at nulls last,x.value_normalized) end as new_rank
 from (
  select cc.id,cc.kind,cc.value_normalized,cc.verified_at,cc.first_seen_at,cc.legacy_primary,
   (cc.status='active' and not cc.never_primary and (cc.kind<>'email' or public.tt_email_check_class(cc.quality,cc.result)<>'bad')) as eligible,
   case when (rp.candidate_id is null and cc.is_manual) or rp.chosen_value=cc.value_normalized then coalesce(cc.manual_at,cc.first_seen_at) end as manual_at,
   cc.label='personal' as personal,
   case when (rp.candidate_id is null and cc.is_manual) or rp.chosen_value=cc.value_normalized then 0
    when cc.kind='email' then case
     when (dp.candidate_id is not null and dp.chosen_value=cc.value_normalized)
       or (dp.candidate_id is null and cc.source_detail='directory_primary') then 1
     when public.tt_email_check_class(cc.quality,cc.result)='good' and cc.label='personal' then 2
     when public.tt_email_check_class(cc.quality,cc.result)='good' and cc.label='business' then 3
     when public.tt_email_check_class(cc.quality,cc.result)='good' then 4
     when public.tt_email_check_class(cc.quality,cc.result)='risky' then 5 else 6 end
    when cc.kind='phone' then case when cc.source='directory' or cc.source_detail like 'directory%' then 1 when cc.label='mobile' then 2 else 3 end
    else 1 end as tier
  from public.candidate_contacts cc
  left join public.person_directory_primary dp on dp.candidate_id=cc.candidate_id and dp.kind=cc.kind
  left join public.person_recruiter_primary rp on rp.candidate_id=cc.candidate_id and rp.kind=cc.kind
  where cc.candidate_id=p_candidate
 ) x
$$;
