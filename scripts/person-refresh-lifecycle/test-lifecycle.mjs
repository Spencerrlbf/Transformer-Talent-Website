import test from 'node:test';import assert from 'node:assert/strict';import{randomUUID}from'node:crypto';import pg from'pg';
import*as lib from'../dist/worker-lib.mjs';
const url=process.env.LOCAL_DATABASE_URL;if(!/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_refresh_lifecycle_test$/.test(url??''))throw Error('local_fixture_required');
const pool=new pg.Pool({connectionString:url,max:8});const org=lib.TT_ORG_ID;
const raw={headline:'Synthetic refreshed profile',experience:[]};
const phase=(enabled=true,phase='open')=>pool.query('update person_private.transition_control set enabled=$1,phase=$2 where singleton',[enabled,phase]);
async function use(fn){const c=await pool.connect();try{return await fn(c)}finally{await c.query('rollback');c.release()}}
async function fixture({cache=true,cacheExtra={},name}={}){
 await phase(false);const candidate=randomUUID(),queue=randomUUID(),username=name??'refresh-'+candidate,ledger=randomUUID();
 await pool.query("insert into candidates(id,full_name,linkedin_username,created_at) values($1,'Synthetic Refresh',$2,'2020-01-01')",[candidate,username]);
 await pool.query('select save_person($1::jsonb)',[lib.fromLegacyImport({id:candidate,full_name:'Synthetic Refresh',linkedin_username:username,created_at:'2020-01-01'},[],[],[])]);
 await pool.query('insert into refresh_queue(id,organization_id,candidate_id) values($1,$2,$3)',[queue,org,candidate]);
 if(cache)await pool.query("insert into candidate_enrichments select (jsonb_populate_record(null::candidate_enrichments,$1)).*",[{id:ledger,candidate_id:candidate,organization_id:org,linkedin_username:username,provider:'harvest',operation:'full_profile',status:'ok',cache_status:'miss',raw_payload:raw,cost_credits:0,normalized_profile:null,created_at:new Date(Date.now()-86400000).toISOString(),...cacheExtra}]);
 await phase();return{organizationId:org,queueId:queue,requestId:randomUUID(),token:randomUUID(),dailyCap:1000,allowPaid:true,candidate,ledger,username};
}
const claim=a=>use(c=>lib.claimCertifiedRefreshOnConnection(c,a));
const start=a=>use(c=>lib.startCertifiedRefreshProviderOnConnection(c,a));
const store=a=>use(c=>lib.storeCertifiedRefreshPayloadOnConnection(c,{...a,raw}));
const fail=a=>use(c=>lib.failCertifiedRefreshOnConnection(c,a));
test.beforeEach(()=>{process.env.PERSON_TRANSITION_SUPPORT='on'});
test.after(async()=>{delete process.env.PERSON_TRANSITION_SUPPORT;await pool.end()});
test('cached claim is replayable, retains source date and gets no paid reservation',async()=>{
 const a=await fixture();const first=await claim({...a,dailyCap:0});assert.equal(first.status,'claimed');assert.equal(first.needsHarvest,false);
 assert.deepEqual(await claim({...a,dailyCap:0}),first);
 const r=(await pool.query('select * from person_refresh_attempts where queue_id=$1',[a.queueId])).rows[0];assert.equal(r.attempts,1);assert.equal(r.ledger_snapshot.id,a.ledger);assert.equal(r.paid_requested_at,null);
 await fail(a);const next=await claim({...a,requestId:randomUUID(),token:randomUUID(),dailyCap:0});assert.equal(next.status,'claimed');assert.equal(next.needsHarvest,false);
 const later=(await pool.query('select ledger_snapshot,attempts from person_refresh_attempts where queue_id=$1',[a.queueId])).rows[0];assert.deepEqual(later.ledger_snapshot,r.ledger_snapshot);assert.equal(later.attempts,2);
});
test('paid provider is authorized once, failed response remains unresolved, and late payload permits free retry',async()=>{
 const a=await fixture({cache:false});const first=await claim(a);assert.equal(first.needsHarvest,true);
 assert.equal((await start(a)).status,'start');assert.equal((await start(a)).status,'uncertain');
 await fail(a);await phase(true,'draining');const received=await store(a);assert.equal(received.status,'retry');
 const row=(await pool.query('select * from person_refresh_attempts where queue_id=$1',[a.queueId])).rows[0];assert.equal(row.phase,'ready');assert.ok(row.ledger_snapshot);assert.equal(row.paid_token,a.token);
 assert.deepEqual(await store(a),received);await phase();
 const next=await claim({...a,requestId:randomUUID(),token:randomUUID(),dailyCap:0});assert.equal(next.needsHarvest,false);
 assert.equal((await pool.query('select count(*)::int n from candidate_enrichments where candidate_id=$1',[a.candidate])).rows[0].n,1);
});
test('budget denial leaves no work, claim or attempt behind',async()=>{
 const a=await fixture({cache:false});assert.equal((await claim({...a,dailyCap:0})).status,'budget');
 assert.equal((await pool.query('select count(*)::int n from person_refresh_attempts where queue_id=$1',[a.queueId])).rows[0].n,0);
 assert.equal((await pool.query("select count(*)::int n from person_private.transition_work where resource_key=$1",['refresh:'+a.requestId])).rows[0].n,0);
});
test('draining accepts pristine queue inserts but refuses new claims and raw completion',async()=>{
 const a=await fixture();await phase(true,'draining');await assert.rejects(claim(a),/refresh_held/);
 const q=randomUUID();await pool.query('insert into refresh_queue(id,organization_id,candidate_id) values($1,$2,$3)',[q,org,randomUUID()]).then(()=>assert.fail('orphan accepted'),e=>assert.match(e.message,/refresh_queue_input/));
 await assert.rejects(pool.query("update refresh_queue set status='done' where id=$1",[a.queueId]),/refresh_write_frame/);
});
test('claimed paid work cannot use generic finish to hide an unknown provider outcome',async()=>{
 const a=await fixture({cache:false});const r=await claim(a);await start(a);
 await assert.rejects(pool.query("select person_private.transition_finish($1,$2,'completed')",[r.workId,a.token]),/refresh_work_proof/);
});

