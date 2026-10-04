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
test('forward files are the only new versions and sort after the chain',()=>{
 const files=fs.readdirSync(dir).filter(f=>/^2026\d{10}_/.test(f)).sort();
 const last=files.at(-1);
 assert.deepEqual(files.filter(f=>f>'20260928090000_person_maintenance_deferred.sql'),[
  '20261003090000_person_target_identity.sql',
  '20261003100000_person_forward_application_contact.sql',
  '20261003110000_person_forward_network_send.sql',
  '20261003120000_person_forward_identity_index.sql',
  '20261005090000_person_recruiter_explicit_clear.sql',
 ]);
 assert.equal(last,'20261005090000_person_recruiter_explicit_clear.sql');
});
