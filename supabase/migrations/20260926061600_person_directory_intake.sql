-- Prepared for the approved application cutover, not the shadow bulk copy.
-- Website-only receipts; the communications database remains read-only.
set local lock_timeout='3s';
create table public.person_directory_scans (
 workspace_id uuid primary key,
 cursor uuid not null default '00000000-0000-0000-0000-000000000000',
 cycle bigint not null default 1,
 token uuid,
 lease_until timestamptz,
 updated_at timestamptz not null default clock_timestamp()
);
create table public.person_directory_receipts (
 id bigint generated always as identity primary key,
 workspace_id uuid not null references public.person_directory_scans(workspace_id),
 contact_id uuid not null,
 snapshot_hash text not null,
 snapshot jsonb not null,
 captured_at timestamptz not null default clock_timestamp(),
 candidate_id uuid references public.candidates(id) on delete restrict,
 created_person boolean not null default false,
 phase text not null default 'ready' check(phase in ('ready','done','suppressed','review','superseded')),
 documents jsonb,
 source_reviews jsonb not null default '[]',
 result jsonb,
 projected boolean not null default false,
 derivatives_claimed_at timestamptz,
 derivative_text text,
 derivative_revision bigint,
 derivative_token uuid,
 derivative_lease_until timestamptz,
 derivative_attempts int not null default 0,
 derivative_done boolean not null default false,
 derivative_error text,
 attempts int not null default 0,
 error_code text,
 updated_at timestamptz not null default clock_timestamp()
);
create index person_directory_receipts_candidate_idx on public.person_directory_receipts(candidate_id,id);
create index person_directory_receipts_ready_idx on public.person_directory_receipts(workspace_id,id) where phase='ready';
create index person_directory_receipts_derivative_idx on public.person_directory_receipts(workspace_id,id) where projected and derivative_text is not null and not derivative_done and derivative_attempts<3;
create table public.person_directory_state (
 contact_id uuid primary key,
 workspace_id uuid not null references public.person_directory_scans(workspace_id),
 latest_receipt_id bigint not null references public.person_directory_receipts(id),
 applied_receipt_id bigint references public.person_directory_receipts(id),
 seen_cycle bigint not null
);
-- The current directory choice is an observed snapshot decision. It does
-- not renew a contact verification date or a LinkedIn profile fetch date.
create table public.person_directory_primary (
 candidate_id uuid not null references public.candidates(id) on delete restrict,
 kind text not null check(kind in ('email','phone')),
 directory_contact_id uuid not null,
 chosen_value text,
 receipt_id bigint not null references public.person_directory_receipts(id),
 primary key(candidate_id,kind)
);
do $$ declare t text; begin
 foreach t in array array['person_directory_scans','person_directory_receipts','person_directory_state','person_directory_primary'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
revoke all on sequence public.person_directory_receipts_id_seq from public,anon,authenticated;
grant usage,select on sequence public.person_directory_receipts_id_seq to service_role;

create or replace function public.person_contact_ranks(p_candidate uuid)
returns table (id uuid, new_rank bigint) language sql stable set search_path = '' as $$
 select x.id, case when x.eligible then row_number() over (partition by x.kind, x.eligible order by
  x.tier,x.manual_at desc nulls last,x.personal desc,x.legacy_primary desc,x.verified_at desc nulls last,
  x.first_seen_at nulls last,x.value_normalized) end as new_rank
 from (
  select cc.id,cc.kind,cc.value_normalized,cc.verified_at,cc.first_seen_at,cc.legacy_primary,
   (cc.status='active' and not cc.never_primary and (cc.kind<>'email' or public.tt_email_check_class(cc.quality,cc.result)<>'bad')) as eligible,
   case when cc.is_manual then coalesce(cc.manual_at,cc.first_seen_at) end as manual_at,
   cc.label='personal' as personal,
   case when cc.is_manual then 0
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
  where cc.candidate_id=p_candidate
 ) x
$$;
