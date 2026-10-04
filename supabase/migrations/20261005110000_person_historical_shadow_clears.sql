-- Follow 20261005090000 without changing an installed migration. Publication
-- history is not evidence of the mode of the current recruiter decision: a
-- published person may subsequently have a completed shadow clear.
-- Use the receipt referenced by the CURRENT decision, not any older receipt.
-- Preserve all receipts, projection state, legacy fields and later choices.
do $$
declare
 affected uuid[];
 trigger_states jsonb;
 t record;
 restored bigint := 0;
begin
 -- Keep classification/reranking atomic with respect to concurrent saves, and
 -- preserve the exact original trigger modes, including intentionally disabled
 -- or replica/always triggers. Refuse an in-flight save rather than forming a
 -- lock-order cycle with it. Apply only after the operator's migration drain;
 -- a refusal/failure rolls this entire block back and can be retried when idle.
 lock table public.person_recruiter_primary, public.candidate_contacts in access exclusive mode nowait;
 select array_agg(distinct rp.candidate_id) into affected
 from public.person_recruiter_primary rp
 join public.person_recruiter_receipts r on r.id=rp.receipt_id and r.candidate_id=rp.candidate_id
 where rp.chosen_value is null and not rp.suppressed and r.mode='shadow'
  and r.result is not null and r.result<>'null'::jsonb
  and r.requested_contact->rp.kind='null'::jsonb
  and r.effective_contact->rp.kind='null'::jsonb
  and not coalesce(r.requested_contact->'automatic' ? rp.kind,false);
 if affected is null then
  raise notice 'person_historical_shadow_clears: restored=0';
  return;
 end if;
 select jsonb_agg(jsonb_build_object('relation',tgrelid::regclass::text,'name',tgname,'mode',tgenabled))
 into trigger_states from pg_trigger
 where tgrelid in ('public.person_recruiter_primary'::regclass,'public.candidate_contacts'::regclass) and not tgisinternal;
 for t in select * from jsonb_to_recordset(trigger_states) as x(relation text,name text,mode text) loop
  execute format('alter table %s disable trigger %I',t.relation,t.name);
 end loop;
 update public.person_recruiter_primary rp set suppressed=true
 from public.person_recruiter_receipts r
 where rp.candidate_id=any(affected) and r.id=rp.receipt_id and r.candidate_id=rp.candidate_id
  and rp.chosen_value is null and not rp.suppressed and r.mode='shadow'
  and r.result is not null and r.result<>'null'::jsonb
  and r.requested_contact->rp.kind='null'::jsonb
  and r.effective_contact->rp.kind='null'::jsonb
  and not coalesce(r.requested_contact->'automatic' ? rp.kind,false);
 get diagnostics restored=row_count;
 update public.candidate_contacts cc set rank=r.new_rank
 from (select x.id,x.new_rank from unnest(affected) p(candidate_id)
       cross join lateral public.person_contact_ranks(p.candidate_id) x) r
 where cc.id=r.id and cc.rank is distinct from r.new_rank;
 for t in select * from jsonb_to_recordset(trigger_states) as x(relation text,name text,mode text) loop
  execute format('alter table %s %s trigger %I',t.relation,
   case t.mode when 'D' then 'disable' when 'R' then 'enable replica' when 'A' then 'enable always' else 'enable' end,t.name);
 end loop;
 raise notice 'person_historical_shadow_clears: restored=%',restored;
end $$;
