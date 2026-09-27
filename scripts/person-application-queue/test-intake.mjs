import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';import {randomUUID} from 'node:crypto';
const url=process.env.LOCAL_DATABASE_URL;if(!/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_application_intake_queue_test$/.test(url||''))throw Error('local fixture required');
Object.assign(process.env,{PERSON_TRANSITION_SUPPORT:'on',PERSON_WRITE_MODE:'live',SUPABASE_URL:'http://local-only.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic'});
for(const key of ['OPENAI_API_KEY','HARVEST_API_KEY','AIRTABLE_API_TOKEN','RESEND_API_KEY','LLAMA_CLOUD_API_KEY'])delete process.env[key];
const pool=new pg.Pool({connectionString:url,max:8}),TT='801865a7-6533-41d2-9c45-e4a90e6ad51a';
globalThis.fetch=async(input,init={})=>{
 const u=new URL(String(input));assert.equal(u.origin,'http://local-only.invalid','outbound forbidden');const fn=u.pathname.split('/').at(-1);const b=JSON.parse(init.body||'{}');let args;
 if(fn==='person_application_work_claim')args=[b.p_application,b.p_org,b.p_token,b.p_lease];
 else if(fn==='person_application_work_start')args=[b.p_id,b.p_token];
 else if(fn==='person_transition_renew')args=[b.p_id,b.p_token,b.p_lease];
 else if(fn==='person_application_work_complete')args=[b.p_result];
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
async function processApp(id,{mutate,queryHook,harvest,sourceCheck,contacts={phone:'+12025550123'},afterIntake}={}){
 let result,error;const source=(await pool.query('select * from website_applications where id=$1',[id])).rows[0];
 const status=await lib.runApplicationWork({submissionId:id,orgId:TT,boardOrg:null,fromQueue:true},async p=>{
  await lib.startApplicationEffects();let harvestLedgerId;
  if(sourceCheck)await sourceCheck(source);
  if(harvest==='fresh')harvestLedgerId=await lib.storeApplicationHarvest(TT,source.linkedin_username,{id:123,firstName:'Synthetic',lastName:'Profile',skills:[]});
  if(harvest==='cached')harvestLedgerId=(await lib.cachedApplicationHarvest(TT,source.linkedin_username,new Date(0).toISOString()))?.id;
  if(harvest)assert.ok(harvestLedgerId);
  if(mutate)await mutate();const c=await pool.connect();
  const wrapped={query:async(sql,values)=>{if(queryHook)await queryHook(sql,values,c);return c.query(sql,values);}};
  try{result=await lib.saveApplicationPersonOnConnection(wrapped,{organizationId:TT,applicationId:id,linkedinUsername:source.linkedin_username,name:'Resolved Synthetic',parsed:{current_title:'Engineer'},resumeText:'Synthetic resume',resumeContacts:contacts,harvestLedgerId,mode:'live'});}
  catch(e){error=e;throw e;}finally{c.release();}
  if(afterIntake)await afterIntake(result);lib.stageApplicationResult({version:1,matched_role_ids:[],screening:null});return 'processed';
 });return{status,result,error};
}
test('real claimed intake binds trusted work before any family lock and persists receipt contacts',async()=>{
 const id=await app();let checked=false;
 const out=await processApp(id,{queryHook:async(sql,v,c)=>{if(sql.includes('pg_advisory_xact_lock_shared(72005')){const s=(await c.query("select current_setting('person.work_id',true) work,current_setting('person.work_token',true) token")).rows[0];assert.ok(s.work&&s.token,'binding must precede locks');checked=true;}}});
 assert.equal(out.status,'processed',out.error?.message);assert.ok(checked);const row=(await pool.query('select contact from website_applications where id=$1',[id])).rows[0];assert.equal(row.contact.phone,'+12025550123');
 const events=(await pool.query("select a.scope from person_change_attributions a join person_change_events e on e.id=a.event_id where e.source_row_id=$1",[id])).rows;assert.ok(events.some(e=>e.scope==='application_finalize'));
});
test('locked source drift is rejected before normalized writes',async()=>{
 const id=await app(),out=await processApp(id,{mutate:()=>pool.query("update website_applications set email='edited@example.test' where id=$1",[id])});
 assert.equal(out.status,'failed');assert.match(out.error?.message||'',/application_input_changed/);assert.equal((await pool.query('select count(*)::int n from person_application_receipts where application_id=$1',[id])).rows[0].n,0);
});
test('newer future preferences survive applications finishing in reverse order',async()=>{
 const username=`synthetic-work-intake-${++serial}`,old=await app({follow_up_at:'2027-01-01',preferred_roles:['Old']},username),next=await app({follow_up_at:'2027-06-01',preferred_roles:['New']},username);
 const newest=await processApp(next);assert.equal(newest.status,'processed',newest.error?.message);const older=await processApp(old);assert.equal(older.status,'processed',older.error?.message);
 assert.equal(older.result.candidateId,newest.result.candidateId);const row=(await pool.query('select follow_up_at::text,role_preferences from candidates where id=$1',[newest.result.candidateId])).rows[0];assert.equal(row.follow_up_at,'2027-06-01');assert.deepEqual(row.role_preferences.roles,['New']);
});
test('resume contact persistence never replaces a typed phone and resolves blank names atomically',async()=>{
 const id=await app({name:'',contact:{phone:'+12025550999'}}),out=await processApp(id);assert.equal(out.status,'processed',out.error?.message);
 const row=(await pool.query('select contact,name from website_applications where id=$1',[id])).rows[0];assert.equal(row.contact.phone,'+12025550999');assert.equal(row.name,'Resolved Synthetic');
});
test('required contact write failure rolls back person and receipt and keeps work uncertain',async()=>{
 await pool.query("create function person_private.synthetic_contact_failure() returns trigger language plpgsql as $$begin if new.contact is distinct from old.contact then raise exception 'synthetic_contact_failure';end if;return new;end$$;create trigger synthetic_contact_failure before update on website_applications for each row execute function person_private.synthetic_contact_failure()");
 try{const id=await app(),out=await processApp(id);
 assert.equal(out.status,'failed');assert.match(out.error?.message||'',/synthetic_contact_failure/);assert.equal((await pool.query('select count(*)::int n from person_application_receipts where application_id=$1',[id])).rows[0].n,0);
 assert.equal((await pool.query('select w.status from person_private.transition_work w join person_private.application_work a on a.work_id=w.id where a.application_id=$1',[id])).rows[0].status,'uncertain');
 }finally{await pool.query('drop trigger synthetic_contact_failure on website_applications;drop function person_private.synthetic_contact_failure()');}
});
const auditLib=await import('../dist/worker-lib.mjs'),{planAudit}=await import('../person-audit/postcutover.mjs');
async function snapshot(id){const c=await pool.connect();try{await c.query('begin read only');await c.query("set local statement_timeout='15s'");const s=(await c.query('select person_postcutover_audit_inputs_with_witness($1) r',[JSON.stringify([id])])).rows[0].r[0];await c.query('rollback');return s;}finally{await c.query('rollback');c.release();}}
const plan=s=>planAudit(s,auditLib,{complete:true,rows:new Map()});
test('preference evidence remains valid after a newer unlinked future intent arrives',async()=>{
 const username=`synthetic-work-intake-${++serial}`,a=await app({},username),out=await processApp(a);assert.equal(out.status,'processed',out.error?.message);
 const before=await snapshot(out.result.candidateId);assert.equal(plan(before).status,'verified',plan(before).reason);
 const b=await app({preferred_roles:['Later']},username);assert.equal((await pool.query('select candidate_id from website_applications where id=$1',[b])).rows[0].candidate_id,null);
 const after=await snapshot(out.result.candidateId);assert.equal(plan(after).status,'verified',plan(after).reason);assert.deepEqual(after.application_preference_proofs,before.application_preference_proofs);
 for(const mutation of ['missing','foreign','wrong-value','newer-at-decision']){
  const bad=structuredClone(after),e=bad.events.find(e=>e.attribution?.scope==='application_preferences');assert.ok(e);
  if(mutation==='missing')bad.application_preference_proofs=[];
  if(mutation==='foreign')bad.application_preference_proofs[0].candidate_id=randomUUID();
  if(mutation==='newer-at-decision')bad.application_preference_proofs[0].latest_application_id=b;
  if(mutation==='wrong-value')e.payload.role_preferences={roles:['Unproved'],locations:[],workplace:[],salary:null};
  assert.equal(plan(bad).status,'review',mutation);assert.equal(plan(bad).reason,'application_preferences_unwitnessed',mutation);
 }
});
test('an already accepted unlinked newer intent prevents older preferences from being published',async()=>{
 const username=`synthetic-work-intake-${++serial}`,a=await app({preferred_roles:['Old']},username);await app({preferred_roles:['New']},username);const out=await processApp(a);assert.equal(out.status,'processed',out.error?.message);
 const row=(await pool.query('select role_preferences from candidates where id=$1',[out.result.candidateId])).rows[0];assert.equal(row.role_preferences,null);const s=await snapshot(out.result.candidateId);assert.equal(s.application_preference_proofs.length,0);assert.equal(plan(s).status,'verified',plan(s).reason);
});
test('future intent insertion rolls back its journal and conflict losers record no order',async()=>{
 const a=await app(),row=(await pool.query('select * from website_applications where id=$1',[a])).rows[0],c=await pool.connect();try{
 await c.query('begin');const before=(await c.query('select count(*)::int n from person_private.application_intents')).rows[0].n;
 await c.query("insert into website_applications(id,organization_id,name,email,linkedin_username,source,person_processing_version,person_intent_hash) values($1,$2,'Synthetic','synthetic@example.test',$3,'future',1,$4) on conflict(organization_id,linkedin_username,person_intent_hash) do nothing",[randomUUID(),TT,row.linkedin_username,row.person_intent_hash]);assert.equal((await c.query('select count(*)::int n from person_private.application_intents')).rows[0].n,before);
 const id=randomUUID();await c.query("insert into website_applications(id,organization_id,name,email,linkedin_username,source,person_processing_version,person_intent_hash) values($1,$2,'Synthetic','synthetic@example.test','synthetic-rollback-intent','future',1,$3)",[id,TT,'e'.repeat(64)]);assert.equal((await c.query('select count(*)::int n from person_private.application_intents')).rows[0].n,before+1);await c.query('rollback');assert.equal((await pool.query('select count(*)::int n from person_private.application_intents where application_id=$1',[id])).rows[0].n,0);
 }finally{await c.query('rollback');c.release();}
});
async function waitBlocked(pid){let blocked=false;const deadline=Date.now()+2500;while(Date.now()<deadline&&!blocked){blocked=(await pool.query("select wait_event_type='Lock' b from pg_stat_activity where pid=$1",[pid])).rows[0].b;if(!blocked)await new Promise(r=>setTimeout(r,5));}assert.ok(blocked,'a real lock wait must occur');}
test('newer future insertion waiting behind older intake receives a later ordering witness',async()=>{
 const username=`synthetic-work-intake-${++serial}`,old=await app({preferred_roles:['Old']},username),inserter=await pool.connect();let pending,started=false;
 try{const pid=(await inserter.query('select pg_backend_pid() pid')).rows[0].pid;const out=await processApp(old,{queryHook:async sql=>{if(!started&&sql.startsWith('select x.*')){started=true;pending=app({preferred_roles:['New']},username,inserter);await waitBlocked(pid);}}});assert.equal(out.status,'processed',out.error?.message);const newer=await pending;const s=await snapshot(out.result.candidateId);assert.equal(plan(s).status,'verified',plan(s).reason);
 const next=await processApp(newer);assert.equal(next.status,'processed',next.error?.message);assert.deepEqual((await pool.query('select role_preferences from candidates where id=$1',[out.result.candidateId])).rows[0].role_preferences.roles,['New']);
 }finally{if(pending)await pending.catch(()=>{});inserter.release();}
});
test('older intake waiting behind newer acceptance observes its committed journal',async()=>{
 const username=`synthetic-work-intake-${++serial}`,old=await app({preferred_roles:['Old']},username),inserter=await pool.connect();let pending,pid;
 try{await inserter.query('begin');await app({preferred_roles:['New']},username,inserter);pending=processApp(old,{queryHook:async(sql,v,c)=>{if(sql.includes('pg_advisory_xact_lock(72007'))pid=(await c.query('select pg_backend_pid() pid')).rows[0].pid;}});
 const deadline=Date.now()+2500;while(!pid&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));assert.ok(pid);await waitBlocked(pid);await inserter.query('commit');const out=await pending;assert.equal(out.status,'processed',out.error?.message);assert.equal((await pool.query('select role_preferences from candidates where id=$1',[out.result.candidateId])).rows[0].role_preferences,null);
 }finally{await inserter.query('rollback');if(pending)await pending.catch(()=>{});inserter.release();}
});
test('repeatable-read preference selection is refused after a newer committed intent',async()=>{
 const username=`synthetic-work-intake-${++serial}`,old=await app({},username),c=await pool.connect();try{await c.query('begin isolation level repeatable read');await c.query('select count(*) from person_private.application_intents');await app({preferred_roles:['New']},username);await assert.rejects(c.query('select person_private.application_future_latest($1)',[old]),/application_isolation/);}finally{await c.query('rollback');c.release();}
});
test('a real before-family-lock wait has the transaction lock timeout already installed',async()=>{
 const owner=await pool.connect(),waiter=await pool.connect();let timer;
 try{await owner.query('begin');await owner.query('select pg_advisory_xact_lock(72099,1)');timer=setTimeout(()=>owner.query('rollback').catch(()=>{}),5500);const started=Date.now();await assert.rejects(lib.beginPersonTransaction(waiter,()=>waiter.query('select pg_advisory_xact_lock(72099,1)')),/lock timeout/);assert.ok(Date.now()-started<5000);}
 finally{clearTimeout(timer);await owner.query('rollback');await waiter.query('rollback');owner.release();waiter.release();}
});
test('an exact receipt-proven replay accepts its own name/contact outputs',async()=>{
 const id=await app({name:''});let replay;const out=await processApp(id,{afterIntake:async first=>{const c=await pool.connect();try{const row=(await c.query('select linkedin_username from website_applications where id=$1',[id])).rows[0];replay=await lib.saveApplicationPersonOnConnection(c,{organizationId:TT,applicationId:id,linkedinUsername:row.linkedin_username,name:'Different retry',parsed:null,resumeText:null,mode:'live'});}finally{c.release();}}});assert.equal(out.status,'processed',out.error?.message);assert.equal(replay.candidateId,out.result.candidateId);assert.equal(replay.applicationSnapshot.name,'Resolved Synthetic');
});
test('tenant intent evidence cannot authorize metadata on a TT candidate',async()=>{
 const a=await app(),out=await processApp(a);assert.equal(out.status,'processed');const c=await pool.connect(),tenant=randomUUID(),foreign=randomUUID(),op=randomUUID();
 try{await c.query('begin');await c.query("insert into organizations(id,slug) values($1,$2)",[tenant,`synthetic-${tenant}`]);await c.query("insert into website_applications(id,organization_id,name,email,linkedin_username,source,person_processing_version,person_intent_hash,follow_up_at,preferred_roles) values($1,$2,'Synthetic','synthetic@example.test','synthetic-foreign-proof','future',1,$3,'2028-01-01',array['Wrong'])",[foreign,tenant,'f'.repeat(64)]);
 await c.query('insert into person_application_receipts(application_id,candidate_id,created_person,documents,application_snapshot) select $1,candidate_id,false,documents,(select to_jsonb(x) from website_applications x where id=$1) from person_application_receipts where application_id=$2',[foreign,a]);
 await c.query("insert into person_audit_operations(id,candidate_id,writer,receipt_ref,evidence) values($1,$2,'application',$3,'{}')",[op,out.result.candidateId,`application:${foreign}`]);
 await c.query("update candidates set follow_up_at='2028-01-01',role_preferences=$2 where id=$1",[out.result.candidateId,{roles:['Wrong'],locations:[],workplace:[],salary:null}]);const event=(await c.query("select id from person_change_events where candidate_id=$1 and transaction_id=pg_current_xact_id() and source_table='candidates' order by id desc limit 1",[out.result.candidateId])).rows[0].id;
 await assert.rejects(c.query("select person_private.attribute_change($1,$2,'application_preferences')",[event,op]),/audit_application_intent/);
 }finally{await c.query('rollback');c.release();}
});

