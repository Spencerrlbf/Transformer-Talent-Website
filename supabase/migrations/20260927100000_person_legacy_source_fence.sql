-- PREPARED ONLY. Website legacy source boundary; no external project changes.
-- Depends on 090000. Existing statement gates acquire controller locks first.
set local lock_timeout='2s';set local statement_timeout='30s';
create function person_private.legacy_communication_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if person_private.normalization_required() then raise exception 'legacy_communication_fence';end if;
 return coalesce(new,old);
end$$;
create trigger person_legacy_communication_before before insert or update or delete on public.candidate_communications for each row execute function person_private.legacy_communication_guard();
create trigger person_legacy_communication_after after insert or update or delete on public.candidate_communications for each row execute function person_private.legacy_communication_guard();
create trigger person_legacy_communication_truncate before truncate on public.candidate_communications for each statement execute function person_private.audit_proof_no_truncate();
revoke truncate on public.candidate_communications from public,anon,authenticated,service_role;

create function person_private.legacy_experience_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if not person_private.normalization_required() then return coalesce(new,old);end if;
 if (tg_op<>'INSERT' and old.source is distinct from 'person') or (tg_op<>'DELETE' and new.source is distinct from 'person') then raise exception 'legacy_experience_fence';end if;
 if (tg_op<>'INSERT' and old.organization_id is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a'::uuid) or (tg_op<>'DELETE' and new.organization_id is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a'::uuid) then raise exception 'legacy_experience_scope';end if;
 -- Source IDs legitimately advance on replacement; removed jobs retain their
 -- earlier source. The existing normalization row check proves candidate scope.
 return coalesce(new,old);
end$$;
create trigger person_legacy_experience_before before insert or update or delete on public.candidate_experiences for each row execute function person_private.legacy_experience_guard();
create trigger person_legacy_experience_after after insert or update or delete on public.candidate_experiences for each row execute function person_private.legacy_experience_guard();
create trigger person_normalization_row_after after insert or update or delete on public.candidate_experiences for each row execute function person_private.normalization_row();
revoke all on function person_private.legacy_communication_guard(),person_private.legacy_experience_guard() from public,anon,authenticated,service_role;
