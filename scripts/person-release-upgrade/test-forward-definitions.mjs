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
test('v2 fingerprint: the forward keeps the signature and grants, hashes every row with the record hash and stays within the REST budget by plan',()=>{
 const chain=read('20260926042200_person_reconcile.sql'), forward=read('20261014120000_person_reconcile_v2_fingerprint_plan.sql');
 assert.match(chain,/create function public\.person_reconcile_v2_fingerprint\(\)\nreturns jsonb/);
 assert.match(forward,/create or replace function public\.person_reconcile_v2_fingerprint\(\)\nreturns jsonb language sql stable parallel safe set search_path='' as \$\$/);
 assert.doesNotMatch(forward.split('\n').filter(l=>!l.startsWith('--')).join('\n'),/grant|revoke|drop/i,'grants untouched, nothing dropped');
 // same scope as the chain: _v2 rows of existing candidates; same result keys
 for(const frag of ["from public.candidate_emails_v2 e where exists(select 1 from public.candidates c where c.id=e.candidate_id)","jsonb_build_object('rows',count(*),'hash'"])assert.ok(chain.includes(frag)&&forward.includes(frag),frag);
 assert.match(forward,/bit_xor\(hash_record_extended\(e,0\)\)/);
 assert.doesNotMatch(forward,/string_agg|order by/,'no per-row serialization or sort');
});
test('publish capture attribution: the forward keeps the signature, grants and every check of the chain, and adds only the post-projection step',()=>{
 const chain=read('20260928050000_person_publish_admission.sql'), forward=read('20261015120000_person_publish_capture_attribution.sql');
 const sig=/create (or replace )?function public\.person_publish_project\(p_run text,p_candidate uuid,p_revision bigint,p_envelope jsonb\) returns jsonb\nlanguage plpgsql security definer set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as \$\$/;
 assert.match(chain,sig);assert.match(forward,sig);
 assert.doesNotMatch(forward.split('\n').filter(l=>!l.startsWith('--')).join('\n'),/grant|revoke|drop/i,'grants untouched, nothing dropped');
 for(const frag of ["if current_setting('transaction_isolation')<>'read committed' then raise exception 'publish_isolation';end if;","opened:=person_private.maintenance_enter('publish',p_run);","if not exists(select 1 from public.person_publish_runs where run_id=p_run and mode='publish' and status='running') then raise exception 'publish_run_inactive';end if;","perform 1 from public.candidates where id=p_candidate for update;","oid:=person_private.publish_audit_begin(p_candidate);","r:=person_private.projection_apply(w.work_id,w.work_id,p_candidate,oid,p_revision,p_envelope);","perform person_private.maintenance_frame('publish');\n perform person_private.maintenance_leave(opened);\n return r||jsonb_build_object('operationId',oid);"])assert.ok(chain.includes(frag)&&forward.includes(frag),frag);
 assert.match(forward,/prior_pending:=exists\(select 1 from public\.person_change_events e where e\.candidate_id=p_candidate and e\.reconciled_at is null\);/);
 assert.match(forward,/transaction_id=pg_current_xact_id\(\) and e\.source_table='candidates'/);
 assert.match(forward,/delete from public\.person_change_queue where candidate_id=p_candidate and version=own_version;/);
 // the statement fence admits the publish frame for the same two tables only, with the active-frame check
 const fence=read('20260928030000_person_maintenance_window.sql');
 assert.match(fence,/if not \(tg_table_name in \('person_change_events','person_change_queue'\) and person_private\.maintenance_frame_present\('catchup'\)\) then raise exception 'audit_proof_maintenance';end if;/);
 assert.match(forward,/tg_table_name in \('person_change_events','person_change_queue'\)\n\s+and \(person_private\.maintenance_frame_present\('catchup'\) or person_private\.maintenance_frame_present\('publish'\)\)\) then raise exception 'audit_proof_maintenance';end if;/);
 assert.match(forward,/else perform person_private\.maintenance_frame\('publish'\);end if;/);
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
  '20261014120000_person_reconcile_v2_fingerprint_plan.sql',
  '20261015120000_person_publish_capture_attribution.sql',
  '20261016230000_person_reconcile_people_latest_idx.sql',
  '20261022010000_person_audit_finalize_window.sql',
 ]);
 assert.equal(last,'20261022010000_person_audit_finalize_window.sql');
});
test('audit finalize window: the forward keeps the finalizer\'s signature, gates and every check, adds the audit_finalize step and a frame-entering wrapper, widens no grant',()=>{
 const chain=read('20260926233000_person_audit_reference_ownership.sql'), windows=read('20260928050000_person_publish_admission.sql'), forward=read('20261022010000_person_audit_finalize_window.sql');
 const code=forward.split('\n').filter(l=>!l.startsWith('--')).join('\n');
 const sig=/create or replace function public\.person_postcutover_audit_finalize\(p_run text,p_pass integer default 1\) returns jsonb\nlanguage plpgsql volatile set search_path='' set timezone='UTC' set datestyle='ISO,YMD' set lock_timeout='2s' as \$\$/;
 assert.match(chain,sig);assert.match(forward,sig);
 assert.doesNotMatch(code,/grant/i,'nothing granted');
 // the only drops are the two step check constraints, re-added at once with the new step (as 20260928050000 did for publish)
 assert.deepEqual(code.match(/drop[^;]*;/gi),['drop constraint maintenance_frames_step_check;','drop constraint maintenance_events_step_check;']);
 for(const tbl of ['frames','events'])assert.match(code,new RegExp(`alter table person_private\\.maintenance_${tbl} add constraint maintenance_${tbl}_step_check check\\(step in \\('catchup','anchors','publish','audit_finalize'\\)\\);`));
 assert.match(code,/revoke all on function public\.person_postcutover_audit_finalize_window\(text,integer\) from public,anon,authenticated;/);
 // every check and gate of the chain's finalizer is verbatim in the forward
 for(const frag of ["if current_setting('transaction_isolation')<>'read committed' then raise exception 'audit_isolation';end if;","perform pg_advisory_xact_lock(72005,0);","perform pg_advisory_xact_lock(72006,0);",
  "if not found or r.status not in ('running','paused') then raise exception 'audit_run_finished';end if;","if r.pass is distinct from p_pass then raise exception 'audit_run_pass';end if;",
  "state:=case when reviews>0 then 'review_required'","when unverified>0 or stale>0 or dir_stale>0 or lookup_stale>0 or holds>0 or dir_pending>0 or not external_stable then 'catchup_pending' else 'audited' end;",
  "ext:=public.person_postcutover_audit_external_inputs();"])assert.ok(chain.includes(frag)&&forward.includes(frag),frag);
 // the 8 s rule stays for callers outside a window; the window bound is the window maximum
 assert.match(code,/if person_private\.maintenance_frame_present\('audit_finalize'\) then\n\s+if current_setting\('statement_timeout'\)::interval<=interval '0 seconds' or current_setting\('statement_timeout'\)::interval>interval '240 minutes' then raise exception 'audit_statement_timeout';end if;\n\s+elsif current_setting\('statement_timeout'\)::interval<=interval '0 seconds' or current_setting\('statement_timeout'\)::interval>interval '8 seconds' then raise exception 'audit_statement_timeout';end if;/);
 // the window step: held only, bound to a scan-complete audit run; the other steps' rules are verbatim
 for(const frag of ["if not c.enabled or c.phase<>'held' then raise exception 'maintenance_requires_held';end if;",
  "max_minutes:=case when p_step='publish' then 720 else 240 end;","and notes->>'commit'='c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc') then raise exception 'maintenance_run';end if;"])assert.ok(windows.includes(frag)&&forward.includes(frag),frag);
 // the held-branch unresolved check is the one 20260928090000 patched into the live definition (deferred work is resolved)
 const deferred=read('20260928090000_person_maintenance_deferred.sql');
 const patched=deferred.match(/execute replace\(d,n,'(.*?)'\);/s)[1].replace(/''/g,"'");
 assert.ok(forward.includes(patched),'patched unresolved check carried verbatim');
 assert.ok(!code.includes("scope='tt_person' and status<>'completed') then raise exception 'transition_unresolved'"),'the unpatched held check is gone');
 assert.match(code,/if p_step='audit_finalize' and not exists\(select 1 from public\.person_postcutover_audit_runs where run_id=p_run and status in \('running','paused'\) and scan_complete\) then raise exception 'maintenance_run';end if;/);
 assert.match(code,/if p_step in \('catchup','publish','audit_finalize'\) then/);
 assert.match(code,/p_step not in \('catchup','anchors','publish','audit_finalize'\)/);
 // the wrapper mirrors the catch-up wrappers: enter, run the unchanged finalizer, leave
 assert.match(code,/opened:=person_private\.maintenance_enter\('audit_finalize',p_run\);\n result:=public\.person_postcutover_audit_finalize\(p_run,p_pass\);\n perform person_private\.maintenance_leave\(opened\);/);
});
test('reconcile latest index: the forward adds one index in the exact distinct-on order of the pending view and the finisher, nothing else',()=>{
 const chain=read('20260926042200_person_reconcile.sql'), forward=read('20261016230000_person_reconcile_people_latest_idx.sql');
 const code=forward.split('\n').filter(l=>!l.startsWith('--')).join('\n').trim();
 assert.equal(code,"create index if not exists person_reconcile_people_latest_idx\n on public.person_reconcile_people(candidate_id, checked_at desc, run_id desc);");
 // the order the chain's latest-check queries use (person_reconcile_pending and person_reconcile_finish)
 assert.ok(chain.includes('distinct on(candidate_id) candidate_id,status,revision from public.person_reconcile_people where counted order by candidate_id,checked_at desc,run_id desc'));
 assert.doesNotMatch(code,/grant|revoke|drop|alter|create or replace/i);
});
