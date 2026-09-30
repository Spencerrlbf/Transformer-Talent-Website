import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';import {randomUUID} from 'node:crypto';
const url=process.env.LOCAL_DATABASE_URL;
if(!/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_application_work_test$/.test(url||''))throw Error('local fixture database required');
const pool=new pg.Pool({connectionString:url,max:8});
const TT='801865a7-6533-41d2-9c45-e4a90e6ad51a',TENANT='cf000000-0000-4000-8000-000000000001';
const claim=async(a,token=randomUUID(),org=TT,c=pool,expected=null)=>(await c.query('select person_application_work_claim($1,$2,$3,$4,$5) r',[a,org,token,60,expected])).rows[0].r;
async function app(org=TT){const id=randomUUID();await pool.query("insert into website_applications(id,organization_id,name,email,linkedin_username,role_ids,preferred_locations,resume_path,person_resume_sha256,source,status) values($1,$2,'Synthetic applicant','synthetic@example.test','synthetic-app',ARRAY['job1'],ARRAY['London'],'synthetic/immutable.pdf',repeat('a',64),'website','queued')",[id,org]);return id;}
const count=async table=>(await pool.query(`select count(*)::int n from ${table}`)).rows[0].n;
const control=async action=>{const s=(await pool.query('select person_transition_status() r')).rows[0].r;return pool.query('select person_private.transition_set($1,$2,$3,$4)',[action,s.revision,s.generation,'synthetic_test']);};
test.after(()=>pool.end());
test.beforeEach(async t=>{
 if(t.name==='application admission exists before caller integration')return;
 await pool.query('truncate person_private.application_work,person_private.transition_work,person_private.transition_events,rate_limit_events,website_applications');
 await pool.query("update person_private.transition_control set enabled=false,phase='open',generation=1,revision=1;update organizations set daily_review_limit=300");
});
test('application admission exists before caller integration',async()=>assert.ok((await pool.query("select to_regprocedure('public.person_application_work_claim(uuid,uuid,uuid,integer,text)') p")).rows[0].p,'atomic application admission is absent'));
test('claim fixes input snapshot, organization and exactly one allowance event',async()=>{
 const id=await app(),token=randomUUID(),r=await claim(id,token);assert.equal(r.status,'admitted');assert.equal(r.snapshot.id,id);assert.equal(r.snapshot.organization_id,TT);assert.equal(r.snapshot.person_resume_sha256,'a'.repeat(64));assert.deepEqual(r.snapshot.role_ids,['job1']);assert.match(r.input_hash,/^[a-f0-9]{64}$/);
 assert.equal(await count('rate_limit_events'),1);assert.equal(await count('person_private.application_work'),1);assert.equal((await claim(id,token)).work_id,r.work_id);assert.equal(await count('rate_limit_events'),1);
});
test('concurrent first callbacks reserve one work and one review',async()=>{
 const id=await app(),r=await Promise.all([claim(id),claim(id)]);assert.deepEqual(r.map(x=>x.status).sort(),['admitted','busy']);assert.equal(await count('rate_limit_events'),1);assert.equal(await count('person_private.application_work'),1);
});
test('two applications competing for last allowance leave loser queued without work',async()=>{
 await pool.query('update organizations set daily_review_limit=1 where id=$1',[TT]);const a=await app(),b=await app(),r=await Promise.all([claim(a),claim(b)]);assert.deepEqual(r.map(x=>x.status).sort(),['admitted','budget']);assert.equal(await count('rate_limit_events'),1);assert.equal(await count('person_private.transition_work'),1);assert.equal((await pool.query("select count(*)::int n from website_applications where status='queued'")).rows[0].n,2);
});
test('legacy review events count toward allowance and expired events do not',async()=>{
 await pool.query('update organizations set daily_review_limit=1 where id=$1',[TT]);await pool.query('insert into rate_limit_events(bucket) values($1)',['review:'+TT]);const id=await app();assert.equal((await claim(id)).status,'budget');assert.equal(await count('person_private.transition_work'),0);
 await pool.query("update rate_limit_events set created_at=clock_timestamp()-interval '25 hours'");assert.equal((await claim(id)).status,'admitted');assert.equal(await count('rate_limit_events'),2);
});
test('zero or negative allowance never creates active work',async()=>{
 for(const allowance of [0,-1]){await pool.query('update organizations set daily_review_limit=$1 where id=$2',[allowance,TT]);assert.equal((await claim(await app())).status,'budget');}assert.equal(await count('rate_limit_events'),0);assert.equal(await count('person_private.transition_work'),0);
});
test('retry replays first inputs even after application outputs and preferences change',async()=>{
 const id=await app(),token=randomUUID(),r=await claim(id,token);
 await pool.query("update website_applications set name='Synthetic resolved name',role_ids=ARRAY['job2'],resume_path='synthetic/changed.pdf',person_resume_sha256=repeat('b',64),parsed_profile='{}',status='processed' where id=$1",[id]);
 const retry=await claim(id,token);assert.deepEqual(retry.snapshot,r.snapshot);assert.equal(retry.input_hash,r.input_hash);assert.equal(await count('rate_limit_events'),1);
 await assert.rejects(claim(id,token,TT,pool,'b'.repeat(64)),/application_input_changed/);
});
test('foreign organization cannot read snapshot or spend allowance',async()=>{
 const id=await app();await assert.rejects(claim(id,randomUUID(),TENANT),/application_scope/);assert.equal(await count('rate_limit_events'),0);
 const token=randomUUID();await claim(id,token);await assert.rejects(claim(id,token,TENANT),/application_scope/);
});
test('tenant claim and allowance continue independently while TT is held',async()=>{
 await control('arm');await control('drain');await control('seal');
 assert.equal((await claim(await app())).status,'held');assert.equal(await count('rate_limit_events'),0);
 const id=await app(TENANT),r=await claim(id,randomUUID(),TENANT);assert.equal(r.status,'admitted');assert.equal(r.snapshot.organization_id,TENANT);assert.equal((await pool.query('select scope from person_private.transition_work')).rows[0].scope,'tenant_application');
});
test('draining stops new reservations but allows an admitted owner to recover response',async()=>{
 await control('arm');const id=await app(),token=randomUUID(),r=await claim(id,token);await control('drain');assert.equal((await claim(id,token)).work_id,r.work_id);assert.equal((await claim(await app())).status,'draining');assert.equal(await count('rate_limit_events'),1);
});
test('expired and uncertain attempts keep original reservation and cannot spend again',async()=>{
 for(const kind of ['expired','uncertain']){
 const id=await app(),token=randomUUID(),r=await claim(id,token);
 if(kind==='expired')await pool.query("update person_private.transition_work set lease_until=clock_timestamp()-interval '1 second' where id=$1",[r.work_id]);else await pool.query("select person_transition_finish($1,$2,'uncertain')",[r.work_id,token]);
 assert.equal((await claim(id)).status,'unresolved');assert.equal((await claim(id,token)).status,'unresolved');
 }assert.equal(await count('rate_limit_events'),2);
});
test('existing nonqueued row cannot start paid work and rolls back provisional admission',async()=>{
 const id=await app();await pool.query("update website_applications set status='processed' where id=$1",[id]);assert.equal((await claim(id)).status,'ineligible');assert.equal(await count('person_private.transition_work'),0);assert.equal(await count('rate_limit_events'),0);
});
test('transaction rollback cannot leave a reservation without its snapshot or work',async()=>{
 const id=await app(),c=await pool.connect();try{await c.query('begin');assert.equal((await claim(id,randomUUID(),TT,c)).status,'admitted');await c.query('rollback');}finally{c.release();}
 assert.equal(await count('person_private.transition_work'),0);assert.equal(await count('person_private.application_work'),0);assert.equal(await count('rate_limit_events'),0);
});
test('completed work cannot consume another allowance or expose processing inputs',async()=>{
 const id=await app(),token=randomUUID(),r=await claim(id,token);await pool.query("select person_transition_finish($1,$2,'completed')",[r.work_id,token]);const retry=await claim(id);assert.equal(retry.status,'completed');assert.equal(retry.snapshot,undefined);assert.equal(await count('rate_limit_events'),1);
});
test('old transaction snapshots cannot bypass budget serialization',async()=>{
 const id=await app(),c=await pool.connect();try{await c.query('begin isolation level repeatable read');await assert.rejects(claim(id,randomUUID(),TT,c),/application_isolation/);}finally{await c.query('rollback');c.release();}
});
test('first expected input hash mismatch rolls back work and allowance',async()=>{
 const id=await app();await assert.rejects(claim(id,randomUUID(),TT,pool,'b'.repeat(64)),/application_input_changed/);assert.equal(await count('person_private.transition_work'),0);assert.equal(await count('rate_limit_events'),0);
});
test('private snapshot and controller remain inaccessible to public clients and service direct writes',async()=>{
 const id=await app(),c=await pool.connect();try{
 for(const role of ['anon','authenticated']){await c.query('begin');await c.query(`set local role ${role}`);await assert.rejects(claim(id,randomUUID(),TT,c),e=>e.code==='42501');await c.query('rollback');}
 await c.query('begin');await c.query('set local role service_role');assert.equal((await claim(id,randomUUID(),TT,c)).status,'admitted');await c.query('rollback');
 await c.query('begin');await c.query('set local role service_role');await assert.rejects(c.query('delete from person_private.application_work'),e=>e.code==='42501');await c.query('rollback');
 }finally{await c.query('rollback');c.release();}
});
for(const change of ['input','owner'])test(`concurrent ${change} change before row lock cannot freeze stale inputs`,async()=>{
 const id=await app(),a=await pool.connect(),b=await pool.connect();let pending;
 try{
  await a.query('begin');await a.query('select id from website_applications where id=$1 for update',[id]);
  const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
  pending=claim(id,randomUUID(),TT,b).then(result=>({result}),error=>({error}));
  const deadline=Date.now()+3000;let blocked=false;
  while(Date.now()<deadline){blocked=(await pool.query("select wait_event_type='Lock' blocked from pg_stat_activity where pid=$1",[pid])).rows[0]?.blocked;if(blocked)break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(blocked,true);
  if(change==='input')await a.query("update website_applications set role_ids=ARRAY['changed'] where id=$1",[id]);
  else await a.query('update website_applications set organization_id=$1 where id=$2',[TENANT,id]);
  await a.query('commit');const result=await pending;assert.match(result.error?.message||'',change==='input'?/application_input_changed/:/application_scope/);
  assert.equal(await count('rate_limit_events'),0);assert.equal(await count('person_private.transition_work'),0);
 }finally{await a.query('rollback');if(pending)await pending;a.release();b.release();}
});
for(const kind of ['completed','uncertain','busy'])test(`generic ${kind} claim without application reservation is not application evidence`,async()=>{
 const id=await app(),token=randomUUID();
 const c=await pool.connect();let h;
 try{await c.query('begin');await c.query("set local timezone='UTC'");h=(await c.query("select encode(sha256(convert_to(person_private.application_work_input(to_jsonb(a))::text,'UTF8')),'hex') h from website_applications a where id=$1",[id])).rows[0].h;}finally{await c.query('rollback');c.release();}
 const work=(await pool.query("select person_transition_claim('tt_person',$1,'application',$2,$3,$4,60) r",[TT,id,h,token])).rows[0].r;
 if(kind!=='busy')await pool.query("select person_transition_finish($1,$2,$3)",[work.work_id,token,kind]);
 await assert.rejects(claim(id),/application_work_proof/);assert.equal(await count('rate_limit_events'),0);
});

test('a stored resume without a content witness stays queued without being charged',async()=>{
 const id=await app();await pool.query('update website_applications set person_resume_sha256=null where id=$1',[id]);
 assert.equal((await claim(id)).status,'input_review');assert.equal(await count('person_private.transition_work'),0);assert.equal(await count('rate_limit_events'),0);
});
test('an application without a resume does not require a file witness',async()=>{
 const id=await app();await pool.query('update website_applications set resume_path=null,person_resume_sha256=null where id=$1',[id]);assert.equal((await claim(id)).status,'admitted');
});

for(const path of [null,''])test(`a resume witness without its object path (${path===null?'null':'blank'}) is held before reservation`,async()=>{
 const id=await app();await pool.query('update website_applications set resume_path=$1 where id=$2',[path,id]);assert.equal((await claim(id)).status,'input_review');assert.equal(await count('person_private.transition_work'),0);assert.equal(await count('rate_limit_events'),0);
});