test('real claimed Harvest persistence survives intake and later applications reuse finalized evidence',async()=>{
 const username=`synthetic-work-intake-${++serial}`,a=await app({},username),first=await processApp(a,{harvest:'fresh'});assert.equal(first.status,'processed',first.error?.message);
 const source=(await pool.query('select e.* from candidate_enrichments e join person_application_receipts r on r.harvest_ledger_id=e.id where r.application_id=$1',[a])).rows[0];assert.equal(source.candidate_id,first.result.candidateId);
 const b=await app({},username),second=await processApp(b,{harvest:'cached'});assert.equal(second.status,'processed',second.error?.message);assert.equal(second.result.candidateId,first.result.candidateId);
 const reused=(await pool.query('select e.* from candidate_enrichments e join person_application_receipts r on r.harvest_ledger_id=e.id where r.application_id=$1',[b])).rows[0];assert.deepEqual(reused,source,'original ledger, date and raw evidence are preserved');
 assert.equal(plan(await snapshot(first.result.candidateId)).status,'verified');
});
test('claimed source helpers reject a mismatched caller username before using retained authority',async()=>{
 const a=await app();const out=await processApp(a,{sourceCheck:async()=>{await assert.rejects(lib.storeApplicationHarvest(TT,'another-person',{id:123}),/application_scope/);await assert.rejects(lib.cachedApplicationHarvest(TT,'another-person',new Date(0).toISOString()),/application_scope/);}});assert.equal(out.status,'processed',out.error?.message);
});
