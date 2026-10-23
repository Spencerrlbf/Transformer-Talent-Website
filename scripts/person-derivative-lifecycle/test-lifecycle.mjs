// These tests use real producer publication, checked work and SQL transactions.
import '../person-derivative-journal/test-journal.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as lib from '../dist/worker-lib.mjs';
import { pool, phase, fixture, run, use, org } from '../person-directory-execution/test-execution.mjs';

async function fresh() {
 const f=await fixture();f.args.mode='live';assert.equal((await run(f)).status,'done');
 return {f,a:{organizationId:org,candidateId:f.id,requestId:randomUUID(),token:randomUUID(),allowPaid:true}};
}
const claim=a=>use(c=>lib.claimCertifiedDerivativesOnConnection(c,a));
const start=a=>use(c=>lib.startCertifiedDerivativesProviderOnConnection(c,a));
const store=(a,vectors)=>use(c=>lib.storeCertifiedDerivativeVectorsOnConnection(c,{...a,vectors}));
const recover=a=>use(c=>lib.recoverCertifiedDerivativesOnConnection(c,a));
const job=async id=>(await pool.query('select * from person_derivative_jobs where candidate_id=$1',[id])).rows[0];
const life=async a=>(await pool.query('select * from person_private.derivative_lifecycles where request_id=$1',[a.requestId])).rows[0];
const vectors=n=>Array.from({length:n},()=>Array(1536).fill(0.125));

test('claim is separately admitted, replayable and binds the actual published chunks',async()=>{
 const {f,a}=await fresh(), result=await claim(a);
 assert.equal(result.status,'claimed');assert.ok(result.missing.length>0);
 assert.equal((await job(f.id)).attempts,1);assert.deepEqual(await claim(a),result);
 const e=await life(a);assert.equal(e.candidate_id,f.id);assert.equal(e.provider_started_at,null);
 assert.equal((await pool.query('select family,status from person_private.transition_work where id=$1',[e.work_id])).rows[0].family,'derivative');
 assert.equal((await pool.query('select person_private.derivative_job_current($1) valid',[f.id])).rows[0].valid,true);
 assert.equal((await run(f)).status,'done'); // Original producer receipt remains replayable.
});
test('provider start can be certified only once and a known result is retained idempotently',async()=>{
 const {a}=await fresh(),c=await claim(a);
 const s=await start(a);assert.equal(s.status,'start');assert.deepEqual(s.missing,c.missing);
 assert.equal((await start(a)).status,'uncertain');
 const v=vectors(c.missing.length);assert.equal((await store(a,v)).status,'stored');
 assert.equal((await store(a,v)).status,'stored');assert.deepEqual((await life(a)).vectors,v);
 const changed=v.map(x=>[0.5,...x.slice(1)]);await assert.rejects(store(a,changed),/derivative_vectors_changed/);
 assert.equal((await pool.query('select count(*)::int n from candidate_embeddings where candidate_id=$1',[a.candidateId])).rows[0].n,0);
});
test('unknown paid result blocks sealing and later capture recovers without a new request',async()=>{
 const {a}=await fresh(),c=await claim(a);await start(a);
 assert.equal((await recover(a)).status,'uncertain');
 const e=await life(a);assert.equal((await pool.query('select status from person_private.transition_work where id=$1',[e.work_id])).rows[0].status,'uncertain');
 assert.equal((await store(a,vectors(c.missing.length))).status,'retry');
 assert.equal((await pool.query('select status from person_private.transition_work where id=$1',[e.work_id])).rows[0].status,'completed');
 assert.equal((await job(a.candidateId)).status,'pending');
 const next={...a,requestId:randomUUID(),token:randomUUID()};const reused=await claim(next);
 assert.equal(reused.status,'claimed');assert.deepEqual(reused.missing,[]);
});
test('disabled paid configuration and invalid tenant return before a connection query',async()=>{
 let calls=0;const c={query:async()=>{calls++;throw Error('unexpected_io')}};
 const a={organizationId:org,candidateId:randomUUID(),requestId:randomUUID(),token:randomUUID(),allowPaid:false};
 assert.equal((await lib.claimCertifiedDerivativesOnConnection(c,a)).status,'disabled');
 await assert.rejects(lib.claimCertifiedDerivativesOnConnection(c,{...a,allowPaid:true,organizationId:randomUUID()}),/derivative_scope/);assert.equal(calls,0);
});
export {fresh,claim,start,store,recover,job,life,vectors};

