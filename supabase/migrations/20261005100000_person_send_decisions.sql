-- Checked Send honours explicit recruiter decisions for an unpublished person.
--
-- person_network_send (20260928070000, forward body 20261003110000) recomputes an
-- unpublished person's contact itself before admitting the caller's snapshot: the
-- overlay, then the scalar, then the verified history. Since 20261005090000 the
-- callers resolve a cleared kind to nothing and a chosen value first, so after a
-- clear the TypeScript snapshot (blank email, null phone) disagreed with the RPC's
-- historical address and every Send answered `contact_changed`. The unpublished
-- branch now applies the same decision semantics; the locked stale-snapshot
-- comparison, the published branch, the witness and the insertion are unchanged.
-- Patched in place from the installed definition (same technique as 20261003110000);
-- a clean install and an upgraded install converge (catalog parity test).
do $$declare d text;n text;r text;begin
 d:=pg_get_functiondef('public.person_network_send(jsonb,text)'::regprocedure);
 if position('dec_email' in d)>0 then raise notice 'person_send_decisions: already applied';return;end if;
 n:=' else
  email_value:=nullif(trim(coalesce(cand.contact->>''email'',cand.email)),'''');
  phone_value:=coalesce(nullif(trim(cand.contact->>''phone''),''''),nullif(trim(cand.phone),''''));
  if email_value is null then
   select trim(e.email) into email_value from (
    select email_address::text email,email_type,is_primary,quality,result from public.candidate_emails where candidate_id=cid
    union all select email_normalized::text,email_type,is_primary,quality,result from public.candidate_emails_v2 where candidate_id=cid
   ) e where nullif(trim(e.email),'''') is not null and e.quality is distinct from ''bad'' and e.result is distinct from ''invalid''
   order by (case when e.quality=''good'' and e.result=''ok'' then 0 else 10 end)+(case when e.email_type=''personal'' then 0 else 2 end)+(case when e.is_primary then 0 else 1 end),lower(trim(e.email)) collate "C",trim(e.email) collate "C" limit 1;
  end if;
';
 if position(n in d)=0 then raise exception 'send_decisions_definition:anchor';end if;
 r:=' else
  -- Explicit recruiter decisions (20261005090000): a cleared kind has no contact, a
  -- chosen one leads; otherwise the overlay, the scalar, then the verified history.
  declare dec_email jsonb; dec_phone jsonb; begin
   select to_jsonb(d) into dec_email from public.person_recruiter_primary d where d.candidate_id=cid and d.kind=''email'';
   select to_jsonb(d) into dec_phone from public.person_recruiter_primary d where d.candidate_id=cid and d.kind=''phone'';
   if dec_email is not null and dec_email->>''chosen_value'' is null and coalesce((dec_email->>''suppressed'')::boolean,false) then email_value:=null;
   else
    email_value:=nullif(trim(coalesce(cand.contact->>''email'',cand.email)),'''');
    if email_value is null and dec_email->>''chosen_value'' is not null then email_value:=dec_email->>''chosen_value'';end if;
    if email_value is null then
     select trim(e.email) into email_value from (
      select email_address::text email,email_type,is_primary,quality,result from public.candidate_emails where candidate_id=cid
      union all select email_normalized::text,email_type,is_primary,quality,result from public.candidate_emails_v2 where candidate_id=cid
     ) e where nullif(trim(e.email),'''') is not null and e.quality is distinct from ''bad'' and e.result is distinct from ''invalid''
     order by (case when e.quality=''good'' and e.result=''ok'' then 0 else 10 end)+(case when e.email_type=''personal'' then 0 else 2 end)+(case when e.is_primary then 0 else 1 end),lower(trim(e.email)) collate "C",trim(e.email) collate "C" limit 1;
    end if;
   end if;
   if dec_phone is not null and dec_phone->>''chosen_value'' is null and coalesce((dec_phone->>''suppressed'')::boolean,false) then phone_value:=null;
   else
    phone_value:=coalesce(nullif(trim(cand.contact->>''phone''),''''),nullif(trim(cand.phone),''''));
    if phone_value is null and dec_phone->>''chosen_value'' is not null then phone_value:=dec_phone->>''chosen_value'';end if;
   end if;
  end;
';
 execute replace(d,n,r);
end$$;
