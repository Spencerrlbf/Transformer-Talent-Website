import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';import {randomUUID} from 'node:crypto';
const url=process.env.LOCAL_DATABASE_URL;if(!/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_application_proof_test$/.test(url||''))throw Error('local fixture required');
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
const lib=await import('../person-application-queue/dist/processing.mjs');test.after(()=>pool.end());
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
  if(afterIntake)await afterIntake(result);lib.stageApplicationResult({version:1,matched_role_ids:[],screening:null});return 'processed';
 });return{status,result,error};
}
async function roleQuery(sql,args=[]){const c=await pool.connect();try{await c.query('begin');await c.query('set local role service_role');return await c.query(sql,args);}finally{await c.query('rollback');c.release();}}
async function probe(c,fn){await c.query('savepoint synthetic_probe');try{return await fn();}finally{await c.query('rollback to savepoint synthetic_probe');await c.query('release savepoint synthetic_probe');}}

import {prepareAuditFixture} from '../person-audit/local-fixture.mjs';
const incumbent=randomUUID(),forged=randomUUID();
for(const id of [incumbent,forged]){
 await pool.query("insert into candidates(id,full_name,linkedin_username,linkedin_url,created_at) values($1,'Synthetic',$2,$3,'2020-01-01')",[id,`proof-${id}`,`https://www.linkedin.com/in/proof-${id}`]);await prepareAuditFixture(id);
}
// A disabled legacy caller can author an apparent checkpoint. It must never
// become trusted merely because later claimed work carries the same candidate.
await pool.query("update candidates set current_title='Unattributed Synthetic' where id=$1",[forged]);
await pool.query("insert into person_audit_operations(id,candidate_id,writer,receipt_ref,evidence) select $2::uuid,$1::uuid,'application','application:'||($2::uuid)::text,jsonb_build_object('guard',jsonb_build_object('version','candidate-audit-1','anchor_hash',a.anchor_hash,'candidate_hash',person_private.audit_candidate_hash(to_jsonb(c)),'captured_version',(select max(id)::text from person_change_events where candidate_id=$1),'auxiliary',person_private.audit_auxiliary_proof($1)->'proof')) from candidates c join person_audit_anchors a on a.candidate_id=c.id where c.id=$1",[forged,randomUUID()]);
for(const setting of ["person.work_token='00000000-0000-4000-8000-000000000001'", "request.headers='{\"x-person-work-token\":\"00000000-0000-4000-8000-000000000001\"}'"])test(`partial credentials cannot insert audit authority: ${setting.split('=')[0]}`,async()=>{await assert.rejects(roleQuery(`set local ${setting};insert into person_audit_operations select * from person_audit_operations where false`),/audit_proof_frame/);});
test('clearing work context cannot downgrade a private operation to legacy attribution',async()=>{
 let earlier,checked=false;const r=await processApp(await app(),{queryHook:async(sql,values,c)=>{
  if(sql==='select public.person_application_audit_begin(true) operation'){
   const binding=(await c.query('select candidate_id from person_private.application_candidates where transaction_id=pg_current_xact_id()')).rows[0];
   await c.query('update candidates set full_name=full_name where id=$1',[binding.candidate_id]);
   earlier=(await c.query("select max(id)::text id from person_change_events where candidate_id=$1 and operation='UPDATE'",[binding.candidate_id])).rows[0].id;
  }
  if(checked||!sql.startsWith('select public.save_person'))return;checked=true;
  const op=(await c.query('select operation_id from person_private.application_audit_operations where transaction_id=pg_current_xact_id()')).rows[0];
  for(const sql of ["select person_private.attribute_change($1,$2,'profile')","select person_private.application_preference_decision($1,$2)"])await probe(c,async()=>{await c.query("select set_config('person.work_id','',true),set_config('person.work_token','',true),set_config('request.headers','{}',true)");await assert.rejects(c.query(sql,[earlier,op.operation_id]),/transition_admission/);});
 }});assert.equal(r.status,'processed',r.error?.message);assert.ok(checked&&earlier);
});
test('an uncertified existing anchor cannot bootstrap through an unchanged legacy replay',async()=>{
 const c=await pool.connect();try{await c.query('begin');await c.query("set local statement_timeout='5s'");const a=(await c.query('select * from person_audit_anchors where candidate_id=$1',[incumbent])).rows[0];await c.query('delete from person_private.certified_audit_anchors where candidate_id=$1',[incumbent]);await assert.rejects(c.query('select person_audit_anchor_commit($1)',[JSON.stringify([{candidate_id:incumbent,doc:a.legacy_doc,proof:a.external_proof.preparation_proof}])]),/audit_anchor_uncertified/);}finally{await c.query('rollback');c.release();}
});
test('arm proof boundary',async()=>{await pool.query("select person_private.transition_set('arm',1,1,'synthetic_test')");});
let candidate;
test('new claimed intake creates privately certified anchor and DB-derived operation',async()=>{const id=await app(),r=await processApp(id);assert.equal(r.status,'processed',r.error?.message);candidate=r.result.candidateId;const {rows}=await pool.query("select o.id from person_audit_operations o join person_private.application_audit_operations p on p.operation_id=o.id join person_private.certified_audit_anchors a on a.candidate_id=o.candidate_id where o.candidate_id=$1",[candidate]);assert.ok(rows.length>0);});
test('existing claimed intake accepts only checked legacy anchors',async()=>{const r=await processApp(await app({},`proof-${incumbent}`));assert.equal(r.status,'processed',r.error?.message);assert.equal(r.result.candidateId,incumbent);});
test('a disabled forged checkpoint cannot launder an unattributed edit',async()=>{const r=await processApp(await app({},`proof-${forged}`));assert.equal(r.status,'failed');assert.match(r.error?.message||'',/audit_unattributed_change|audit_proof_chain/);});
for(const table of ['person_audit_anchors','person_audit_operations','person_change_attributions'])test(`raw ${table} insert cannot mint authority`,async()=>{await assert.rejects(roleQuery(`insert into ${table} select * from ${table} where false`),/audit_proof_frame|permission denied/);});
for(const table of ['person_change_events','person_change_queue','person_audit_epochs','person_postcutover_lookup_epochs'])test(`raw ${table} cannot manufacture source evidence`,async()=>{await assert.rejects(roleQuery(`insert into ${table} overriding system value select * from ${table} where false`),/permission denied/);});
test('raw capture rewrites and reconciliation cannot run under armed application authority',async()=>{
 await assert.rejects(roleQuery('update person_change_events set payload=payload where false'),/permission denied/);
 await assert.rejects(roleQuery('update person_change_events set reconciled_at=reconciled_at where false'),/audit_proof_maintenance/);
 await assert.rejects(roleQuery('delete from person_change_queue where false'),/audit_proof_maintenance/);
});
test('application authority cannot alter source holds',async()=>{await assert.rejects(roleQuery('update person_source_holds set resolved_at=resolved_at where false'),/audit_proof_maintenance/);});
test('service has no proof TRUNCATE privileges or private mapping access',async()=>{
 for(const table of ['person_change_events','person_change_queue','person_audit_anchors','person_audit_operations','person_change_attributions','person_audit_epochs','person_postcutover_lookup_epochs','person_source_holds'])assert.equal((await pool.query("select has_table_privilege('service_role',$1,'TRUNCATE') allowed",[table])).rows[0].allowed,false,table);
 await assert.rejects(roleQuery('select * from person_private.application_audit_operations'),/permission denied/);
});
for(const table of ['person_change_events','person_change_queue','person_audit_epochs','person_postcutover_lookup_epochs','person_source_holds'])test(`direct PG callers cannot mint armed ${table} evidence`,async()=>{await assert.rejects(pool.query(`insert into ${table} overriding system value select * from ${table} where false`),/audit_internal_proof/);});
test('operation boundary rejects retroactive attribution even with exact active credentials',async()=>{
 let checked=false;const r=await processApp(await app(),{queryHook:async(sql,values,c)=>{if(checked||!sql.startsWith('select public.save_person'))return;checked=true;
 const op=(await c.query("select p.* from person_private.application_audit_operations p where p.transaction_id=pg_current_xact_id() order by operation_id limit 1")).rows[0];
 await probe(c,()=>assert.rejects(c.query("select person_private.attribute_change($1,$2,'profile')",[op.creator_event_id,op.operation_id]),/audit_application_event/));
 await probe(c,()=>assert.rejects(c.query("select person_private.application_preference_decision($1,$2)",[op.creator_event_id,op.operation_id]),/audit_application_event/));
 }});assert.equal(r.status,'processed',r.error?.message);assert.ok(checked);
});
test('unknown operation cannot claim an active application event',async()=>{const r=await processApp(await app(),{queryHook:async(sql,values,c)=>{if(sql.startsWith('select public.person_application_audit_begin'))await probe(c,()=>assert.rejects(c.query('select person_private.application_attribution_context(1,$1,\'profile\')',[randomUUID()]),/permission denied|audit_application_scope/));}});assert.equal(r.status,'processed',r.error?.message);});

