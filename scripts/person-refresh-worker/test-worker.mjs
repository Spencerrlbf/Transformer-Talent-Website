import test from 'node:test';import assert from 'node:assert/strict';import{randomUUID}from'node:crypto';import pg from'pg';
import*as real from'../dist/worker-lib.mjs';import{prepareAuditFixture}from'../person-audit/local-fixture.mjs';
const url=process.env.LOCAL_DATABASE_URL;if(!/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_refresh_worker_test$/.test(url??''))throw Error('local_fixture_required');
const pool=new pg.Pool({connectionString:url,max:8});const org=real.TT_ORG_ID;
async function use(fn){const c=await pool.connect();try{return await fn(c)}finally{await c.query('rollback');c.release()}}
const lib={TT_ORG_ID:org};for(const name of ['pickCertifiedRefresh','recoverCertifiedRefresh','topUpCertifiedRefresh','claimCertifiedRefresh','startCertifiedRefreshProvider','storeCertifiedRefreshPayload','saveCertifiedRefresh','failCertifiedRefresh'])lib[name]=a=>use(c=>real[name+'OnConnection'](c,a));
async function fixture(cache=true){
 await pool.query("update person_private.transition_control set enabled=false,phase='open' where singleton");const candidate=randomUUID(),queueId=randomUUID(),username='worker-run-'+candidate;
 await pool.query("insert into candidates(id,full_name,linkedin_username,current_title,created_at) values($1,'Synthetic Worker Run',$2,'Original','2020-01-01')",[candidate,username]);await prepareAuditFixture(candidate);
 await pool.query('insert into refresh_queue(id,organization_id,candidate_id) values($1,$2,$3)',[queueId,org,candidate]);
 if(cache)await pool.query("insert into candidate_enrichments(candidate_id,organization_id,linkedin_username,raw_payload,created_at) values($1,$2,$3,$4,clock_timestamp()-interval '1 day')",[candidate,org,username,{headline:'Synthetic saved source',experience:[]}]);
 await pool.query('update person_private.transition_control set enabled=true where singleton');return{candidate,queueId};
}
async function run(options={}){const {runCertifiedRefresh}=await import('./worker.mjs');return runCertifiedRefresh({lib,organizationId:org,mode:'shadow',dailyCap:0,allowPaid:false,noTopup:true,concurrency:1,harvestProfile:()=>assert.fail('provider called'),log:()=>{},warn:()=>{},...options});}
const state=async a=>(await pool.query('select status from refresh_queue where id=$1',[a.queueId])).rows[0].status;
test.beforeEach(()=>{process.env.PERSON_TRANSITION_SUPPORT='on'});test.after(async()=>{delete process.env.PERSON_TRANSITION_SUPPORT;await pool.end()});
test('certified worker saves cached work without provider or derivative calls',async()=>{
 const a=await fixture();const out=await run({lib:{...lib,drainPersonDerivatives:()=>assert.fail('legacy derivative')}});assert.equal(out.refreshed,1);assert.equal(out.failed,0);assert.equal(await state(a),'done');
 assert.equal((await pool.query('select current_title from candidates where id=$1',[a.candidate])).rows[0].current_title,'Original');
});
test('lost committed claim and save responses recover one success and zero failures',async()=>{
 const a=await fixture();let claims=0,saves=0;
 const out=await run({lib:{...lib,claimCertifiedRefresh:async x=>{const r=await lib.claimCertifiedRefresh(x);if(++claims===1)throw Error('lost_claim');return r},saveCertifiedRefresh:async x=>{const r=await lib.saveCertifiedRefresh(x);if(++saves<=2)throw Error('lost_save');return r}}});
 assert.equal(out.refreshed,1);assert.equal(out.failed,0);assert.equal(await state(a),'done');assert.equal((await pool.query('select attempts from person_refresh_attempts where queue_id=$1',[a.queueId])).rows[0].attempts,1);
});
test('unknown committed provider start never repeats HTTP on the next invocation',async()=>{
 const a=await fixture(false);let http=0;const out=await run({dailyCap:1000,allowPaid:true,harvestProfile:async()=>{http++;return{headline:'Synthetic'}},lib:{...lib,startCertifiedRefreshProvider:async x=>{await lib.startCertifiedRefreshProvider(x);throw Error('start_response_lost')}}});
 assert.ok(out.uncertain>=1);assert.equal(http,0);assert.equal(await state(a),'patch_failed');
 await run({dailyCap:1000,allowPaid:true,harvestProfile:async()=>{http++;return{headline:'Synthetic'}}});assert.equal(http,0);
});
test('retains obtained payload through ambiguous store responses without repeating provider',async()=>{
 const a=await fixture(false);let http=0,stores=0;const raw={headline:'Synthetic paid source',experience:[]};const out=await run({dailyCap:1000,allowPaid:true,harvestProfile:async()=>{http++;return raw},lib:{...lib,storeCertifiedRefreshPayload:async x=>{assert.deepEqual(x.raw,raw);const r=await lib.storeCertifiedRefreshPayload(x);if(++stores<3)throw Error('lost_store');return r}}});
 assert.equal(out.refreshed,1);assert.equal(http,1);assert.equal(stores,3);assert.equal(await state(a),'done');assert.equal((await pool.query('select count(*)::int n from candidate_enrichments where candidate_id=$1',[a.candidate])).rows[0].n,1);
});
test('draining recovers expired saved work but waits for open before a free request',async()=>{
 const a=await fixture();const key={organizationId:org,queueId:a.queueId,requestId:randomUUID(),token:randomUUID(),dailyCap:0,allowPaid:false};
 await pool.query("create function public.worker_short_lease() returns trigger language plpgsql as $$begin new.lease_until:=clock_timestamp()+interval '10 milliseconds';return new;end$$;create trigger worker_short_lease before insert on person_private.transition_work for each row execute function public.worker_short_lease()");
 try{await lib.claimCertifiedRefresh(key)}finally{await pool.query('drop trigger worker_short_lease on person_private.transition_work;drop function public.worker_short_lease()')}
 await new Promise(r=>setTimeout(r,30));await pool.query("update person_private.transition_control set phase='draining' where singleton");const drained=await run();assert.equal(drained.refreshed,0);
 assert.equal((await pool.query('select attempts,phase from person_refresh_attempts where queue_id=$1',[a.queueId])).rows[0].phase,'ready');
 await pool.query("update person_private.transition_control set phase='open' where singleton");const opened=await run();assert.equal(opened.refreshed,1);assert.equal(await state(a),'done');
 assert.equal((await pool.query('select attempts from person_refresh_attempts where queue_id=$1',[a.queueId])).rows[0].attempts,2);
});

