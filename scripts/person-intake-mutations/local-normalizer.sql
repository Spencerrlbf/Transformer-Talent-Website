-- Synthetic loopback fixture: reproduce the existing live candidate trigger.
create function public.normalize_linkedin_username() returns trigger language plpgsql as $$
begin
 if new.linkedin_username is null then raise exception 'linkedin_username cannot be NULL';end if;
 new.linkedin_username:=lower(btrim(new.linkedin_username));
 if btrim(new.linkedin_username)='' then raise exception 'linkedin_username cannot be blank';end if;
 return new;
end$$;
create trigger trg_normalize_linkedin_username before insert or update on public.candidates for each row execute function public.normalize_linkedin_username();
