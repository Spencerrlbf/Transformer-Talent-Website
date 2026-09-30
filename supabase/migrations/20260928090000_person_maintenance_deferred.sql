-- PREPARED ONLY. Held maintenance windows count parked (deferred) application work
-- as resolved, exactly as transition_set does for seal, reopen and disarm.
-- Without this, a deferred application after seal refused the catch-up window.
set local lock_timeout='2s';set local statement_timeout='30s';
do $$declare d text;n text;begin
 d:=pg_get_functiondef('person_private.maintenance_open(text,text,integer,bigint,bigint,text)'::regprocedure);
 n:=' if exists(select 1 from person_private.transition_work where scope=''tt_person'' and status<>''completed'') then raise exception ''transition_unresolved'';end if;';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'maintenance_deferred_definition';end if;
 execute replace(d,n,' if exists(select 1 from person_private.transition_work where scope=''tt_person'' and status not in (''completed'',''deferred'')) then raise exception ''transition_unresolved'';end if;');
end$$;