test('a later application accepts the immutable privately proved candidate chain',async()=>{const username=(await pool.query('select linkedin_username from candidates where id=$1',[candidate])).rows[0].linkedin_username;const r=await processApp(await app({},username));assert.equal(r.status,'processed',r.error?.message);assert.equal(r.result.candidateId,candidate);});
test('capture failure rolls back its internal frames and candidate seed',async()=>{
 await pool.query("create function person_private.synthetic_capture_failure() returns trigger language plpgsql as $$begin if exists(select 1 from person_private.audit_proof_frames where backend_pid=pg_backend_pid() and kind='person_change_events') then raise exception 'synthetic_capture_failure';else raise exception 'synthetic_proof_missing';end if;end$$;create trigger synthetic_capture_failure before insert on person_change_events for each row execute function person_private.synthetic_capture_failure()");
 try{const r=await processApp(await app());assert.equal(r.status,'failed');assert.match(r.error?.message||'',/synthetic_capture_failure/);assert.equal((await pool.query('select count(*)::int n from person_private.audit_proof_frames')).rows[0].n,0);}finally{await pool.query('drop trigger synthetic_capture_failure on person_change_events;drop function person_private.synthetic_capture_failure()');}
});
test('trigger marker helpers and private cores cannot be attached or invoked by service',async()=>{
 for(const fn of ['capture_change()','audit_epoch()','postcutover_lookup_epoch()','postcutover_attribution_reference_epoch()','hold_cache_date()','hold_existing_cache_dates()','audit_proof_frame(text,uuid)','attribute_change_core(bigint,uuid,text)','application_preference_decision_core(bigint,uuid)','audit_anchor_commit_core(jsonb)'])assert.equal((await pool.query("select has_function_privilege('service_role',$1,'EXECUTE') allowed",[`person_private.${fn}`])).rows[0].allowed,false,fn);
});
test('source statement gate prevents controller drain overtaking its transaction',async()=>{
 const source=await pool.connect(),control=await pool.connect();let waiting,settled=false;
 try{await source.query('begin');await source.query('update candidates set full_name=full_name where id=$1',[candidate]);await control.query('begin');const state=(await control.query('select revision,generation from person_private.transition_control')).rows[0];waiting=control.query("select person_private.transition_set('drain',$1,$2,'synthetic_test')",[state.revision,state.generation]).then(()=>{settled=true;});await new Promise(r=>setTimeout(r,80));assert.equal(settled,false);await source.query('commit');await waiting;}
 finally{await source.query('rollback');await control.query('rollback');source.release();control.release();}
});
test('only private verified checkpoints bound long-lived candidate history',async()=>{
 const username=(await pool.query('select linkedin_username from candidates where id=$1',[candidate])).rows[0].linkedin_username;
 for(let phase=0;phase<2;phase++){
  const c=await pool.connect();try{await c.query('begin');for(let i=0;i<110;i++)await c.query('update candidates set full_name=full_name where id=$1',[candidate]);await c.query('commit');}finally{await c.query('rollback');c.release();}
  const r=await processApp(await app({},username));assert.equal(r.status,'processed',r.error?.message);
 }
});
test('direct PG deletion cannot erase genuine capture history',async()=>{await assert.rejects(pool.query('delete from person_change_events where false'),/audit_proof_maintenance/);});
test('direct PG TRUNCATE cannot erase proof, held-source or normalized history',async()=>{
 for(const table of ['person_change_events','person_change_queue','person_audit_anchors','person_audit_operations','person_change_attributions','person_audit_epochs','person_postcutover_lookup_epochs','person_source_holds','candidate_contacts']){
  const c=await pool.connect();try{await c.query('begin');await assert.rejects(c.query(`truncate ${table} cascade`),/audit_proof_truncate/);}finally{await c.query('rollback');c.release();}
 }
});
test('audit admission rechecks lease after a real candidate lock wait',async()=>{
 let verified=false;const r=await processApp(await app(),{afterIntake:async first=>{
  const locker=await pool.connect(),caller=await pool.connect();let pending;
  try{
   await locker.query('begin');await locker.query('select id from candidates where id=$1 for update',[first.candidateId]);
   const headers=lib.transitionRequestHeaders();await pool.query("update person_private.transition_work set lease_until=clock_timestamp()+interval '300 milliseconds' where id=$1",[headers['x-person-work-id']]);
   await caller.query('begin');await caller.query("select set_config('request.headers',$1,true)",[JSON.stringify(headers)]);const pid=(await caller.query('select pg_backend_pid() pid')).rows[0].pid;
   pending=assert.rejects(caller.query('select person_application_audit_begin(false)'),/transition_admission|transition_expired/);
   await new Promise(r=>setTimeout(r,80));assert.equal((await pool.query("select wait_event_type='Lock' waiting from pg_stat_activity where pid=$1",[pid])).rows[0].waiting,true);
   await new Promise(r=>setTimeout(r,300));await locker.query('rollback');await pending;verified=true;
  }finally{await locker.query('rollback');await caller.query('rollback');locker.release();caller.release();}
 }});assert.equal(r.status,'failed');assert.ok(verified);assert.equal((await pool.query('select count(*)::int n from person_private.audit_proof_frames')).rows[0].n,0);
});
test('a transferred creator application cannot supply current TT anchor authority',async()=>{
 const original=await app(),first=await processApp(original);assert.equal(first.status,'processed',first.error?.message);
 const username=(await pool.query('select linkedin_username from website_applications where id=$1',[original])).rows[0].linkedin_username;
 await pool.query('update website_applications set organization_id=$2 where id=$1',[original,randomUUID()]);
 const replay=await processApp(await app({},username));assert.equal(replay.status,'failed');assert.match(replay.error?.message||'',/audit_creation_receipt/);
});
