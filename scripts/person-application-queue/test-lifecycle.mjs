import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
const url=process.env.LOCAL_DATABASE_URL;
if(!/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_application_queue_test$/.test(url||''))throw Error('local fixture required');
const pool=new pg.Pool({connectionString:url,max:8});
const TT='801865a7-6533-41d2-9c45-e4a90e6ad51a',TENANT='cf000000-0000-4000-8000-000000000001';
const claim=async(a,token=randomUUID(),org=TT,c=pool)=>(await c.query('select person_application_work_claim($1,$2,$3,60) r',[a,org,token])).rows[0].r;
async function app(org=TT){const id=randomUUID();await pool.query("insert into website_applications(id,organization_id,name,email,linkedin_username,status,person_processing_version) values($1,$2,'Synthetic queue','synthetic@example.test','synthetic-queue','queued',1)",[id,org]);return id;}
const expire=async id=>pool.query("update person_private.transition_work set lease_until=clock_timestamp()-interval '1 second' where id=$1",[id]);
const control=async action=>{const s=(await pool.query('select person_transition_status() r')).rows[0].r;return(await pool.query('select person_private.transition_set($1,$2,$3,$4) r',[action,s.revision,s.generation,'synthetic_test'])).rows[0].r;};
const assertion=async(id,token,application,c=pool)=>{
 const client=c===pool?await pool.connect():c;
 try{await client.query('begin');await client.query("select set_config('person.work_id',$1,true),set_config('person.work_token',$2,true)",[id,token]);return await client.query("select person_transition_assert('tt_person',$1,'application',$2)",[TT,application]);}
 finally{await client.query('rollback');if(c===pool)client.release();}
};
test.after(()=>pool.end());
test.beforeEach(async()=>{
 await pool.query('truncate person_private.application_work_owners,person_private.application_work,person_private.transition_work,person_private.transition_events,rate_limit_events,website_applications');
 await pool.query("update person_private.transition_control set enabled=false,phase='open',generation=1,revision=1;update organizations set daily_review_limit=300");
});
test('pre-effects application token cannot authorize a processing write',async()=>{
 const a=await app(),token=randomUUID(),w=await claim(a,token);
 await assert.rejects(assertion(w.work_id,token,a),/application_effects_required/);
});
test('generic finish cannot bypass application completion proof',async()=>{
 const a=await app(),token=randomUUID(),w=await claim(a,token);
 for(const fn of ['public.person_transition_finish','person_private.transition_finish'])
  await assert.rejects(pool.query(`select ${fn}($1,$2,'completed')`,[w.work_id,token]),/application_work_required/);
});
test('expired pre-effects claim rotates ownership with the same snapshot and allowance',async()=>{
 const a=await app(),old=randomUUID(),first=await claim(a,old);await expire(first.work_id);
 const token=randomUUID(),second=await claim(a,token);
 assert.equal(second.status,'admitted');assert.equal(second.work_id,first.work_id);assert.deepEqual(second.snapshot,first.snapshot);
 assert.equal((await pool.query('select count(*)::int n from rate_limit_events')).rows[0].n,1);
 assert.equal((await claim(a,old)).status,'busy');
});
const start=async(w,token,c=pool)=>(await c.query('select person_application_work_start($1,$2) r',[w,token])).rows[0].r;
const defer=async(w,token,c=pool)=>(await c.query('select person_application_work_defer($1,$2,1) r',[w,token])).rows[0].r;
test('effects start grants permission once, and enables only the owned assertion',async()=>{
 const a=await app(),token=randomUUID(),w=await claim(a,token);
 assert.equal((await start(w.work_id,token)).status,'started');
 await assertion(w.work_id,token,a);
 assert.equal((await start(w.work_id,token)).status,'already_started');
 await assert.rejects(defer(w.work_id,token),/application_effects_started/);
});
test('lost effects-start response and expiry cannot authorize automatic paid replay',async()=>{
 const a=await app(),token=randomUUID(),w=await claim(a,token);await start(w.work_id,token);await expire(w.work_id);
 assert.equal((await claim(a)).status,'unresolved');assert.equal((await claim(a,token)).status,'unresolved');
 assert.equal((await pool.query('select count(*)::int n from rate_limit_events')).rows[0].n,1);
});
test('expired untouched work retires during drain and resumes after seal/reopen',async()=>{
 await control('arm');const a=await app(),old=randomUUID(),w=await claim(a,old);await expire(w.work_id);await control('drain');
 assert.equal((await claim(a)).status,'unresolved');
 assert.equal((await pool.query('select status from person_private.transition_work where id=$1',[w.work_id])).rows[0].status,'deferred');
 assert.equal((await control('seal')).phase,'held');await control('reopen');
 const next=await claim(a);assert.equal(next.status,'admitted');assert.equal(next.work_id,w.work_id);
 await assert.rejects(start(w.work_id,old),/transition_admission/);
 assert.equal((await pool.query('select count(*)::int n from rate_limit_events')).rows[0].n,1);
});
test('deferred owner cannot write, renew or finish, and two reclaimers have one winner',async()=>{
 const a=await app(),old=randomUUID(),w=await claim(a,old);assert.equal((await defer(w.work_id,old)).status,'deferred');
 await assert.rejects(assertion(w.work_id,old,a),/transition_admission/);
 await assert.rejects(pool.query('select person_transition_renew($1,$2,60)',[w.work_id,old]),/transition_admission|transition_expired/);
 await assert.rejects(pool.query("select person_transition_finish($1,$2,'completed')",[w.work_id,old]),/transition_admission|transition_expired/);
 assert.equal((await claim(a)).status,'unresolved','retry delay must be honored');
 await pool.query("update person_private.application_work set retry_after=clock_timestamp()-interval '1 second' where work_id=$1",[w.work_id]);
 const r=await Promise.all([claim(a),claim(a)]);assert.deepEqual(r.map(x=>x.status).sort(),['admitted','busy']);
});
test('start and defer serialize so only one can win',async()=>{
 const a=await app(),token=randomUUID(),w=await claim(a,token);
 const r=await Promise.allSettled([start(w.work_id,token),defer(w.work_id,token)]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
 const row=(await pool.query('select w.status,a.effects_started_at from person_private.transition_work w join person_private.application_work a on a.work_id=w.id where w.id=$1',[w.work_id])).rows[0];
 assert.ok((row.status==='active'&&row.effects_started_at)||(row.status==='deferred'&&row.effects_started_at===null));
});
test('service generic claim cannot create application work or call the claim core',async()=>{
 const a=await app(),c=await pool.connect();try{
 await c.query('begin');await c.query('set local role service_role');
 await assert.rejects(c.query("select person_transition_claim('tt_person',$1,'application',$2,$3,$4,60)",[TT,a,'a'.repeat(64),randomUUID()]),/application_work_required/);await c.query('rollback');
 await c.query('begin');await c.query('set local role service_role');
 await assert.rejects(c.query("select person_private.transition_claim('tt_person',$1,'application',$2,$3,$4,60)",[TT,a,'a'.repeat(64),randomUUID()]),e=>e.code==='42501');
 }finally{await c.query('rollback');c.release();}
});
test('effects-start rechecks the current application organization after claim',async()=>{
 const a=await app(),token=randomUUID(),w=await claim(a,token);await pool.query('update website_applications set organization_id=$1 where id=$2',[TENANT,a]);
 await assert.rejects(start(w.work_id,token),/application_scope/);
});
const finish=async(w,token,outcome,c=pool)=>(await c.query('select person_application_work_finish($1,$2,$3) r',[w,token,outcome])).rows[0].r;
test('application completion requires effects and final persisted source status',async()=>{
 const a=await app(TENANT),token=randomUUID(),w=await claim(a,token,TENANT);
 await assert.rejects(finish(w.work_id,token,'completed'),/application_effects_required/);
 await start(w.work_id,token);await assert.rejects(finish(w.work_id,token,'completed'),/application_completion_required/);
 await pool.query("update website_applications set status='processed' where id=$1",[a]);
 assert.equal((await finish(w.work_id,token,'completed')).status,'completed');assert.equal((await finish(w.work_id,token,'completed')).status,'completed');
});
test('post-effects failure is unresolved and cannot be deferred or reclaimed',async()=>{
 const a=await app(),token=randomUUID(),w=await claim(a,token);await start(w.work_id,token);
 assert.equal((await finish(w.work_id,token,'uncertain')).status,'uncertain');assert.equal((await claim(a)).status,'unresolved');
 await assert.rejects(defer(w.work_id,token),/transition_unresolved/);
});
test('service can claim and start through application APIs with generic core revoked',async()=>{
 const a=await app(),token=randomUUID(),c=await pool.connect();try{
 await c.query('begin');await c.query('set local role service_role');const w=await claim(a,token,TT,c);assert.equal((await start(w.work_id,token,c)).status,'started');await c.query('rollback');
 }finally{await c.query('rollback');c.release();}
});
test('start paused behind an expiring work lock cannot use the reclaimed token',async()=>{
 const a=await app(),old=randomUUID(),w=await claim(a,old),blocker=await pool.connect(),oldOwner=await pool.connect(),newOwner=await pool.connect();let starting,reclaiming;
 try{
 await blocker.query('begin');await blocker.query('select id from person_private.transition_work where id=$1 for update',[w.work_id]);await blocker.query("update person_private.transition_work set lease_until=clock_timestamp()-interval '1 second' where id=$1",[w.work_id]);
 const pids=[(await oldOwner.query('select pg_backend_pid() pid')).rows[0].pid,(await newOwner.query('select pg_backend_pid() pid')).rows[0].pid];
 starting=start(w.work_id,old,oldOwner).then(value=>({value}),error=>({error}));reclaiming=claim(a,randomUUID(),TT,newOwner).then(value=>({value}),error=>({error}));
 let blocked=0;const deadline=Date.now()+3000;while(Date.now()<deadline){blocked=(await pool.query("select count(*)::int n from pg_stat_activity where pid=any($1::int[]) and wait_event_type='Lock'",[pids])).rows[0].n;if(blocked===2)break;await new Promise(r=>setTimeout(r,5));}assert.equal(blocked,2,'both operations must actually wait behind the work lock');
 await blocker.query('commit');const [s,r]=await Promise.all([starting,reclaiming]);assert.match(s.error?.message||'',/transition_expired|transition_admission/);assert.equal(r.value?.status,'admitted');
 }finally{await blocker.query('rollback');if(starting)await starting;if(reclaiming)await reclaiming;blocker.release();oldOwner.release();newOwner.release();}
});
test('TT processed status without its candidate intake receipt cannot complete',async()=>{
 const a=await app(),token=randomUUID(),w=await claim(a,token);await start(w.work_id,token);await pool.query("update website_applications set status='processed' where id=$1",[a]);
 await assert.rejects(finish(w.work_id,token,'completed'),/application_receipt_required/);
 assert.equal((await pool.query('select status from person_private.transition_work where id=$1',[w.work_id])).rows[0].status,'active');
});
for(const state of ['expired','deferred'])test(`${state} claim cannot reuse any previous owner token`,async()=>{
 const a=await app(),old=randomUUID(),w=await claim(a,old);
 if(state==='expired')await expire(w.work_id);else{await defer(w.work_id,old);await pool.query("update person_private.application_work set retry_after=clock_timestamp()-interval '1 second' where work_id=$1",[w.work_id]);}
 assert.equal((await claim(a,old)).status,'unresolved','same token cannot resurrect a paused process');
 const second=randomUUID();assert.equal((await claim(a,second)).status,'admitted');await expire(w.work_id);
 assert.equal((await claim(a,old)).status,'unresolved','an earlier-generation token cannot be reused either');
 assert.equal((await claim(a,randomUUID())).status,'admitted');
});
test('lease expiring behind the final application lock cannot grant effects-start',async()=>{
 const a=await app(),token=randomUUID(),w=await claim(a,token),blocker=await pool.connect(),owner=await pool.connect();let pending;
 try{
 await pool.query("update person_private.transition_work set lease_until=clock_timestamp()+interval '0.3 seconds' where id=$1",[w.work_id]);
 await blocker.query('begin');await blocker.query('select id from website_applications where id=$1 for update',[a]);
 const pid=(await owner.query('select pg_backend_pid() pid')).rows[0].pid;
 pending=start(w.work_id,token,owner).then(value=>({value}),error=>({error}));
 let blocked=false,expired=false;const deadline=Date.now()+3000;
 while(Date.now()<deadline){blocked=(await pool.query("select wait_event_type='Lock' blocked from pg_stat_activity where pid=$1",[pid])).rows[0].blocked;expired=(await pool.query('select lease_until<=clock_timestamp() expired from person_private.transition_work where id=$1',[w.work_id])).rows[0].expired;if(blocked&&expired)break;await new Promise(r=>setTimeout(r,5));}
 assert.ok(blocked&&expired);await blocker.query('commit');const result=await pending;assert.match(result.error?.message||'',/transition_expired/);
 assert.equal((await pool.query('select effects_started_at from person_private.application_work where work_id=$1',[w.work_id])).rows[0].effects_started_at,null);
 }finally{await blocker.query('rollback');if(pending)await pending;blocker.release();owner.release();}
});
const queue=async()=> (await pool.query('select person_application_work_queue(100,null) r')).rows[0].r;
test('queue selects resumable work even after row status changes and skips uncertain or hashless inputs',async()=>{
 const fresh=await app(),recover=await app(),uncertain=await app(),hashless=await app();
 const token=randomUUID(),w=await claim(recover,token);await expire(w.work_id);await pool.query("update website_applications set status='processed' where id=$1",[recover]);
 const other=randomUUID(),u=await claim(uncertain,other);await start(u.work_id,other);await finish(u.work_id,other,'uncertain');
 await pool.query("update website_applications set resume_path='synthetic/hashless.pdf' where id=$1",[hashless]);
 const result=await queue();assert.deepEqual(result.applications.map(x=>x.id).sort(),[fresh,recover].sort());assert.equal(result.waiting,4);assert.equal(result.review_required,2);
});
test('queue does not spin on active or delayed deferred work and reports all waiting',async()=>{
 const a=await app(),token=randomUUID(),w=await claim(a,token);assert.equal((await queue()).applications.length,0);
 await defer(w.work_id,token);const result=await queue();assert.equal(result.applications.length,0);assert.equal(result.waiting,1);
});

test('a budget-exhausted organization does not hide another eligible organization',async()=>{
 const old=await app(),next=await app(TENANT);await pool.query("update website_applications set created_at='2020-01-01' where id=$1",[old]);await pool.query('update organizations set daily_review_limit=0 where id=$1',[TT]);
 const r=(await pool.query('select person_application_work_queue(1,null) r')).rows[0].r;assert.deepEqual(r.applications.map(x=>x.id),[next]);assert.equal(r.waiting,2);
});
test('a legacy queued application without a file needs explicit prior-effect review',async()=>{
 const a=await app();await pool.query('update website_applications set person_processing_version=null where id=$1',[a]);
 assert.equal((await claim(a)).status,'input_review');const r=await queue();assert.equal(r.applications.length,0);assert.equal(r.review_required,1);assert.equal((await pool.query('select count(*)::int n from rate_limit_events')).rows[0].n,0);
});
test('a resume input hold invalidates the owner and excludes repeated downloads',async()=>{
 const a=await app(),token=randomUUID(),w=await claim(a,token);await pool.query("select person_application_work_review($1,$2,'resume_content_mismatch')",[w.work_id,token]);
 assert.equal((await claim(a)).status,'input_review');const r=await queue();assert.equal(r.applications.length,0);assert.equal(r.review_required,1);await assert.rejects(start(w.work_id,token),/transition_admission|transition_expired/);
});
test('the future-intent key deduplicates real concurrent insert transactions',async()=>{
 const a=await pool.connect(),b=await pool.connect(),hash='c'.repeat(64);let pending;
 const insert="insert into website_applications(id,organization_id,name,email,linkedin_username,source,person_intent_hash) values($1,$2,'Synthetic','synthetic@example.test','synthetic-atomic-intent','future',$3) on conflict(organization_id,linkedin_username,person_intent_hash) do nothing returning id";
 try{await a.query('begin');const first=(await a.query(insert,[randomUUID(),TT,hash])).rows;await b.query('begin');const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;pending=b.query(insert,[randomUUID(),TT,hash]);
 let blocked=false;for(let i=0;i<100&&!blocked;i++){blocked=(await pool.query("select wait_event_type='Lock' b from pg_stat_activity where pid=$1",[pid])).rows[0].b;if(!blocked)await new Promise(r=>setTimeout(r,5));}assert.ok(blocked);await a.query('commit');assert.equal(first.length,1);assert.equal((await pending).rows.length,0);await b.query('commit');
 assert.equal((await pool.query("select count(*)::int n from website_applications where person_intent_hash=$1",[hash])).rows[0].n,1);
 }finally{await a.query('rollback');await b.query('rollback');if(pending)await pending.catch(()=>{});a.release();b.release();}
});
test('a claim already waiting on work cannot bypass a newly committed input-review hold',async()=>{
 const a=await app(),token=randomUUID(),w=await claim(a,token),owner=await pool.connect(),waiter=await pool.connect();let pending;
 try{await owner.query('begin');await owner.query("select person_application_work_review($1,$2,'resume_content_mismatch')",[w.work_id,token]);const pid=(await waiter.query('select pg_backend_pid() pid')).rows[0].pid;pending=claim(a,randomUUID(),TT,waiter);
 let blocked=false;for(let n=0;n<100&&!blocked;n++){blocked=(await pool.query("select wait_event_type='Lock' b from pg_stat_activity where pid=$1",[pid])).rows[0].b;if(!blocked)await new Promise(r=>setTimeout(r,5));}assert.ok(blocked);await owner.query('commit');assert.equal((await pending).status,'input_review');
 assert.equal((await pool.query('select status from person_private.transition_work where id=$1',[w.work_id])).rows[0].status,'deferred');
 }finally{await owner.query('rollback');if(pending)await pending.catch(()=>{});owner.release();waiter.release();}
});
test('a transferred reserved application is counted for review without hiding a healthy application',async()=>{
 const old=await app(),w=await claim(old);await expire(w.work_id);await pool.query("update website_applications set organization_id=$2,created_at='2020-01-01' where id=$1",[old,TENANT]);const next=await app();
 const r=(await pool.query('select person_application_work_queue(1,null) r')).rows[0].r;assert.deepEqual(r.applications.map(x=>x.id),[next]);assert.equal(r.review_required,1);assert.equal(r.waiting,2);
});
test('a reserved deferred application remains eligible after its organization exhausts its allowance',async()=>{
 const a=await app(),token=randomUUID(),w=await claim(a,token);await defer(w.work_id,token);await pool.query("update person_private.application_work set retry_after=clock_timestamp()-interval '1 second' where work_id=$1",[w.work_id]);await pool.query('update organizations set daily_review_limit=0 where id=$1',[TT]);assert.deepEqual((await queue()).applications.map(x=>x.id),[a]);assert.equal((await claim(a)).status,'admitted');assert.equal((await pool.query('select count(*)::int n from rate_limit_events')).rows[0].n,1);
});
test('a legacy queued file with a valid hash still cannot reserve unknown prior effects',async()=>{
 const a=await app();await pool.query("update website_applications set person_processing_version=null,resume_path='synthetic/verified.pdf',person_resume_sha256=$2 where id=$1",[a,'b'.repeat(64)]);assert.equal((await claim(a)).status,'input_review');assert.equal((await queue()).review_required,1);
});
