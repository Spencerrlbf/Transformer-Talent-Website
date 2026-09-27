import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';import {randomUUID} from 'node:crypto';
const url=process.env.LOCAL_DATABASE_URL;if(!/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_application_projection_test$/.test(url||''))throw Error('local fixture required');
Object.assign(process.env,{PERSON_TRANSITION_SUPPORT:'on',PERSON_WRITE_MODE:'live',SUPABASE_URL:'http://local-only.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic'});
for(const key of ['OPENAI_API_KEY','HARVEST_API_KEY','AIRTABLE_API_TOKEN','RESEND_API_KEY','LLAMA_CLOUD_API_KEY'])delete process.env[key];
const pool=new pg.Pool({connectionString:url,max:8}),TT='801865a7-6533-41d2-9c45-e4a90e6ad51a';
globalThis.fetch=async(input,init={})=>{
 const u=new URL(String(input));assert.equal(u.origin,'http://local-only.invalid','outbound forbidden');const fn=u.pathname.split('/').at(-1);const b=JSON.parse(init.body||'{}');let args;
 if(fn==='person_application_work_claim')args=[b.p_application,b.p_org,b.p_token,b.p_lease];
 else if(fn==='person_application_work_start')args=[b.p_id,b.p_token];
 else if(fn==='person_transition_renew')args=[b.p_id,b.p_token,b.p_lease];
 else if(fn==='person_application_work_finish')args=[b.p_id,b.p_token,b.p_outcome];
 else if(fn==='person_application_work_defer')args=[b.p_id,b.p_token,b.p_delay];
 else if(fn==='person_application_harvest_store')args=[b.p_payload];
 else if(fn==='person_application_harvest_cache')args=[b.p_since,b.p_ledger];else throw Error('unexpected_rpc');
 const c=await pool.connect();try{await c.query('begin');const headers=new Headers(init.headers);await c.query("select set_config('request.headers',$1,true)",[JSON.stringify(Object.fromEntries([...headers].filter(([key])=>key.startsWith('x-person-'))))]);const result=(await c.query(`select public.${fn}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args)).rows[0].r;await c.query('commit');return Response.json(result);}catch{return Response.json({message:'synthetic_rpc_failed'},{status:409});}finally{await c.query('rollback');c.release();}
};
const lib=await import('./dist/processing.mjs');test.after(()=>pool.end());
let serial=0;
async function app(patch={},username=`synthetic-work-intake-${++serial}`,db=pool){
 const id=randomUUID();await db.query("insert into website_applications(id,organization_id,name,email,linkedin_username,linkedin_url,status,source,person_processing_version,person_intent_hash,follow_up_at,preferred_roles,preferred_locations,preferred_workplace,contact) values($1,$2,$3,'synthetic@example.test',$4,$5,'queued','future',1,$6,$7,$8,'{}','{}',$9)",[id,TT,patch.name??'Synthetic',username,`https://www.linkedin.com/in/${username}`,randomUUID().replaceAll('-','').repeat(2),patch.follow_up_at??'2027-01-01',patch.preferred_roles??['Engineering'],patch.contact??{}]);return id;
}
async function processApp(id,{mutate,queryHook,harvest,sourceCheck,parsed={current_title:'Engineer',top_skills:['Synthetic Rust'],education_schools:['Synthetic University']},contacts={phone:'+12025550123'},afterIntake}={}){
 let result,error;const source=(await pool.query('select * from website_applications where id=$1',[id])).rows[0];
 const status=await lib.runApplicationWork({submissionId:id,orgId:TT,boardOrg:null,fromQueue:true},async p=>{
  await lib.startApplicationEffects();let harvestLedgerId;
  if(sourceCheck)await sourceCheck(source);
  if(harvest==='fresh')harvestLedgerId=await lib.storeApplicationHarvest(TT,source.linkedin_username,{id:123,firstName:'Synthetic',lastName:'Profile',skills:[]});
  if(harvest==='cached')harvestLedgerId=(await lib.cachedApplicationHarvest(TT,source.linkedin_username,new Date(0).toISOString()))?.id;
  if(harvest)assert.ok(harvestLedgerId);
  if(mutate)await mutate();const c=await pool.connect();
  const wrapped={query:async(sql,values)=>{if(queryHook)await queryHook(sql,values,c);return c.query(sql,values);}};
  try{result=await lib.saveApplicationPersonOnConnection(wrapped,{organizationId:TT,applicationId:id,linkedinUsername:source.linkedin_username,name:'Resolved Synthetic',parsed,resumeText:'Synthetic resume',resumeContacts:contacts,harvestLedgerId,mode:'live'});}
  catch(e){error=e;throw e;}finally{c.release();}
  if(afterIntake)await afterIntake(result);await pool.query("update website_applications set status='processed' where id=$1",[id]);return 'processed';
 });return{status,result,error};
}
async function roleQuery(sql,args=[]){const c=await pool.connect();try{await c.query('begin');await c.query('set local role service_role');return await c.query(sql,args);}finally{await c.query('rollback');c.release();}}
async function probe(c,fn){await c.query('savepoint synthetic_probe');try{return await fn();}finally{await c.query('rollback to savepoint synthetic_probe');await c.query('release savepoint synthetic_probe');}}

import {prepareAuditFixture} from '../person-audit/local-fixture.mjs';
const incumbent=randomUUID();
await pool.query("insert into candidates(id,full_name,linkedin_username,linkedin_url,created_at) values($1,'Synthetic',$2,$3,'2020-01-01')",[incumbent,`projection-${incumbent}`,`https://www.linkedin.com/in/projection-${incumbent}`]);await prepareAuditFixture(incumbent);
const emailIncumbents=[randomUUID(),randomUUID()];
for(const [i,id] of emailIncumbents.entries()){
 await pool.query("insert into candidates(id,full_name,linkedin_username,email,created_at) values($1,'Synthetic',$2,$3,'2020-01-01')",[id,`retained-${id}`,`retained-${id}@example.test`]);await prepareAuditFixture(id);
 if(i===1)await pool.query("update candidate_contacts set status='invalid',rank=null where candidate_id=$1 and kind='email'",[id]);
}
test('arm projection boundary',async()=>{await pool.query("select person_private.transition_set('arm',1,1,'synthetic_test')");});
for(const table of ['person_projection_state','person_projection_history']){
 test(`raw ${table} statements require synchronous scope`,async()=>{await assert.rejects(roleQuery(`insert into ${table} overriding system value select * from ${table} where false`),/projection_frame|permission denied/);});
 test(`owner cannot delete ${table} proof`,async()=>{await assert.rejects(pool.query(`delete from ${table} where false`),/projection_frame/);});
}
test('raw owner profile update fails',async()=>{await assert.rejects(pool.query("update candidates set current_title='Forged' where id=$1",[incumbent]),/projection_frame/);});
test('actual new intake uses checked RPC and retains production hashes',async()=>{let called=false;const r=await processApp(await app(),{queryHook:async sql=>{called ||= sql.startsWith('select public.person_application_project(');}});assert.equal(r.status,'processed',r.error?.message);assert.ok(called);const row=(await pool.query('select * from candidates where id=$1',[r.result.candidateId])).rows[0];const state=(await pool.query('select * from person_projection_state where candidate_id=$1',[row.id])).rows[0];assert.equal(state.profile_hash,lib.projectionProfileHash(row));assert.equal(state.semantic_hash,lib.semanticProfileHash(row));});
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const serialize=v=>JSON.stringify(stable(v));
async function projectionProbe(mutate,expected){let checked=false;const r=await processApp(await app(),{queryHook:async(sql,v,c)=>{if(!sql.startsWith('select public.person_application_project('))return;checked=true;await probe(c,async()=>{const copy=structuredClone(v);await mutate(copy,c);await assert.rejects(c.query(sql,copy),expected);});}});assert.equal(r.status,'processed',r.error?.message);assert.ok(checked);}
for(const [label,mutate,pattern] of [
 ['foreign operation',v=>{v[0]=randomUUID();},/projection_operation/],
 ['stale revision',v=>{v[1]='999999';},/projection_revision/],
 ['stale before',v=>{const e=v[2];const x=JSON.parse(e.before);x.current_title='stale';e.before=serialize(x);},/projection_before/],
 ['extra profile field',v=>{const e=v[2];const x=JSON.parse(e.after);x.notes='forged';e.after=serialize(x);},/projection_fields/],
 ['coercion to text',v=>{const e=v[2];const x=JSON.parse(e.after);x.current_title=99;e.after=serialize(x);},/projection_types/],
 ['fallback nonemail mutation',v=>{const e=v[2];const x=JSON.parse(e.fallback);x.current_title='forged';e.fallback=serialize(x);},/projection_fallback/],
 ['foreign conflict evidence',v=>{v[2].collision=serialize([randomUUID(),null]);},/projection_collision/],
 ['malformed JSON',v=>{v[2].after='{';},/invalid input syntax/],
 ['cleared context',async(v,c)=>{await c.query("select set_config('person.work_id','',true),set_config('person.work_token','',true),set_config('request.headers','{}',true)");},/transition_admission/],
])test(`checked projection rejects ${label}`,()=>projectionProbe(mutate,pattern));
test('incomplete normalized receipt rejects before projection',async()=>{
 let checked=false;const r=await processApp(await app(),{queryHook:async(sql,v,c)=>{if(!sql.startsWith('select public.save_person'))return;checked=true;const op=(await c.query('select operation_id from person_private.application_audit_operations where transaction_id=pg_current_xact_id()')).rows[0];const rev=(await c.query('select rev from candidate_profile_state where candidate_id=(select candidate_id from person_private.application_candidates where transaction_id=pg_current_xact_id())')).rows[0]?.rev??0;await probe(c,()=>assert.rejects(c.query('select person_application_project($1,$2,$3)',[op.operation_id,rev,{}]),/projection_receipt/));}});assert.equal(r.status,'processed',r.error?.message);assert.ok(checked);
});
test('existing candidate projection retains original operation for finalization and preferences',async()=>{const r=await processApp(await app({},`projection-${incumbent}`));assert.equal(r.status,'processed',r.error?.message);assert.equal(r.result.candidateId,incumbent);assert.ok((await pool.query("select 1 from person_change_attributions where candidate_id=$1 and scope='application_preferences'",[incumbent])).rowCount);});
test('unchanged replay creates no extra history and frame cannot be reused',async()=>{const id=await app();let beforeHistory;const r=await processApp(id,{afterIntake:async first=>{
 beforeHistory=(await pool.query('select count(*)::int n from person_projection_history where candidate_id=$1',[first.candidateId])).rows[0].n;
 const c=await pool.connect();try{const row=(await c.query('select linkedin_username from website_applications where id=$1',[id])).rows[0];const replay=await lib.saveApplicationPersonOnConnection(c,{organizationId:TT,applicationId:id,linkedinUsername:row.linkedin_username,name:'retry',parsed:null,resumeText:null,mode:'live'});assert.equal(replay.projected,false);}finally{c.release();}
 assert.equal((await pool.query('select count(*)::int n from person_projection_history where candidate_id=$1',[first.candidateId])).rows[0].n,beforeHistory);
 }});assert.equal(r.status,'processed',r.error?.message);assert.equal((await pool.query('select count(*)::int n from person_private.application_projection_frames')).rows[0].n,0);
 await assert.rejects(pool.query('update person_projection_state set revision=revision where false'),/projection_frame/);
});
function chooseEmail(v,email){const e=v[2],after=JSON.parse(e.after),semantic=JSON.parse(e.semanticAfter);after.email=email;semantic.email=email;e.after=serialize(after);e.semanticAfter=serialize(semantic);const evidence=JSON.parse(e.collision);evidence[1]=email;e.collision=serialize(evidence);}
for(const racing of [false,true])test(`${racing?'concurrent':'preexisting'} email collision selects fallback hash atomically`,async()=>{
 const email=`${randomUUID()}@example.test`,owner=randomUUID(),competitor=await pool.connect();let waiting,waitObserved=false;
 if(racing)await competitor.query('begin');
 await competitor.query("insert into candidates(id,full_name,linkedin_username,email) values($1,'Synthetic',$2,$3)",[owner,`collision-${owner}`,email]);
 const id=await app();try{const r=await processApp(id,{queryHook:async(sql,v,c)=>{
  if(!sql.startsWith('select public.person_application_project('))return;chooseEmail(v,email);
  if(racing){const pid=(await c.query('select pg_backend_pid() pid')).rows[0].pid;
   waiting=(async()=>{for(let i=0;i<100;i++){const x=(await pool.query("select wait_event_type='Lock' waiting from pg_stat_activity where pid=$1",[pid])).rows[0];if(x?.waiting){waitObserved=true;break;}await new Promise(r=>setTimeout(r,5));}await competitor.query('commit');})();
  }
 }});if(waiting)await waiting;assert.equal(r.status,'processed',r.error?.message);if(racing)assert.ok(waitObserved,'real unique-index wait');
 const row=(await pool.query('select * from candidates where id=$1',[r.result.candidateId])).rows[0],state=(await pool.query('select * from person_projection_state where candidate_id=$1',[r.result.candidateId])).rows[0];assert.equal(row.email,null);assert.equal(state.profile_hash,lib.projectionProfileHash(row));assert.equal(state.semantic_hash,lib.semanticProfileHash(row));
 const history=(await pool.query('select * from person_projection_history where candidate_id=$1 order by id desc limit 1',[row.id])).rows[0];assert.equal(history.after_hash,state.profile_hash);assert.equal(history.semantic_after,state.semantic_hash);
 const conflict=(await pool.query("select * from identity_conflicts where kind='legacy_email_collision' and candidate_ids=array[$1::uuid]",[row.id])).rows[0];const {createHash}=await import('node:crypto');assert.equal(conflict.evidence_hash,createHash('sha256').update(JSON.stringify([row.id,email])).digest('hex'));
 }finally{await competitor.query('rollback');if(waiting)await waiting;competitor.release();}
});
test('history failure rolls back candidate, source, audit and projection state',async()=>{
 const id=await app();await pool.query("create function person_private.synthetic_projection_failure() returns trigger language plpgsql as $$begin raise exception 'synthetic_history_failure';end$$;create trigger synthetic_projection_failure before insert on person_projection_history for each row execute function person_private.synthetic_projection_failure()");
 try{const r=await processApp(id);assert.equal(r.status,'failed');assert.match(r.error?.message||'',/synthetic_history_failure/);assert.equal((await pool.query('select count(*)::int n from person_private.application_candidates where application_id=$1',[id])).rows[0].n,0);assert.equal((await pool.query('select count(*)::int n from person_private.application_projection_frames')).rows[0].n,0);assert.equal((await pool.query("select count(*)::int n from person_audit_operations where receipt_ref=$1",[`application:${id}`])).rows[0].n,0);}finally{await pool.query('drop trigger synthetic_projection_failure on person_projection_history;drop function person_private.synthetic_projection_failure()');}
});
test('service cannot open a projection frame or truncate projection proof',async()=>{
 for(const fn of ['projection_frame()','projection_profile(jsonb)','projection_proof_guard()','application_profile_guard()'])assert.equal((await pool.query("select has_function_privilege('service_role',$1,'EXECUTE') allowed",[`person_private.${fn}`])).rows[0].allowed,false);
 await assert.rejects(roleQuery('insert into person_private.application_projection_frames select * from person_private.application_projection_frames where false'),/permission denied/);
 for(const table of ['person_projection_state','person_projection_history']){const c=await pool.connect();try{await c.query('begin');await assert.rejects(c.query(`truncate ${table} cascade`),/audit_proof_truncate/);}finally{await c.query('rollback');c.release();}}
});
function makeNoop(v){const e=v[2];e.after=e.before;e.fallback=e.before;e.semanticAfter=e.semanticBefore;e.semanticFallback=e.semanticBefore;const x=JSON.parse(e.collision);x[1]=JSON.parse(e.before).email;e.collision=serialize(x);}
test('no-op projection still rejects revoked anchor certification',()=>projectionProbe(async(v,c)=>{makeNoop(v);await c.query('delete from person_private.certified_audit_anchors where candidate_id=(select candidate_id from person_private.application_candidates where transaction_id=pg_current_xact_id())');},/audit_anchor_uncertified/));
test('no-op projection still rejects a newly recorded source hold',()=>projectionProbe(async(v,c)=>{
 makeNoop(v);await c.query("select person_private.audit_proof_frame('person_source_holds')");await c.query("insert into person_source_holds(candidate_id,ledger_id,evidence_hash,reason,evidence) select candidate_id,$1,'synthetic','harvest_cache_date_unknown','{}' from person_private.application_candidates where transaction_id=pg_current_xact_id()",[randomUUID()]);await c.query("select person_private.audit_proof_clear('person_source_holds')");
},/audit_source_hold/));
test('no-op projection verifies intermediate unattributed edits even if reverted',()=>projectionProbe(async(v,c)=>{
 makeNoop(v);const b=JSON.parse(v[2].before);await c.query('alter table candidates disable trigger person_application_profile');await c.query("update candidates set current_title='Synthetic unproved' where id=(select candidate_id from person_private.application_candidates where transaction_id=pg_current_xact_id())");await c.query('update candidates set current_title=$1 where id=(select candidate_id from person_private.application_candidates where transaction_id=pg_current_xact_id())',[b.current_title]);await c.query('alter table candidates enable trigger person_application_profile');
},/audit_unattributed_change/));
test('unrelated unique errors are not treated as email collisions',async()=>{
 await pool.query("create function person_private.synthetic_projection_unique() returns trigger language plpgsql as $$begin if exists(select 1 from person_private.application_projection_frames where backend_pid=pg_backend_pid()) then raise unique_violation using constraint='synthetic_other_key';end if;return new;end$$;create trigger synthetic_projection_unique before update on candidates for each row execute function person_private.synthetic_projection_unique()");
 try{const r=await processApp(await app());assert.equal(r.status,'failed');assert.equal(r.error?.code,'23505');assert.equal(r.error?.constraint,'synthetic_other_key');assert.equal((await pool.query('select count(*)::int n from person_private.application_projection_frames')).rows[0].n,0);}finally{await pool.query('drop trigger synthetic_projection_unique on candidates;drop function person_private.synthetic_projection_unique()');}
});
test('stale transaction operation cannot authorize a later projection',async()=>{
 let previous;const r=await processApp(await app(),{queryHook:async(sql,v)=>{if(sql.startsWith('select public.person_application_project('))previous=structuredClone(v);},afterIntake:async()=>{
  const c=await pool.connect();try{await c.query('begin');await c.query("select set_config('request.headers',$1,true)",[JSON.stringify(lib.transitionRequestHeaders())]);await assert.rejects(c.query('select person_application_project($1,$2,$3)',previous),/projection_operation/);}finally{await c.query('rollback');c.release();}
 }});assert.equal(r.status,'processed',r.error?.message);
});
test('lease expiry behind a projection state lock rolls back the complete mutation',async()=>{
 const first=await processApp(await app());assert.equal(first.status,'processed',first.error?.message);const username=(await pool.query('select linkedin_username from candidates where id=$1',[first.result.candidateId])).rows[0].linkedin_username;
 const locker=await pool.connect();let release,observed=false;await locker.query('begin');await locker.query('select * from person_projection_state where candidate_id=$1 for update',[first.result.candidateId]);
 const before=(await pool.query('select to_jsonb(c) p from candidates c where id=$1',[first.result.candidateId])).rows[0].p;
 try{const r=await processApp(await app({},username),{queryHook:async(sql,v,c)=>{
  if(!sql.startsWith('select public.person_application_project('))return;
  await c.query("update person_private.transition_work set lease_until=clock_timestamp()+interval '200 milliseconds' where id=current_setting('person.work_id')::uuid");const pid=(await c.query('select pg_backend_pid() pid')).rows[0].pid;
  release=(async()=>{for(let i=0;i<100;i++){if((await pool.query("select wait_event_type='Lock' waiting from pg_stat_activity where pid=$1",[pid])).rows[0]?.waiting){observed=true;break;}await new Promise(r=>setTimeout(r,5));}await new Promise(r=>setTimeout(r,220));await locker.query('rollback');})();
 }});await release;assert.ok(observed);assert.equal(r.status,'failed');assert.match(r.error?.message||'',/transition_admission|transition_expired/);assert.deepEqual((await pool.query('select to_jsonb(c) p from candidates c where id=$1',[first.result.candidateId])).rows[0].p,before);assert.equal((await pool.query('select count(*)::int n from person_private.application_projection_frames')).rows[0].n,0);
 }finally{await locker.query('rollback');if(release)await release;locker.release();}
});

for(const [i,id] of emailIncumbents.entries())test(`email collision ${i?'clears an invalidated':'preserves a usable'} incumbent address`,async()=>{
 const email=`${randomUUID()}@example.test`,owner=randomUUID();await pool.query("insert into candidates(id,full_name,linkedin_username,email) values($1,'Synthetic',$2,$3)",[owner,`owner-${owner}`,email]);
 const r=await processApp(await app({},`retained-${id}`),{queryHook:async(sql,v)=>{if(sql.startsWith('select public.person_application_project('))chooseEmail(v,email);}});assert.equal(r.status,'processed',r.error?.message);const row=(await pool.query('select * from candidates where id=$1',[id])).rows[0];assert.equal(row.email,i?null:`retained-${id}@example.test`);assert.equal((await pool.query('select profile_hash from person_projection_state where candidate_id=$1',[id])).rows[0].profile_hash,lib.projectionProfileHash(row));
});
