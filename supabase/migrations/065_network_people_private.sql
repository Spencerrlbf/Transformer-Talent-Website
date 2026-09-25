-- network_people (Phase 4, 062) is called only by the server with the service
-- key. Like the other matching functions, it is not callable with the public
-- or a signed-in user's key. (RLS already returned nothing to those keys; this
-- stops relying on it.)
revoke execute on function public.network_people(uuid, text, text, text, text, integer, integer, integer) from public, anon, authenticated;