test('a cached pick never becomes paid when its cache expires while queued',async()=>{
 const a=await fixture();await pool.query("update person_private.transition_control set enabled=false where singleton");await pool.query("update candidate_enrichments set created_at=clock_timestamp()-interval '30 days'+interval '200 milliseconds' where candidate_id=$1",[a.candidate]);await pool.query("update person_private.transition_control set enabled=true where singleton");
 let http=0;await run({dailyCap:1000,allowPaid:true,harvestProfile:async()=>{http++;return{headline:'Synthetic'}},lib:{...lib,pickCertifiedRefresh:async x=>{const rows=await lib.pickCertifiedRefresh(x);await new Promise(r=>setTimeout(r,300));return rows}}});
 assert.equal(http,0);const attempt=(await pool.query('select phase,paid_requested_at from person_refresh_attempts where queue_id=$1',[a.queueId])).rows[0];assert.equal(attempt.phase,'review');assert.equal(attempt.paid_requested_at,null);
});
test('late paid source admits exactly one new free UUID with the original ledger',async()=>{
 const a=await fixture(false);let http=0;
 await pool.query("create sequence public.worker_once;create function public.worker_first_short() returns trigger language plpgsql as $$begin if nextval('public.worker_once')=1 then new.lease_until:=clock_timestamp()+interval '100 milliseconds';end if;return new;end$$;create trigger worker_first_short before insert on person_private.transition_work for each row execute function public.worker_first_short()");
 let out;try{out=await run({dailyCap:1000,allowPaid:true,harvestProfile:async()=>{http++;await new Promise(r=>setTimeout(r,160));return{headline:'Synthetic late paid source',experience:[]}}})}finally{await pool.query('drop trigger worker_first_short on person_private.transition_work;drop function public.worker_first_short();drop sequence public.worker_once')}
 assert.equal(out.refreshed,1);assert.equal(out.failed,0);assert.equal(http,1);assert.equal(await state(a),'done');
 const history=(await pool.query("select phase,paid,options,source_snapshot->>'id' ledger from person_private.refresh_lifecycles where queue_id=$1 order by sequence",[a.queueId])).rows;assert.equal(history.length,2);assert.equal(history[0].phase,'retry');assert.equal(history[1].phase,'done');assert.equal(history[1].paid,false);assert.equal(history[1].options.allowPaid,false);assert.equal(history[0].ledger,history[1].ledger);
});
test('exhausted store response retries keep one paid source for the next free invocation',async()=>{
 const a=await fixture(false);let http=0,stores=0;const provider=async()=>{http++;return{headline:'Synthetic retained payload',experience:[]}};
 const first=await run({dailyCap:1000,allowPaid:true,harvestProfile:provider,lib:{...lib,storeCertifiedRefreshPayload:async x=>{stores++;await lib.storeCertifiedRefreshPayload(x);throw Error('lost_store_forever')}}});
 assert.equal(first.failed,1);assert.equal(http,1);assert.equal(stores,3);const second=await run({harvestProfile:provider});assert.equal(second.refreshed,1);assert.equal(http,1);assert.equal(await state(a),'done');
 assert.equal((await pool.query('select count(*)::int n from candidate_enrichments where candidate_id=$1',[a.candidate])).rows[0].n,1);
});