test('concurrent claims have one owner and do not consume two attempts',async()=>{
 const {a}=await fresh();const out=await Promise.all([claim(a),claim({...a,requestId:randomUUID(),token:randomUUID()})]);
 assert.deepEqual(out.map(x=>x.status).sort(),['busy','claimed']);assert.equal((await job(a.candidateId)).attempts,1);
});
test('begin without canonical seal cannot commit orphan work',async()=>{
 const {a}=await fresh();await use(async c=>{await c.query('begin');
  assert.equal((await c.query('select person_private.derivative_claim_begin($1,$2,$3,$4) r',[org,a.requestId,a.candidateId,a.token])).rows[0].r.status,'prepare');
  await assert.rejects(c.query('commit'),/derivative_lifecycle_incomplete/);
 });assert.equal(await life(a),undefined);assert.equal((await job(a.candidateId)).attempts,0);
});
test('generic derivative work admission and generic finish or renewal cannot bypass lifecycle',async()=>{
 const {a}=await fresh();await assert.rejects(pool.query("select person_private.transition_claim('tt_person',$1,'derivative',$2,repeat('1',64),$3,600)",[org,'derivative:'+randomUUID(),randomUUID()]),/derivative_admission_required/);
 await claim(a);const e=await life(a);
 for(const [fn,args] of [['transition_renew',[e.work_id,a.token,600]],['transition_finish',[e.work_id,a.token,'completed']]])
  await assert.rejects(pool.query(`select person_private.${fn}($1,$2,$3)`,args),/derivative_consumer_frame/);
 await phase(false);try{await assert.rejects(pool.query("update person_private.transition_work set family='maintenance' where id=$1",[e.work_id]),/derivative_/);await assert.rejects(pool.query("update person_private.derivative_lifecycles set vectors='[]' where request_id=$1",[a.requestId]),/derivative_consumer_frame/);}finally{await phase();}
});
test('fresh claims are refused held or draining while admitted recovery can drain',async()=>{
 const {a}=await fresh();await claim(a);await phase(true,'draining');
 try{await assert.rejects(claim({...a,requestId:randomUUID(),token:randomUUID()}),/derivative_held/);assert.equal((await recover(a)).status,'retry');await phase(true,'held');assert.equal((await recover(a)).status,'retry');}finally{await phase();}
});
test('changed canonical manifest rolls back all admission and public state',async()=>{
 const {a}=await fresh();await use(async c=>{const wrapped={query:(sql,v)=>{
  if(sql.includes('derivative_claim_seal')){v=[...v];v[2]=JSON.stringify([{source_type:'summary',chunk_index:0,content:'Unowned text',content_hash:'0'.repeat(64)}]);}return c.query(sql,v);
 }};await assert.rejects(lib.claimCertifiedDerivativesOnConnection(wrapped,a),/derivative_parts/);});
 assert.equal(await life(a),undefined);assert.equal((await job(a.candidateId)).attempts,0);
});
for(const table of ['derivative_lifecycles','derivative_consumer_frames','derivative_admission_frames'])
 test(`suppressed ${table} writes cannot commit a partial claim`,async()=>{
 const {a}=await fresh();await pool.query(`create function person_private.synthetic_consumer_suppress() returns trigger language plpgsql as $$begin return null;end$$;create trigger zz_consumer_suppress before ${table==='derivative_lifecycles'?'insert':'delete'} on person_private.${table} for each row execute function person_private.synthetic_consumer_suppress()`);
 try{await assert.rejects(claim(a),/derivative_/);assert.equal(await life(a),undefined);assert.equal((await job(a.candidateId)).attempts,0);}
 finally{await pool.query(`drop trigger zz_consumer_suppress on person_private.${table};drop function person_private.synthetic_consumer_suppress()`);}
});
async function shortClaim(a){
 await pool.query("create function person_private.synthetic_short_consumer() returns trigger language plpgsql as $$begin if new.family='derivative' then new.lease_until:=clock_timestamp()+interval '500 milliseconds';end if;return new;end$$;create trigger aa_short_consumer before insert on person_private.transition_work for each row execute function person_private.synthetic_short_consumer()");
 try{return await claim(a);}finally{await pool.query('drop trigger aa_short_consumer on person_private.transition_work;drop function person_private.synthetic_short_consumer()');}
}
test('known vectors arriving after lease expiration are retained and replay returns the same retry result',async()=>{
 const {a}=await fresh(),c=await shortClaim(a);await start(a);await new Promise(r=>setTimeout(r,550));
 const v=vectors(c.missing.length);assert.deepEqual(await store(a,v),{status:'retry'});assert.deepEqual(await store(a,v),{status:'retry'});assert.deepEqual((await life(a)).vectors,v);
});
test('malformed result cannot consume the only valid provider response',async()=>{
 const {a}=await fresh(),c=await claim(a);await start(a);
 for(const v of [[],[[0.1]],vectors(c.missing.length).map(x=>[Infinity,...x.slice(1)])])await assert.rejects(store(a,v),/derivative_vectors/);
 assert.equal((await life(a)).vectors,null);assert.equal((await store(a,vectors(c.missing.length))).status,'stored');
});
import {app,processApp} from '../person-application-enrichment/test-tt-enrichment.mjs';
async function appFresh(){const username='consumer-'+randomUUID(),out=await processApp(await app({},username));assert.equal(out.status,'processed',out.error?.message);return {username,a:{organizationId:org,candidateId:out.result.candidateId,requestId:randomUUID(),token:randomUUID(),allowPaid:true}};}
test('same-text producer rebase during HTTP preserves newer revision and receipt reference',async()=>{
 const {a,username}=await appFresh(),c=await claim(a);await start(a);const before=await job(a.candidateId);
 const next=await processApp(await app({email:'later-'+randomUUID()+'@example.test'},username));assert.equal(next.status,'processed',next.error?.message);
 const current=await job(a.candidateId);assert.equal(current.desired_hash,before.desired_hash);assert.equal(current.claim_token,a.token);assert.notEqual(current.receipt_ref,before.receipt_ref);
 assert.equal((await store(a,vectors(c.missing.length))).status,'stored');assert.equal((await recover(a)).status,'retry');
 const after=await job(a.candidateId);assert.equal(after.receipt_ref,current.receipt_ref);assert.equal(after.desired_revision,current.desired_revision);
});
test('changed source supersedes only public ownership and an unknown earlier paid request blocks another start',async()=>{
 const {a,f}=await fresh(),c=await claim(a);await start(a);
 const next=await processApp(await app({},f.before.linkedin_username));assert.equal(next.status,'processed',next.error?.message);
 const changed=await job(a.candidateId);assert.notEqual(changed.desired_hash,c.desiredHash);
 const b={...a,requestId:randomUUID(),token:randomUUID()};const attempts=(await job(a.candidateId)).attempts;
 assert.deepEqual(await claim(b),{status:'busy'});assert.equal(await life(b),undefined);assert.equal((await job(a.candidateId)).attempts,attempts);
 const newJob=await job(a.candidateId);assert.equal((await store(a,vectors(c.missing.length))).status,'superseded');assert.deepEqual(await job(a.candidateId),newJob);
 const reclaimed=await claim(b);assert.equal(reclaimed.status,'claimed');assert.ok(reclaimed.missing.length< (await life(b)).parts.length);assert.equal((await start(b)).status,'start');
});
test('foreign embedding unique-key collision is detected before claim or paid start',async()=>{
 const {a}=await fresh(),j=await job(a.candidateId),part=lib.personDerivativeChunks(j.sources)[0],foreign=randomUUID();
 await pool.query("insert into organizations(id,slug) values($1::uuid,'foreign-'||$1::text)",[foreign]);
 await pool.query('insert into candidate_embeddings(organization_id,candidate_id,source_type,chunk_index,content_hash,content,model,dimensions,embedding) values($1,$2,$3,$4,$5,$6,$7,1536,$8::vector)',[foreign,a.candidateId,part.source_type,part.chunk_index,part.content_hash,part.content,j.model,JSON.stringify(vectors(1)[0])]);
 await assert.rejects(claim(a),/derivative_foreign_collision/);assert.equal(await life(a),undefined);assert.equal((await job(a.candidateId)).attempts,0);
});
test('SQL manifest verifies Unicode byte and code-unit limits against the actual chunker',async()=>{
 for(const text of ['😀'.repeat(1700),'中'.repeat(4000),'\uFEFF\t'+ 'a'.repeat(18000)+'\u00a0','x'.repeat(2798)+' 😀\nend']){
  const sources={linkedin_profile:text,resume:'',summary:'\tA\nB\uFEFF'};
  assert.deepEqual((await pool.query('select person_private.derivative_chunks($1::jsonb) p',[JSON.stringify(sources)])).rows[0].p,lib.personDerivativeChunks(sources));
 }
});
test('lease crossing inside vector retention returns a durable identical retry on replay',async()=>{
 const {a}=await fresh(),c=await shortClaim(a);await start(a);
 await pool.query("create function person_private.synthetic_store_delay() returns trigger language plpgsql as $$begin if new.vectors is not null and old.vectors is null then perform pg_sleep(0.6);end if;return new;end$$;create trigger zz_store_delay after update on person_private.derivative_lifecycles for each row execute function person_private.synthetic_store_delay()");
 try{const v=vectors(c.missing.length);assert.deepEqual(await store(a,v),{status:'retry'});assert.deepEqual(await store(a,v),{status:'retry'});}
 finally{await pool.query('drop trigger zz_store_delay on person_private.derivative_lifecycles;drop function person_private.synthetic_store_delay()');}
});
test('standalone recovery job write cannot commit without its lifecycle and work outcome',async()=>{
 const {a}=await fresh();await claim(a);const before=await job(a.candidateId);
 await use(async c=>{await c.query("begin;set local timezone='UTC';set local datestyle='ISO,YMD'");await c.query('select person_private.derivative_consumer_enter($1,$2,$3,$4,true,false)',[org,a.requestId,a.candidateId,a.token]);
  await c.query("select person_private.derivative_consumer_write($1,'person_derivative_jobs',to_jsonb(j),to_jsonb(j)||jsonb_build_object('status','pending','claim_token',null,'lease_until',null,'claim_missing',null)) from person_derivative_jobs j where candidate_id=$2",[a.requestId,a.candidateId]);
  await assert.rejects(c.query('commit'),/derivative_/);
 });assert.deepEqual(await job(a.candidateId),before);
});
test('legacy ambiguous paid history retained in producer genesis cannot authorize another provider start',async()=>{
 const f=await fixture(()=>{},async(db,id)=>{await db.query("insert into person_derivative_jobs(candidate_id,desired_revision,desired_hash,sources,model,dimensions,receipt_ref,status,attempts) values($1,1,'old','{}','text-embedding-3-small',1536,'legacy:synthetic','pending',1)",[id]);});f.args.mode='live';await run(f);
 const a={organizationId:org,candidateId:f.id,requestId:randomUUID(),token:randomUUID(),allowPaid:true};assert.equal((await claim(a)).status,'review');assert.equal(await life(a),undefined);assert.equal((await job(f.id)).attempts,0);
});
for(const field of ['provider_started_at','vectors'])test(`retained ${field} cannot be cleared through an entered private helper`,async()=>{
 const {a}=await fresh(),c=await claim(a);await start(a);if(field==='vectors')await store(a,vectors(c.missing.length));
 await use(async db=>{await db.query("begin;set local timezone='UTC';set local datestyle='ISO,YMD'");await db.query('select person_private.derivative_consumer_enter($1,$2,$3,$4,true,false)',[org,a.requestId,a.candidateId,a.token]);
  await assert.rejects(db.query(`select person_private.derivative_lifecycle_set(to_jsonb(e),to_jsonb(e)||jsonb_build_object('${field}',null)) from person_private.derivative_lifecycles e where request_id=$1`,[a.requestId]),/derivative_immutable/);
 });assert.ok((await life(a))[field]);
});

test('vectors stored before the lease passes survive a commit that lands after it',async()=>{
 const {a}=await fresh(),c=await shortClaim(a);await start(a);
 await pool.query("create function person_private.synthetic_commit_delay() returns trigger language plpgsql as $$begin if new.vectors is not null and new.phase='stored' then perform pg_sleep(0.6);end if;return null;end$$;create constraint trigger aa_commit_delay after update on person_private.derivative_lifecycles deferrable initially deferred for each row execute function person_private.synthetic_commit_delay()");
 try{const v=vectors(c.missing.length);assert.deepEqual(await store(a,v),{status:'stored'});assert.deepEqual((await life(a)).vectors,v);assert.equal((await life(a)).phase,'stored');assert.deepEqual(await store(a,v),{status:'stored'});}
 finally{await pool.query('drop trigger aa_commit_delay on person_private.derivative_lifecycles;drop function person_private.synthetic_commit_delay()');}
 assert.equal((await recover(a)).status,'retry');assert.equal((await job(a.candidateId)).status,'pending');
 const next={...a,requestId:randomUUID(),token:randomUUID()};const reused=await claim(next);assert.equal(reused.status,'claimed');assert.deepEqual(reused.missing,[]);
});
