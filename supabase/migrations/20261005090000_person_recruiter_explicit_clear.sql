-- Explicit recruiter clears survive publication.
--
-- person_recruiter_primary held one NULL: "the recruiter chose no value". The 2026-09-26
-- ranking read that NULL as "withdraw the manual preference and use the ordinary
-- eligible fallback" (so a published person showed the best historical address
-- again), while the unpublished reads treat it as a clear (review R2-03). Both
-- meanings are now stored apart:
--
--   absent row                       no decision: the automatic ranking applies
--   chosen_value NULL, suppressed    explicit clear: that kind has no primary until the
--                                    recruiter chooses again, published or not
--   chosen_value NULL, not suppressed automatic: the ranking applies (historical rows)
--   chosen_value set                 that address/phone leads
--
-- A suppressed kind receives no rank at all, so every consumer of ranks (published
-- drawer and lists, the live save's own result, Send's canonical contact, the
-- post-cutover audit's expected ranks) sees nothing for it; nothing is deleted from
-- candidate_contacts or the verification tables.
--
-- Existing rows: every NULL written so far came from a recruiter saving an empty
-- field, but in live mode the save then showed the recruiter the fallback address,
-- so whether they meant "clear" or accepted the fallback cannot be established from
-- the data. They are left as `suppressed=false` (their behaviour is unchanged) and
-- listed by the query at the end for the owner's review. New recruiter saves write
-- `suppressed=true` for a cleared kind; a resume fill re-writing an existing row
-- preserves the row's flag; a save that explicitly asks for automatic selection
-- (`requested_contact.automatic`, library-level) writes `suppressed=false`.
--
-- Additive: one column, one constraint, the ranking function's eligibility, and the
-- certified writer's target/validation patched in place (same technique as
-- 20260928061000). No applied version is edited.
alter table public.person_recruiter_primary add column if not exists suppressed boolean not null default false;
do $$begin
 if not exists(select 1 from pg_constraint where conname='person_recruiter_primary_suppressed_null' and conrelid='public.person_recruiter_primary'::regclass) then
  alter table public.person_recruiter_primary add constraint person_recruiter_primary_suppressed_null check (chosen_value is null or not suppressed);
 end if;
end$$;

-- Ranking: a suppressed kind is ineligible for a rank. Otherwise identical to 20260926065300.
create or replace function public.person_contact_ranks(p_candidate uuid)
returns table (id uuid, new_rank bigint) language sql stable set search_path = '' as $$
 select x.id, case when x.eligible then row_number() over (partition by x.kind, x.eligible order by
  x.tier,x.manual_at desc nulls last,x.personal desc,x.legacy_primary desc,x.verified_at desc nulls last,
  x.first_seen_at nulls last,x.value_normalized) end as new_rank
 from (
  select cc.id,cc.kind,cc.value_normalized,cc.verified_at,cc.first_seen_at,cc.legacy_primary,
   (cc.status='active' and not cc.never_primary and (cc.kind<>'email' or public.tt_email_check_class(cc.quality,cc.result)<>'bad')
    and not coalesce(rp.suppressed,false)) as eligible,
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

-- The flag a certified write stores for one kind. Resolved through a helper so the
-- patched writer body stays valid on a database without the resume-fill tables.
create or replace function person_private.recruiter_primary_suppressed(p_id uuid,p_kind text,p_value jsonb,p_prior jsonb,p_requested jsonb) returns boolean
language plpgsql stable set search_path='' as $$
declare fill boolean:=false;
begin
 if p_value is not null and p_value<>'null'::jsonb then return false;end if;
 -- A resume fill re-writes the existing decision unchanged.
 if to_regclass('person_private.resume_contact_fills') is not null then
  execute 'select exists(select 1 from person_private.resume_contact_fills where id=$1)' into fill using p_id;
 end if;
 if fill then return coalesce((p_prior->>'suppressed')::boolean,false);end if;
 -- A recruiter save asking for automatic selection of this kind withdraws the preference.
 if p_requested->'automatic' ? p_kind then return false;end if;
 return true;
end$$;
revoke all on function person_private.recruiter_primary_suppressed(uuid,text,jsonb,jsonb,jsonb) from public,anon,authenticated;

-- Certified writer (where installed): the target row carries the flag, because
-- recruiter_write compares the returned row with the target column for column, and
-- the validation checks it. Patched in place like 20260928061000 does.
do $$declare d text;n text;r text;begin
 if to_regprocedure('person_private.recruiter_normalize(uuid)') is not null then
  d:=pg_get_functiondef('person_private.recruiter_normalize(uuid)'::regprocedure);
  if position('recruiter_primary_suppressed' in d)=0 then
   n:='target:=jsonb_build_object(''candidate_id'',s.candidate_id,''kind'',item.key,''chosen_value'',item.value,''receipt_id'',s.id);';
   if position(n in d)=0 then raise exception 'explicit_clear_definition:recruiter_normalize';end if;
   r:='target:=jsonb_build_object(''candidate_id'',s.candidate_id,''kind'',item.key,''chosen_value'',item.value,''receipt_id'',s.id,''suppressed'',person_private.recruiter_primary_suppressed(p_id,item.key,item.value,prior,s.requested_contact));';
   execute replace(d,n,r);
  end if;
 end if;
 if to_regprocedure('person_private.recruiter_write(uuid,text,jsonb,jsonb)') is not null then
  d:=pg_get_functiondef('person_private.recruiter_write(uuid,text,jsonb,jsonb)'::regprocedure);
  if position('jsonb_typeof(p_after->''suppressed'')' in d)=0 then
   n:='or p_after->''chosen_value'' is distinct from s.choices->(p_after->>''kind'') then raise exception ''recruiter_write_scope'';end if;';
   if position(n in d)=0 then raise exception 'explicit_clear_definition:recruiter_write';end if;
   r:='or p_after->''chosen_value'' is distinct from s.choices->(p_after->>''kind'') or jsonb_typeof(p_after->''suppressed'') is distinct from ''boolean'' or (p_after->''chosen_value''<>''null''::jsonb and (p_after->>''suppressed'')::boolean) then raise exception ''recruiter_write_scope'';end if;';
   execute replace(d,n,r);
  end if;
 end if;
end$$;

-- Historical NULL decisions (owner review; see RELEASE_REMEDIATION.md). Reported only.
do $$declare n int;begin
 select count(*) into n from public.person_recruiter_primary where chosen_value is null and not suppressed;
 raise notice 'person_recruiter_explicit_clear: % historical NULL decision row(s) left as automatic (not suppressed)', n;
end$$;
