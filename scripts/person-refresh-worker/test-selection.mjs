import test from 'node:test';import assert from 'node:assert/strict';import{randomUUID}from'node:crypto';import pg from'pg';
import*as lib from'../dist/worker-lib.mjs';
const url=process.env.LOCAL_DATABASE_URL;if(!/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_refresh_worker_test$/.test(url??''))throw Error('local_fixture_required');
const pool=new pg.Pool({connectionString:url,max:8});const org=lib.TT_ORG_ID;
const phase=(p='open')=>pool.query('update person_private.transition_control set enabled=$1,phase=$2 where singleton',[p!=='off',p==='off'?'open':p]);
async function use(fn){const c=await pool.connect();try{return await fn(c)}finally{await c.query('rollback');c.release()}}
async function fixture({cache=true,username,queue=true}={}){
 await phase('off');const candidate=randomUUID(),queueId=randomUUID(),name=username??'worker-'+candidate;
 await pool.query("insert into candidates(id,full_name,linkedin_username,source,created_at) values($1,'Synthetic Worker',$2,'directory','2020-01-01')",[candidate,name]);
 await pool.query('select save_person($1::jsonb)',[lib.fromLegacyImport({id:candidate,full_name:'Synthetic Worker',linkedin_username:name,created_at:'2020-01-01'},[],[],[])]);
 if(queue)await pool.query('insert into refresh_queue(id,organization_id,candidate_id) values($1,$2,$3)',[queueId,org,candidate]);
 const ledger=randomUUID();if(cache)await pool.query("insert into candidate_enrichments(id,candidate_id,organization_id,linkedin_username,raw_payload,created_at) values($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day')",[ledger,candidate,org,name,{headline:'Synthetic source',experience:[]}]);
 await phase();return{organizationId:org,queueId,requestId:randomUUID(),token:randomUUID(),dailyCap:1000,allowPaid:true,candidate,ledger};
}
const pick=(limit=50)=>use(c=>lib.pickCertifiedRefreshOnConnection(c,{organizationId:org,limit}));
const recover=a=>use(c=>lib.recoverCertifiedRefreshOnConnection(c,a));
const claim=a=>use(c=>lib.claimCertifiedRefreshOnConnection(c,a));
const fail=a=>use(c=>lib.failCertifiedRefreshOnConnection(c,a));
test.beforeEach(()=>{process.env.PERSON_TRANSITION_SUPPORT='on'});
test.after(async()=>{delete process.env.PERSON_TRANSITION_SUPPORT;await pool.end()});
test('cached pristine work is chosen before fifty older paid rows at zero budget',async()=>{
 for(let i=0;i<50;i++)await fixture({cache:false});const free=await fixture();
 const selected=await pick();assert.equal(selected.queued[0].queueId,free.queueId);
 assert.equal((await claim({...free,dailyCap:0,allowPaid:false})).needsHarvest,false);
});
test('held picker performs no recovery or top-up mutations',async()=>{
 const a=await fixture();await phase('held');const before=(await pool.query('select count(*)::int n from refresh_queue')).rows[0].n;
 const result=await pick();assert.equal(result.phase,'held');assert.deepEqual(result.queued,[]);assert.deepEqual(result.recovery,[]);
 assert.equal((await use(c=>lib.topUpCertifiedRefreshOnConnection(c,{organizationId:org,limit:5}))).inserted,0);
 assert.equal((await pool.query('select count(*)::int n from refresh_queue')).rows[0].n,before);
});
test('completed source retry can recover after controller generation changes',async()=>{
 const a=await fixture();await claim(a);await fail(a);await pool.query('update person_private.transition_control set generation=generation+1 where singleton');
 assert.equal((await recover(a)).status,'retry');const next={...a,requestId:randomUUID(),token:randomUUID(),dailyCap:0,allowPaid:false};
 assert.equal((await claim(next)).needsHarvest,false);
 assert.equal((await pool.query('select ledger_snapshot from person_refresh_attempts where queue_id=$1',[a.queueId])).rows[0].ledger_snapshot.id,a.ledger);
});
test('pristine claim refuses orphaned lifecycle even if head and attempt are missing',async()=>{
 const a=await fixture({cache:false});await claim(a);await use(c=>lib.startCertifiedRefreshProviderOnConnection(c,a));
 await pool.query('begin;alter table person_private.refresh_heads disable trigger all;alter table person_private.refresh_lifecycles disable trigger all;alter table person_refresh_attempts disable trigger all');
 try{await pool.query('delete from person_private.refresh_heads where queue_id=$1',[a.queueId]);await pool.query('delete from person_refresh_attempts where queue_id=$1',[a.queueId]);await pool.query('alter table person_private.refresh_heads enable trigger all;alter table person_private.refresh_lifecycles enable trigger all;alter table person_refresh_attempts enable trigger all;commit')}catch(e){await pool.query('rollback');throw e}
 await assert.rejects(claim({...a,requestId:randomUUID(),token:randomUUID()}),/refresh_history_review/);
 const selected=await pick();assert.ok(!selected.queued.some(x=>x.queueId===a.queueId));
 assert.equal((await pool.query('select count(*)::int n from person_private.refresh_lifecycles where queue_id=$1',[a.queueId])).rows[0].n,1);
});
test('invalid identity becomes review without a rolled-back paid reservation',async()=>{
 const a=await fixture({cache:false,username:'invalid!'+randomUUID()});const r=await claim(a);assert.equal(r.status,'review');assert.equal(r.reason,'identity_changed');
 assert.equal((await pool.query('select paid_requested_at from person_refresh_attempts where queue_id=$1',[a.queueId])).rows[0].paid_requested_at,null);
});
test('top-up is open-only, bounded, and excludes cached or historical people',async()=>{
 const a=await fixture({cache:false,queue:false}),cached=await fixture({queue:false});
 const result=await use(c=>lib.topUpCertifiedRefreshOnConnection(c,{organizationId:org,limit:1}));assert.equal(result.inserted,1);
 assert.equal((await pool.query('select count(*)::int n from refresh_queue where candidate_id=$1',[a.candidate])).rows[0].n,1);
 assert.equal((await pool.query('select count(*)::int n from refresh_queue where candidate_id=$1',[cached.candidate])).rows[0].n,0);
});
async function waitBlocked(label){for(let i=0;i<100;i++){const r=await pool.query("select exists(select 1 from pg_stat_activity where application_name=$1 and wait_event_type='Lock') yes",[label]);if(r.rows[0].yes)return;await new Promise(r=>setTimeout(r,10))}throw Error('expected_wait_missing')}
async function topupClient(label){const c=await pool.connect();await c.query("select set_config('application_name',$1,false)",[label]);return c}
test('concurrent ordinary queue acceptance cannot roll back the bounded top-up',async()=>{
 const a=await fixture({cache:false,queue:false}),block=await pool.connect(),worker=await topupClient('ordinary_accept_worker');
 await block.query('begin;select pg_advisory_xact_lock(99063,1)');
 await pool.query(`create function public.worker_insert_barrier() returns trigger language plpgsql as $$begin if new.candidate_id='${a.candidate}' and new.reason='engaged_backfill' then perform pg_advisory_xact_lock(99063,1);end if;return new;end$$;create trigger worker_insert_barrier before insert on refresh_queue for each row execute function public.worker_insert_barrier()`);
 try{const pending=lib.topUpCertifiedRefreshOnConnection(worker,{organizationId:org,limit:1});pending.catch(()=>{});await waitBlocked('ordinary_accept_worker');
  await pool.query('insert into refresh_queue(organization_id,candidate_id) values($1,$2)',[org,a.candidate]);await block.query('commit');
  assert.equal((await pending).inserted,0);assert.equal((await pool.query('select count(*)::int n from refresh_queue where candidate_id=$1',[a.candidate])).rows[0].n,1);
 }finally{await block.query('rollback');await worker.query('rollback');block.release();worker.release();await pool.query('drop trigger worker_insert_barrier on refresh_queue;drop function public.worker_insert_barrier()')}
});
test('concurrent top-ups acquire candidates in immutable order despite a timestamp change',async()=>{
 const people=[await fixture({cache:false,queue:false}),await fixture({cache:false,queue:false})].sort((a,b)=>a.candidate.localeCompare(b.candidate));const [a,b]=people;
 await phase('off');await pool.query("update candidates set updated_at=case when id=$1 then '2030-01-01'::timestamptz else '2020-01-01'::timestamptz end where id=any($2::uuid[])",[a.candidate,people.map(x=>x.candidate)]);
 const block=await pool.connect(),one=await topupClient('topup_order_one'),two=await topupClient('topup_order_two');await block.query('begin;select pg_advisory_xact_lock(99063,2)');
 await pool.query(`create function public.worker_order_barrier() returns trigger language plpgsql as $$begin if new.candidate_id='${a.candidate}' and current_setting('application_name')='topup_order_one' then perform pg_advisory_xact_lock(99063,2);end if;return new;end$$;create trigger worker_order_barrier before insert on refresh_queue for each row execute function public.worker_order_barrier()`);
 let first,second;try{first=lib.topUpCertifiedRefreshOnConnection(one,{organizationId:org,limit:2});first.catch(()=>{});await waitBlocked('topup_order_one');
  await pool.query("update candidates set updated_at='2040-01-01' where id=$1",[b.candidate]);second=lib.topUpCertifiedRefreshOnConnection(two,{organizationId:org,limit:2});second.catch(()=>{});await waitBlocked('topup_order_two');await block.query('commit');
  const results=await Promise.all([first,second]);assert.equal(results.reduce((n,x)=>n+x.inserted,0),2);
 }finally{await block.query('rollback');await Promise.allSettled([first,second].filter(Boolean));await one.query('rollback');await two.query('rollback');block.release();one.release();two.release();await pool.query('drop trigger worker_order_barrier on refresh_queue;drop function public.worker_order_barrier()')}
});
test('invalid identities and terminal reviews cannot fill the actionable window',async()=>{
 const invalid=[];for(let i=0;i<55;i++)invalid.push(await fixture({cache:true,username:'invalid!'+randomUUID()}));const valid=await fixture();await phase('off');await pool.query('update refresh_queue set priority=0 where id=any($1::uuid[])',[invalid.map(x=>x.queueId)]);await pool.query('update refresh_queue set priority=1 where id=$1',[valid.queueId]);await phase();
 const selected=await pick(1);assert.equal(selected.queued[0].queueId,valid.queueId);assert.ok(selected.review>=55);
});
test('future or wrong-operation caches never get free-first eligibility',async()=>{
 const wrong=await fixture();await phase('off');await pool.query("update candidate_enrichments set operation='summary' where id=$1",[wrong.ledger]);
 const future=await fixture();await phase('off');await pool.query("update candidate_enrichments set created_at=clock_timestamp()+interval '1 day' where id=$1",[future.ledger]);await phase();
 const selected=await pick(50);assert.ok(selected.queued.findIndex(x=>x.queueId===wrong.queueId)===-1||selected.queued[0].queueId!==wrong.queueId);assert.notEqual(selected.queued[0].queueId,future.queueId);
 assert.equal((await claim({...wrong,dailyCap:0})).status,'budget');assert.equal((await claim({...future,dailyCap:0})).status,'budget');
});
test('held recovery preserves the active owner and source exactly',async()=>{
 const a=await fixture();await claim(a);const before=(await pool.query('select to_jsonb(x) r from person_private.refresh_lifecycles x where request_id=$1',[a.requestId])).rows[0].r;
 await phase('held');assert.equal((await recover(a)).status,'held');assert.deepEqual((await pool.query('select to_jsonb(x) r from person_private.refresh_lifecycles x where request_id=$1',[a.requestId])).rows[0].r,before);
});
test('recovery checks expiry after a real queue row wait',async()=>{
 const a=await fixture();await pool.query("create function public.worker_expiring_claim() returns trigger language plpgsql as $$begin new.lease_until:=clock_timestamp()+interval '200 milliseconds';return new;end$$;create trigger worker_expiring_claim before insert on person_private.transition_work for each row execute function public.worker_expiring_claim()");
 try{await claim(a)}finally{await pool.query('drop trigger worker_expiring_claim on person_private.transition_work;drop function public.worker_expiring_claim()')}
 const block=await pool.connect(),worker=await topupClient('recovery_queue_wait');await block.query('begin');await block.query('select 1 from refresh_queue where id=$1 for update',[a.queueId]);
 try{const pending=lib.recoverCertifiedRefreshOnConnection(worker,a);pending.catch(()=>{});await waitBlocked('recovery_queue_wait');await new Promise(r=>setTimeout(r,240));await block.query('commit');assert.equal((await pending).status,'retry');}
 finally{await block.query('rollback');await worker.query('rollback');block.release();worker.release()}
 assert.equal((await pool.query('select phase from person_refresh_attempts where queue_id=$1',[a.queueId])).rows[0].phase,'ready');
});
test('top-up suppression cannot be mistaken for a concurrent queue acceptance',async()=>{
 const a=await fixture({cache:false,queue:false});await pool.query(`create function public.worker_suppress() returns trigger language plpgsql as $$begin if new.candidate_id='${a.candidate}' then return null;end if;return new;end$$;create trigger worker_suppress before insert on refresh_queue for each row execute function public.worker_suppress()`);
 try{await assert.rejects(use(c=>lib.topUpCertifiedRefreshOnConnection(c,{organizationId:org,limit:500})),/refresh_topup_actual/)}finally{await pool.query('drop trigger worker_suppress on refresh_queue;drop function public.worker_suppress()')}
 assert.equal((await pool.query('select count(*)::int n from refresh_queue where candidate_id=$1',[a.candidate])).rows[0].n,0);
});
test('private worker selection and recovery are unavailable to browser or REST service roles',async()=>{
 assert.equal((await pool.query("select bool_or(has_function_privilege(r.rolname,p.oid,'EXECUTE')) allowed from pg_roles r cross join pg_proc p where r.rolname in ('anon','authenticated','service_role') and p.pronamespace='person_private'::regnamespace and p.proname like 'refresh_worker_%'")).rows[0].allowed,false);
});
