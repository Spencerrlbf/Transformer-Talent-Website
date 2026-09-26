import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import pg from 'pg';
import * as lib from '../dist/worker-lib.mjs';
const url=process.env.LOCAL_DATABASE_URL;
if(!url||!['localhost','127.0.0.1'].includes(new URL(url).hostname))throw Error('local_database_required');
const db=new pg.Pool({connectionString:url,max:5,statement_timeout:15000});
const id=n=>`d6000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const run='anchor-local-history';
const pin='c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc';
const use=async fn=>{const c=await db.connect();try{return await fn(c);}finally{c.release();}};
const rpc=async(fn,args,c=db)=>(await c.query(`select public.${fn}($1::jsonb) result`,[JSON.stringify(args)])).rows[0].result;
const inputs=async n=>(await rpc('person_audit_anchor_inputs',[id(n)]))[0];
const commit=async item=>(await rpc('person_audit_anchor_commit',[item]))[0];
const anchor=async n=>(await db.query('select to_jsonb(a) a from person_audit_anchors a where candidate_id=$1',[id(n)])).rows[0]?.a;
async function verify(n,r=run){
 const state=(await db.query('select rev from candidate_profile_state where candidate_id=$1',[id(n)])).rows[0];
 const ver=(await db.query('select coalesce(max(id),0)::text v from person_change_events where candidate_id=$1',[id(n)])).rows[0].v;
 await db.query(`insert into person_reconcile_people(run_id,candidate_id,status,revision,captured_version,source_hash,checks,counted) values($1,$2,'verified',$3,$4,'synthetic-reviewed-source-hash','{"integrity_ok":true,"external_stable":true}',true) on conflict(run_id,candidate_id) do update set status='verified',revision=excluded.revision,captured_version=excluded.captured_version,checks=excluded.checks,counted=true,checked_at=clock_timestamp()`,[r,id(n),state.rev,ver]);
}
async function seed(n,{aux=false,verified=true}={}){
 await db.query(`insert into candidates(id,full_name,linkedin_username,current_title,current_company,created_at,linkedin_enrichment_date,email) values($1,'Synthetic Anchor',$2,'Engineer','Synthetic Co','2025-01-01','2025-01-01',$3)`,[id(n),`anchor-${n}`,`anchor-${n}@example.test`]);
 if(aux){
  await db.query(`insert into candidate_emails(id,candidate_id,email_address) values($1,$2,$3)`,[id(n+1000),id(n),`legacy-${n}@example.test`]);
  await db.query(`insert into candidate_emails_v2(id,candidate_id,email_raw,email_normalized) values($1,$2,$3::text,$3::text::citext)`,[id(n+2000),id(n),`v2-${n}@example.test`]);
  await db.query(`insert into candidate_communications(id,recruiter_id,candidate_id,communication_type,status,email_used) values($1,1,$2,'email','replied',$3)`,[id(n+3000),id(n),id(n+1000)]);
 }
 const row=(await db.query('select to_jsonb(c) r from candidates c where id=$1',[id(n)])).rows[0].r;
 const rows=async t=>(await db.query(`select to_jsonb(x) r from ${t} x where candidate_id=$1 order by id`,[id(n)])).rows.map(x=>x.r);
 const doc=lib.fromLegacyImport(row,await rows('candidate_emails'),await rows('candidate_emails_v2'),await rows('candidate_communications'));
 await db.query('select save_person($1::jsonb)',[doc]);
 if(verified)await verify(n);
 return doc;
}
before(async()=>{await db.query(`insert into backfill_runs(run_id,pass,status,notes) values($1,'shadow','paused',$2) on conflict(run_id) do nothing`,[run,{kind:'reconcile',parser:'person-v3',commit:pin}]);});
after(()=>db.end());
test('anchor preparation helper and bounded RPCs are available',async()=>{
 assert.equal(typeof lib.prepareLegacyAuditAnchor,'function');
 const r=await db.query("select to_regprocedure('public.person_audit_anchor_inputs(jsonb)') f");assert.ok(r.rows[0].f);
});
test('exact verified legacy document is frozen once without touching facts or historical accounting',async()=>{
 const doc=await seed(1,{aux:true});const snap=await inputs(1);assert.equal(snap.status,'ready');
 const item=lib.prepareLegacyAuditAnchor(snap);assert.equal(item.status,'ready');assert.deepEqual(item.doc,doc);
 const before=await db.query('select to_jsonb(c) row,(select count(*) from person_change_events where candidate_id=c.id)::int events,(select count(*) from candidate_sources where candidate_id=c.id)::int sources from candidates c where id=$1',[id(1)]);
 assert.equal((await commit(item)).status,'created');const a=await anchor(1);assert.deepEqual(a.legacy_doc,doc);assert.equal(a.baseline_run,run);assert.ok(a.external_proof.v2_hash);assert.ok(a.anchor_hash);
 assert.equal((await commit(item)).status,'unchanged');assert.deepEqual(await anchor(1),a);
 const after=await db.query('select to_jsonb(c) row,(select count(*) from person_change_events where candidate_id=c.id)::int events,(select count(*) from candidate_sources where candidate_id=c.id)::int sources from candidates c where id=$1',[id(1)]);assert.deepEqual(after.rows,before.rows);
 assert.equal((await inputs(1)).status,'anchored');
});
test('latest pending record cannot fall back to an older verified record',async()=>{
 await seed(2);await db.query(`insert into backfill_runs(run_id,pass,status,notes) values('anchor-later','shadow','paused',$1)`,[{kind:'reconcile',parser:'person-v3',commit:pin}]);await verify(2,'anchor-later');
 await db.query("update person_reconcile_people set status='pending',checked_at=clock_timestamp()+interval '1 second' where run_id='anchor-later'");
 assert.equal((await inputs(2)).reason,'historical_verification_required');
});
test('unverified and wrong-pin history cannot authorize an anchor',async()=>{
 await seed(3,{verified:false});assert.equal((await inputs(3)).reason,'historical_verification_required');
 await db.query(`insert into backfill_runs(run_id,pass,status,notes) values('anchor-wrong-pin','shadow','paused',$1)`,[{kind:'reconcile',parser:'person-v3',commit:'0'.repeat(40)}]);await verify(3,'anchor-wrong-pin');assert.equal((await inputs(3)).reason,'historical_verification_required');
});
test('source metadata and content must match the actually stored legacy document',async()=>{
 await seed(4);const s=await inputs(4);const bad=structuredClone(s);bad.row.current_title='Unproven';assert.equal(lib.prepareLegacyAuditAnchor(bad).reason,'legacy_source_mismatch');
 const item=lib.prepareLegacyAuditAnchor(s);item.doc.header.current_title='Unproven';await assert.rejects(commit(item),/audit_document_hash/);assert.equal(await anchor(4),undefined);
 const valid=lib.prepareLegacyAuditAnchor(s);valid.doc.source.provider='invented';await assert.rejects(commit(valid),/audit_source_metadata/);
});
test('changed candidate capture or normalized revision makes prepared evidence stale',async()=>{
 await seed(5);const i=lib.prepareLegacyAuditAnchor(await inputs(5));await db.query("update candidates set current_title='Changed' where id=$1",[id(5)]);assert.equal((await commit(i)).status,'pending');assert.equal(await anchor(5),undefined);
 await seed(6);const j=lib.prepareLegacyAuditAnchor(await inputs(6));await db.query('update candidate_profile_state set rev=rev+1 where candidate_id=$1',[id(6)]);assert.equal((await commit(j)).status,'pending');
});
test('v2, legacy-email and outreach changes never get combined with the frozen row',async()=>{
 for(const [n,sql] of [[7,"update candidate_emails_v2 set quality='good' where candidate_id=$1"],[8,"update candidate_emails set quality='good' where candidate_id=$1"],[9,"update candidate_communications set status='bounced' where candidate_id=$1"]]){
  await seed(n,{aux:true});const item=lib.prepareLegacyAuditAnchor(await inputs(n));await db.query(sql,[id(n)]);assert.equal((await commit(item)).status,'pending');assert.equal(await anchor(n),undefined);
 }
});
test('changed source catalog invalidates an otherwise matching revision',async()=>{
 await seed(10);const item=lib.prepareLegacyAuditAnchor(await inputs(10));await db.query("update candidate_sources set provider='changed' where candidate_id=$1",[id(10)]);assert.equal((await commit(item)).status,'pending');
});
test('published profiles and admitted receipts cannot be retrospectively anchored as legacy',async()=>{
 await seed(11);await db.query("insert into person_projection_state(candidate_id,revision,profile_hash,semantic_hash) select candidate_id,rev,'x','x' from candidate_profile_state where candidate_id=$1",[id(11)]);assert.equal((await inputs(11)).reason,'normalized_writes_present');
 await seed(12);await db.query("insert into person_recruiter_receipts(id,candidate_id,actor_id,input_hash,edited_at,requested_contact,before_contact,document,mode) values($1,$2,$3,'x',now(),'{}','{}','{}','shadow')",[id(4012),id(12),id(5012)]);assert.equal((await inputs(12)).reason,'normalized_writes_present');
});
test('unresolved source holds always refuse anchor preparation',async()=>{
 await seed(13);await db.query("insert into person_source_holds(candidate_id,ledger_id,evidence_hash,reason,evidence) values($1,$2,'synthetic','harvest_cache_date_unknown','{}')",[id(13),id(6013)]);assert.equal((await inputs(13)).reason,'source_hold');
});
test('read committed and bounded unique batches are mandatory',async()=>{
 await assert.rejects(rpc('person_audit_anchor_inputs',Array.from({length:101},()=>id(1))),/audit_batch/);
 await assert.rejects(rpc('person_audit_anchor_inputs',[id(1),id(1)]),/audit_batch/);
 await use(async c=>{await c.query('begin isolation level repeatable read');try{await assert.rejects(rpc('person_audit_anchor_commit',[],c),/audit_isolation/);}finally{await c.query('rollback');}});
});
test('a failed batch rolls back every anchor, and successful results follow UUID order',async()=>{
 await seed(14);await seed(15);const a=lib.prepareLegacyAuditAnchor(await inputs(14)),b=lib.prepareLegacyAuditAnchor(await inputs(15));const bad=structuredClone(b);bad.doc.header.full_name='Bad';await assert.rejects(rpc('person_audit_anchor_commit',[a,bad]),/audit_document_hash/);assert.equal(await anchor(14),undefined);
 const rows=await rpc('person_audit_anchor_commit',[b,a]);assert.deepEqual(rows.map(x=>x.candidate_id),[id(14),id(15)]);
});
test('client roles cannot read inputs or commit anchors',async()=>{
 for(const role of ['anon','authenticated'])await use(async c=>{await c.query(`set role ${role}`);try{await assert.rejects(rpc('person_audit_anchor_inputs',[id(1)],c),/permission denied/);await assert.rejects(rpc('person_audit_anchor_commit',[],c),/permission denied/);}finally{await c.query('reset role');}});
});

test('a v2 edit after the observed snapshot preserves the anchor witness for later detection',async()=>{
 await seed(16,{aux:true});const item=lib.prepareLegacyAuditAnchor(await inputs(16));
 await use(async c=>{await c.query('begin');try{
  const result=(await rpc('person_audit_anchor_commit',[item],c))[0];assert.equal(result.status,'created');
  await db.query("update candidate_emails_v2 set quality='good' where candidate_id=$1",[id(16)]);
  await c.query('commit');
 }catch(e){await c.query('rollback');throw e;}});
 const stored=await anchor(16),fresh=(await db.query("select md5(coalesce(jsonb_agg(to_jsonb(x) order by id),'[]')::text) h from candidate_emails_v2 x where candidate_id=$1",[id(16)])).rows[0].h;
 assert.notEqual(stored.external_proof.v2_hash,fresh);assert.deepEqual(stored.legacy_doc,item.doc);
});
test('a snapshot taken after waiting for locks sees intervening commits',async()=>{
 await seed(17,{aux:true});const item=lib.prepareLegacyAuditAnchor(await inputs(17));
 await use(async locker=>{await use(async worker=>{
  await locker.query('begin');await locker.query('select pg_advisory_xact_lock(hashtext($1))',[id(17)]);
  const pending=rpc('person_audit_anchor_commit',[item],worker);
  await locker.query("update candidate_emails_v2 set quality='good' where candidate_id=$1",[id(17)]);await locker.query('commit');
  assert.equal((await pending)[0].status,'pending');assert.equal(await anchor(17),undefined);
 });});
});
test('batch key-share locks do not deadlock against legacy child reassignment',async()=>{
 await seed(18,{aux:true});await seed(19);const items=[lib.prepareLegacyAuditAnchor(await inputs(18)),lib.prepareLegacyAuditAnchor(await inputs(19))];
 await use(async a=>{await use(async b=>{
  await a.query('begin');await a.query("set local statement_timeout='3s'");await a.query('select pg_advisory_xact_lock(72004,hashtext($1))',[id(18)]);
  await b.query('begin');await b.query("set local statement_timeout='3s'");await b.query('select 1 from candidates where id=$1 for key share',[id(19)]);
  const move=b.query('update candidate_emails set candidate_id=$2 where id=$1',[id(1018),id(19)]);
  try{const result=await rpc('person_audit_anchor_commit',items,a);assert.ok(result.every(r=>r.status==='created'));await a.query('commit');await move;await b.query('commit');}
  catch(e){await a.query('rollback');await b.query('rollback');await move.catch(()=>{});throw e;}
 });});
 assert.ok(await anchor(18));assert.ok(await anchor(19));
 const observed=(await anchor(18)).captured_version,current=(await db.query('select max(id)::text n from person_change_events where candidate_id=$1',[id(18)])).rows[0].n;assert.ok(BigInt(current)>BigInt(observed));
});
test('service role can prepare an exact anchor and its stored hash covers the entire immutable payload',async()=>{
 await seed(20);await use(async c=>{await c.query('set role service_role');try{
  const s=(await rpc('person_audit_anchor_inputs',[id(20)],c))[0];const item=lib.prepareLegacyAuditAnchor(s);assert.equal((await rpc('person_audit_anchor_commit',[item],c))[0].status,'created');
  const result=(await c.query('select anchor_hash=person_private.audit_anchor_hash(to_jsonb(a)) ok from person_audit_anchors a where candidate_id=$1',[id(20)])).rows[0];assert.equal(result.ok,true);
 }finally{await c.query('reset role');}});
});
test('source limits refuse truncation and pages advance past review items',async()=>{
 await seed(21);await db.query("insert into candidate_emails_v2(candidate_id,email_raw,email_normalized) select $1,'cap-'||n||'@example.test','cap-'||n||'@example.test' from generate_series(1,1001)n",[id(21)]);
 assert.equal((await inputs(21)).reason,'anchor_source_limit');
 const rows=(await db.query('select public.person_audit_anchor_page($1,2) r',[id(20)])).rows[0].r;assert.ok(rows.includes(id(21)));assert.ok(rows.every(x=>x>id(20)));
 await assert.rejects(db.query('select public.person_audit_anchor_page(null,101)'),/audit_batch/);
});
test('anchor RPCs require an active bounded statement timeout',async()=>{
 for(const timeout of ['0','60s'])await use(async c=>{await c.query('begin');try{
  await c.query(`set local statement_timeout='${timeout}'`);
  await assert.rejects(rpc('person_audit_anchor_inputs',[id(21)],c),/audit_statement_timeout/);
 }finally{await c.query('rollback');}});
});
test('dedicated CLI transport arms the database timeout before the RPC starts',async()=>{
 const {openAnchorDatabase}=await import('./database.mjs');
 await assert.rejects(openAnchorDatabase({}),/audit_database_url_required/);
 await assert.rejects(openAnchorDatabase({LOCAL_DATABASE_URL:'postgresql://invalid.example/test'}),/audit_database_url/);
 const site=await openAnchorDatabase({LOCAL_DATABASE_URL:url});try{const rows=await site.rpc('person_audit_anchor_page',{p_after:id(20),p_limit:2});assert.ok(Array.isArray(rows));await assert.rejects(site.rpc('unapproved_function',{}),/audit_database_method/);}finally{await site.end();}
});
