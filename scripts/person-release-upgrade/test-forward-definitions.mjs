// Static: the forward migrations carry exactly the chain's definitions, so a
// clean install and an upgrade converge on the same function bodies. Offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const dir=fileURLToPath(new URL('../../supabase/migrations/',import.meta.url));
const read=(f)=>fs.readFileSync(dir+f,'utf8');
const block=(src,start)=>{const i=src.indexOf(start);assert.ok(i>=0,start);const j=src.indexOf('\nend$$;',i);return src.slice(i,j+'\nend$$;'.length);};
test('contact fill: forward body equals chain body',()=>{
 const chain=block(read('20260928060000_person_application_contact.sql'),'create function public.person_application_contact_fill(');
 const forward=block(read('20261003100000_person_forward_application_contact.sql'),'create or replace function public.person_application_contact_fill(');
 assert.equal(forward.replace('create or replace function','create function'),chain);
 assert.match(chain,/\( ext \[0-9\]\{1,6\}\)\?\$/); // the extension the release accepts
});
test('network send: forward body equals chain body and removes the one-argument signature',()=>{
 const chain=block(read('20260928070000_person_network_send.sql'),'create function public.person_network_send(');
 const forwardFile=read('20261003110000_person_forward_network_send.sql');
 const forward=block(forwardFile,'create or replace function public.person_network_send(');
 assert.equal(forward.replace('create or replace function','create function'),chain);
 assert.match(chain,/p_mode text default 'live'/);
 assert.match(forwardFile,/drop function if exists public\.person_network_send\(jsonb\);/);
 // Snapshot export fragment: forward `n` equals what the chain appends.
 const appended=/execute replace\(d,n,n\|\|E'((?:[^']|'')*)'\);\nend\$\$;/.exec(read('20260928070000_person_network_send.sql').split("''application_receipts''")[1]);
 const stmt=appended[1].slice(appended[1].indexOf("result:=result||jsonb_build_object(''application_sends''"));
 const forwardN=/ n:=E'((?:[^']|'')*)';/.exec(forwardFile)[1];
 assert.equal(forwardN,stmt);
 assert.match(stmt,/inserted_row/);assert.match(stmt,/insert_event/);assert.match(stmt,/snapshot_size_limit/);
});
test('identity index: forward validation equals the chain preflight predicate',()=>{
 const chain=read('20260927170000_person_directory_outcomes.sql');
 const forward=read('20261003120000_person_forward_identity_index.sql');
 const predicate=(s)=>s.slice(s.indexOf('select 1 from pg_index'),s.indexOf("raise exception 'candidate identity index is not ready'"));
 assert.equal(predicate(forward),predicate(chain));
 // Only comments mention CREATE INDEX: the executable part never builds one.
 assert.doesNotMatch(forward.split('\n').filter(l=>!l.startsWith('--')).join('\n'),/create index/i);
});
test('target label: the identity function keeps its grants and the label is operator-written only',()=>{
 const label=read('20261013090000_person_target_label.sql');
 const code=label.split('\n').filter(l=>!l.startsWith('--')).join('\n');
 assert.match(code,/revoke all on function public\.person_target_identity\(\) from public,anon,authenticated;\ngrant execute on function public\.person_target_identity\(\) to service_role;/);
 assert.match(code,/revoke all on person_private\.target_identity from public,anon,authenticated,service_role;/);
 assert.match(code,/revoke all on function person_private\.target_label\(text\) from public,anon,authenticated,service_role;/);
 assert.match(code,/before update or delete or truncate/);
 // The migration never inserts a label itself: no literal ref, no current_setting, no inference.
 assert.doesNotMatch(code,/insert into person_private\.target_identity\(project_ref\) values\('/);
 assert.doesNotMatch(code,/current_setting\('app\./);
 assert.doesNotMatch(code,/[a-z]{20}\.supabase/);
});
test('reconcile page: the forward keeps the signature, grants and the non-queue query; the queue scope gathers ids once',()=>{
 const chain=read('20260926042200_person_reconcile.sql'), forward=read('20261013100000_person_reconcile_page_plan.sql');
 assert.match(forward,/create or replace function public\.person_reconcile_page\(p_run text,p_size integer\)\nreturns jsonb language plpgsql stable set search_path='' as \$\$/);
 assert.doesNotMatch(forward.split('\n').filter(l=>!l.startsWith('--')).join('\n'),/grant|revoke/i,'grants untouched');
 // the validation and the non-queue scopes are verbatim from the chain
 for(const frag of ["if r.status<>'running' or r.notes->>'kind'<>'reconcile' or p_size not between 1 and 500 or p_size>(r.notes->>'batch')::integer then raise exception 'Invalid reconciliation page';end if;",
  "coalesce(q.version,(select max(e.id) from public.person_change_events e where e.candidate_id=c.id),0) captured_version","and (r.notes->>'scope'<>'directory' or c.directory_contact_id is not null)"])assert.ok(chain.includes(frag)&&forward.includes(frag),frag.slice(0,40));
 assert.match(forward,/with ids as materialized/);assert.match(forward,/not p\.counted/);assert.match(forward,/limit n\n/);
});
test('forward files are the only new versions and sort after the chain',()=>{
 const files=fs.readdirSync(dir).filter(f=>/^2026\d{10}_/.test(f)).sort();
 const last=files.at(-1);
 assert.deepEqual(files.filter(f=>f>'20260928090000_person_maintenance_deferred.sql'),[
  '20261003090000_person_target_identity.sql',
  '20261003100000_person_forward_application_contact.sql',
  '20261003110000_person_forward_network_send.sql',
  '20261003120000_person_forward_identity_index.sql',
  '20261005090000_person_recruiter_explicit_clear.sql',
  '20261005100000_person_send_decisions.sql',
  '20261005110000_person_historical_shadow_clears.sql',
  '20261005120000_person_catchup_contact_snapshot.sql',
  '20261013090000_person_target_label.sql',
  '20261013100000_person_reconcile_page_plan.sql',
 ]);
 assert.equal(last,'20261013100000_person_reconcile_page_plan.sql');
});