for(const support of ['off','bad'])test(`certified APIs reject ${support} before a query or pool`,async()=>{
 process.env.PERSON_TRANSITION_SUPPORT=support;const a={organizationId:org,queueId:randomUUID(),requestId:randomUUID(),token:randomUUID(),dailyCap:0,allowPaid:false,raw};
 for(const name of ['claimCertifiedRefresh','startCertifiedRefreshProvider','storeCertifiedRefreshPayload','failCertifiedRefresh']){
  await assert.rejects(async()=>lib[name+'OnConnection']({query:()=>assert.fail('query executed')},a),/refresh_lifecycle_disabled|transition_configuration/);
  await assert.rejects(async()=>lib[name](a),/refresh_lifecycle_disabled|transition_configuration/);
 }
});
test('same request and competing queue concurrent claims reserve once',async()=>{
 const a=await fixture({cache:false});const same=await Promise.all([claim(a),claim(a)]);assert.deepEqual(same[0],same[1]);
 // The same queue, another request cannot replace live ownership.
 assert.equal((await claim({...a,requestId:randomUUID(),token:randomUUID()})).status,'busy');
 assert.equal((await pool.query('select attempts from person_refresh_attempts where queue_id=$1',[a.queueId])).rows[0].attempts,1);
});
test('future, wrong-operation, wrong-owner and failed caches never authorize free work',async()=>{
 for(const patch of [{created_at:new Date(Date.now()+86400000).toISOString()},{operation:'summary'},{organization_id:'b0000000-0000-4000-8000-000000000999'},{status:'error'},{cache_status:'hit'},{raw_payload:null},{linkedin_username:'different'},{created_at:new Date(Date.now()-31*86400000).toISOString()}]){
  const a=await fixture({cacheExtra:patch});
  const r=await claim({...a,dailyCap:0,allowPaid:false});assert.equal(r.status,'review');assert.equal(r.reason,patch.cache_status==='hit'?'source_hold':'cached_source_missing');
 }
});
test('owned attempts, queues and selected sources remain protected with controller off',async()=>{
 const a=await fixture();await claim(a);await phase(false);
 for(const [sql,args] of [["update refresh_queue set organization_id=$2 where id=$1",[a.queueId,randomUUID()]],["delete from refresh_queue where id=$1",[a.queueId]],["update person_refresh_attempts set phase='done' where queue_id=$1",[a.queueId]],["update candidate_enrichments set raw_payload='{}' where id=$1",[a.ledger]]])await assert.rejects(pool.query(sql,args),/refresh_write_frame|refresh_source_owned/);
});
test('generic refresh admission is refused and preexisting work is never adopted',async()=>{
 const a=await fixture();await assert.rejects(pool.query("select person_transition_claim('tt_person',$1,'refresh',$2,repeat('a',64),$3,600)",[org,'refresh:'+a.requestId,a.token]),/refresh_admission_required/);
 // Owner-only fixture simulates historical generic work, including completed.
 await pool.query("insert into person_private.transition_work(organization_id,scope,family,resource_key,input_hash,token_hash,generation,lease_until,status) select $1,'tt_person','refresh',$2,repeat('a',64),md5($3),generation,clock_timestamp()+interval '5 minutes','completed' from person_private.transition_control where singleton",[org,'refresh:'+a.requestId,a.token]);
 await assert.rejects(claim(a),/refresh_admission/);
 assert.equal((await pool.query('select count(*)::int n from person_refresh_attempts where queue_id=$1',[a.queueId])).rows[0].n,0);
});
test('paid capture needs committed start, rejects wrong token, and preserves immutable first payload',async()=>{
 const a=await fixture({cache:false});await claim(a);await assert.rejects(store(a),/refresh_paid_token/);await assert.rejects(start({...a,token:randomUUID()}),/refresh_binding/);
 await start(a);const result=await store(a);assert.equal(result.status,'stored');await fail(a);
 assert.deepEqual(await store(a),result);
 await assert.rejects(use(c=>lib.storeCertifiedRefreshPayloadOnConnection(c,{...a,raw:{headline:'Different synthetic payload'}})),/refresh_payload_changed/);
 const e=(await pool.query('select provider_started_at,source_snapshot from person_private.refresh_lifecycles where request_id=$1',[a.requestId])).rows[0];assert.equal(Date.parse(e.source_snapshot.created_at),e.provider_started_at.getTime());
});
test('failure before provider start releases only the unused reservation',async()=>{
 const a=await fixture({cache:false});const r=await claim(a);const result=await fail(a);assert.equal(result.status,'retry');assert.deepEqual(await fail(a),result);
 const row=(await pool.query('select paid_token,paid_requested_at from person_refresh_attempts where queue_id=$1',[a.queueId])).rows[0];assert.equal(row.paid_token,null);assert.equal(row.paid_requested_at,null);
 assert.equal((await pool.query('select status from person_private.transition_work where id=$1',[r.workId])).rows[0].status,'completed');await assert.rejects(store(a),/refresh_paid_token/);
});
test('late recovery and terminal archival retain both histories and old payload replay',async()=>{
 const a=await fixture({cache:false});await claim(a);await start(a);await fail(a);const result=await store(a);
 const queue=randomUUID();await pool.query('insert into refresh_queue(id,organization_id,candidate_id) values($1,$2,$3)',[queue,org,a.candidate]);
 const b={...a,queueId:queue,requestId:randomUUID(),token:randomUUID(),dailyCap:0};assert.equal((await claim(b)).needsHarvest,false);await fail(b);
 assert.match((await pool.query('select status from refresh_queue where id=$1',[a.queueId])).rows[0].status,/^archived_/);
 const history=(await pool.query('select previous_queue_rows from person_refresh_attempts where queue_id=$1',[queue])).rows[0].previous_queue_rows;assert.equal(history[0].id,a.queueId);
 assert.deepEqual(await store(a),result);await assert.rejects(use(c=>lib.storeCertifiedRefreshPayloadOnConnection(c,{...a,raw:{headline:'Wrong'}})),/refresh_payload_changed/);
});
test('three free attempts are retained across new processing UUIDs',async()=>{
 const a=await fixture();for(let i=0;i<3;i++){const next={...a,requestId:randomUUID(),token:randomUUID()};assert.equal((await claim(next)).status,'claimed');await fail(next);}
 const r=await claim(a);assert.equal(r.status,'review');assert.equal(r.reason,'attempt_limit');
});
async function fault(table,event,body,fn){
 await pool.query(`create function public.refresh_test_fault() returns trigger language plpgsql as $fault$ begin ${body} end $fault$;create trigger zz_refresh_test_fault ${event} on ${table} for each row execute function public.refresh_test_fault()`);
 try{return await fn()}finally{await pool.query(`drop trigger zz_refresh_test_fault on ${table};drop function public.refresh_test_fault()`)}
}
for(const body of ['return null;','new.provider_started_at:=null;return new;'])test('suppressed or altered start marker cannot authorize provider: '+body,async()=>{
 const a=await fixture({cache:false});await claim(a);
 await fault('person_private.refresh_lifecycles','before update',body,()=>assert.rejects(start(a),/refresh_private_actual/));
 assert.equal((await start(a)).status,'start');
});
for(const table of ['public.person_refresh_attempts','person_private.refresh_heads','person_private.refresh_lifecycles'])test('suppressed claim insert rolls back admission: '+table,async()=>{
 const a=await fixture();await fault(table,'before insert','return null;',()=>assert.rejects(claim(a),/refresh_write_actual|refresh_head_actual|refresh_private_actual/));
 assert.equal((await pool.query("select count(*)::int n from person_private.transition_work where resource_key=$1",['refresh:'+a.requestId])).rows[0].n,0);
});
test('suppressed source insertion rolls back the attempted payload capture',async()=>{
 const a=await fixture({cache:false});await claim(a);await start(a);
 await fault('public.candidate_enrichments','before insert','return null;',()=>assert.rejects(store(a),/refresh_write_actual/));
 assert.equal((await pool.query('select source_snapshot from person_private.refresh_lifecycles where request_id=$1',[a.requestId])).rows[0].source_snapshot,null);
 assert.equal((await store(a)).status,'stored');
});
test('partial checked queue mutation cannot commit without updating its receipt',async()=>{
 const a=await fixture();await claim(a);
 await assert.rejects(use(async c=>{await c.query('begin');await c.query("select person_private.refresh_enter($1,$2,$3,$4)",[org,a.requestId,a.queueId,a.token]);await c.query("select person_private.refresh_write($1,'refresh_queue',expected_queue,expected_queue||'{\"status\":\"patch_failed\"}'::jsonb) from person_private.refresh_lifecycles where request_id=$1",[a.requestId]);await c.query('commit')}),/refresh_public_changed/);
 assert.equal((await pool.query('select status from refresh_queue where id=$1',[a.queueId])).rows[0].status,'queued');
});
test('browser and service roles cannot call private refresh writers or mint frames',async()=>{
 const r=await pool.query("select bool_or(has_function_privilege(r.rolname,p.oid,'EXECUTE')) allowed from pg_roles r cross join pg_proc p where r.rolname in ('anon','authenticated','service_role') and p.pronamespace='person_private'::regnamespace and p.proname like 'refresh_%'");assert.equal(r.rows[0].allowed,false);
});
test('Unicode usernames keep encoded canonical provider URLs',async()=>{
 const a=await fixture({cache:false,name:'réf-'+randomUUID()+'\u0301'});const r=await claim(a);assert.equal(r.linkedinUrl,'https://www.linkedin.com/in/'+encodeURIComponent(a.username));assert.deepEqual(await start(a),{status:'start',linkedinUrl:r.linkedinUrl});
});
test('two different queue rows for the same person cannot be claimed concurrently',async()=>{
 const a=await fixture();await phase(false);await pool.query("update refresh_queue set status='patch_failed' where id=$1",[a.queueId]);const q=randomUUID();await pool.query('insert into refresh_queue(id,organization_id,candidate_id) values($1,$2,$3)',[q,org,a.candidate]);await phase();
 const results=await Promise.all([claim(a),claim({...a,queueId:q,requestId:randomUUID(),token:randomUUID()})]);assert.deepEqual(results.map(x=>x.status).sort(),['busy','claimed']);
});
test('source lock wait rechecks the actual lease before issuing any permission',async()=>{
 const a=await fixture();const blocker=await pool.connect();await blocker.query('begin');await blocker.query('select 1 from candidate_enrichments where id=$1 for update',[a.ledger]);
 let waiting;
 try{
  await fault('person_private.transition_work','before insert',"new.lease_until:=clock_timestamp()+interval '100 milliseconds';return new;",async()=>{
   const pending=claim(a);pending.catch(()=>{});waiting=new Promise(r=>setTimeout(r,250));await waiting;await blocker.query('commit');await assert.rejects(pending,/refresh_expired/);
  });
 }finally{await blocker.query('rollback');blocker.release()}
 assert.equal((await pool.query('select count(*)::int n from person_refresh_attempts where queue_id=$1',[a.queueId])).rows[0].n,0);
});
test('payload insertion crossing its lease becomes a free retry after a real candidate lock wait',async()=>{
 const a=await fixture({cache:false});let r;
 await fault('person_private.transition_work','before insert',"new.lease_until:=clock_timestamp()+interval '180 milliseconds';return new;",async()=>{r=await claim(a)});await start(a);
 const blocker=await pool.connect();await blocker.query('begin');await blocker.query('select 1 from candidates where id=$1 for update',[a.candidate]);
 try{const pending=store(a);pending.catch(()=>{});await new Promise(r=>setTimeout(r,260));await blocker.query('commit');assert.equal((await pending).status,'retry');}
 finally{await blocker.query('rollback');blocker.release()}
 const w=(await pool.query('select status from person_private.transition_work where id=$1',[r.workId])).rows[0];assert.equal(w.status,'completed');
 const next=await claim({...a,requestId:randomUUID(),token:randomUUID(),dailyCap:0});assert.equal(next.status,'claimed');assert.equal(next.needsHarvest,false);
});
for(const body of ["update person_private.refresh_lifecycles set seal_hash=repeat('0',64) where request_id=new.request_id;return null;", "update person_private.refresh_heads set request_id=(select request_id from person_private.refresh_lifecycles where queue_id<>new.queue_id limit 1) where queue_id=new.queue_id;return null;"])test('late private corruption at commit rejects claim: '+body.slice(0,50),async()=>{
 const a=await fixture();
 // Constraint trigger runs after synchronous API checks, before the normal
 // deferred completeness trigger; any evidence mismatch must abort COMMIT.
 await pool.query(`create function public.refresh_test_deferred_fault() returns trigger language plpgsql as $fault$ begin ${body} end $fault$;create constraint trigger aa_refresh_test_fault after insert on person_private.refresh_lifecycles deferrable initially deferred for each row execute function public.refresh_test_deferred_fault()`);
 try{await assert.rejects(claim(a),/refresh_head_proof|duplicate key/)}finally{await pool.query('drop trigger aa_refresh_test_fault on person_private.refresh_lifecycles;drop function public.refresh_test_deferred_fault()')}
 assert.equal((await pool.query('select count(*)::int n from person_refresh_attempts where queue_id=$1',[a.queueId])).rows[0].n,0);
});
test('paid-source completion lookup has a matching expression index',async()=>{
 const r=await use(async c=>{await c.query('begin');await c.query('set local enable_seqscan=off');return c.query("explain(format json) select * from person_private.refresh_lifecycles where expected_attempt->>'ledger_id'=$1 and paid and provider_started_at is not null",[randomUUID()])});
 assert.match(JSON.stringify(r.rows),/refresh_paid_ledger/);
});
test('claim key, tenant and replay option substitutions cannot change ownership',async()=>{
 const a=await fixture();await claim(a);
 for(const patch of [{organizationId:randomUUID()},{token:randomUUID()},{queueId:randomUUID()},{dailyCap:1},{allowPaid:false}])await assert.rejects(claim({...a,...patch}),/refresh_input|refresh_binding/);
});
test('empty provider responses remain uncertain instead of becoming cached success',async()=>{
 for(const invalid of [{headline:''},{headline:false},{headline:0},{experience:null}]){
  const a=await fixture({cache:false});await claim(a);await start(a);
  await assert.rejects(use(c=>lib.storeCertifiedRefreshPayloadOnConnection(c,{...a,raw:invalid})),/refresh_empty_payload/);
  await assert.rejects(pool.query('select person_private.refresh_store_payload($1,$2,$3,$4,$5)',[org,a.requestId,a.queueId,a.token,invalid]),/refresh_empty_payload/);
  assert.equal((await fail(a)).status,'uncertain');
  assert.equal((await pool.query('select count(*)::int n from candidate_enrichments where candidate_id=$1',[a.candidate])).rows[0].n,0);
 }
});
test('application Harvest ownership still works through the shared enrichment fence',async()=>{
 const username='application-'+randomUUID(),token=randomUUID();await phase();
 const app=(await pool.query("select person_application_accept('apply',$1) r",[{organization_id:org,name:'Synthetic',email:'synthetic@example.test',linkedin_username:username,linkedin_url:'https://www.linkedin.com/in/'+username,role_ids:[],role_titles:[],preferred_locations:[]}])).rows[0].r;
 const work=(await pool.query('select person_application_work_claim($1,$2,$3,900) r',[app.id,org,token])).rows[0].r;assert.equal(work.status,'admitted');await pool.query('select person_application_work_start($1,$2)',[work.work_id,token]);
 async function save(){return use(async c=>{await c.query('begin');await c.query("select set_config('request.headers',$1,true)",[JSON.stringify({'x-person-work-id':work.work_id,'x-person-work-token':token})]);const r=(await c.query('select person_application_harvest_store($1) r',[raw])).rows[0].r;await c.query('commit');return r})}
 const first=await save();assert.deepEqual(await save(),first);assert.ok(first.id);
});
