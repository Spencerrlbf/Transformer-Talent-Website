-- Forward for databases that installed 20260926042200_person_reconcile.sql: a cheaper
-- plan for the _v2 external fingerprint the reconciliation records at both scan
-- boundaries (release rehearsal 2026-10-14). The chain's definition serialized every
-- candidate_emails_v2 row to JSON, MD5-hashed each text and sorted the digests: 6.8 s on
-- 283,732 rows, which the REST gateway's 8-second statement budget stopped once at the
-- catch-up start. Same scope (every _v2 row of an existing candidate), same result shape
-- {rows, hash}; the hash is now the MD5 of the row count and the xor of the rows' 64-bit
-- record hashes (hash_record_extended covers every column, including raw_response), which
-- changes whenever any row changes: 1.2 s on the same rows. Signature and grants unchanged
-- (create or replace keeps the chain's revoke/grant); a reconciliation run compares only
-- the start and end values it computed itself, so earlier recorded hashes stay valid history.
set local lock_timeout='2s';set local statement_timeout='30s';
create or replace function public.person_reconcile_v2_fingerprint()
returns jsonb language sql stable parallel safe set search_path='' as $$
 select jsonb_build_object('rows',count(*),'hash',md5(count(*)::text||':'||coalesce(bit_xor(hash_record_extended(e,0))::text,'')))
 from public.candidate_emails_v2 e where exists(select 1 from public.candidates c where c.id=e.candidate_id);
$$;
