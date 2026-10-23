import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';import {randomUUID} from 'node:crypto';
const url=process.env.LOCAL_DATABASE_URL;if(!/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_application_completion_test$/.test(url||''))throw Error('local fixture required');
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
async function processApp(id,{mutate,queryHook,harvest,sourceCheck,contacts={phone:'+12025550123'},afterIntake,completion={version:1,matched_role_ids:[],screening:null}}={}){
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
  if(afterIntake)await afterIntake(result);lib.stageApplicationResult(completion);return 'processed';
 });return{status,result,error};
}
const auditLib=await import('../dist/worker-lib.mjs'),{planAudit}=await import('../person-audit/postcutover.mjs');
async function plan(id){const c=await pool.connect();try{await c.query('begin read only');await c.query("set local statement_timeout='15s'");const s=(await c.query('select person_postcutover_audit_inputs_with_witness($1) r',[JSON.stringify([id])])).rows[0].r[0];return planAudit(s,auditLib,{complete:true,rows:new Map()});}finally{await c.query('rollback');c.release();}}
test('TT completion consumes the receipt and remains audit neutral',async()=>{const id=await app(),out=await processApp(id,{harvest:'fresh'});assert.equal(out.status,'processed',out.error?.message);const saved=(await pool.query('select * from website_applications where id=$1',[id])).rows[0],receipt=(await pool.query('select application_snapshot from person_application_receipts where application_id=$1',[id])).rows[0].application_snapshot;for(const k of ['harvest_profile','parsed_profile','resume_text','name','contact'])assert.deepEqual(saved[k],receipt[k]);assert.equal((await pool.query('select proof_kind from person_private.application_completions where application_id=$1',[id])).rows[0].proof_kind,'tt_ready');const audit=await plan(out.result.candidateId);assert.equal(audit.status,'verified',audit.reason);});
test('ten TT match IDs from the site embedding catalogue stay supported',async()=>{const ids=Array.from({length:10},()=>`synthetic-site-${randomUUID()}`);for(const id of ids)await pool.query('insert into site_role_embeddings(job_id) values($1)',[id]);const id=await app(),out=await processApp(id,{completion:{version:1,matched_role_ids:ids,screening:null}});assert.equal(out.status,'processed',out.error?.message);assert.deepEqual((await pool.query('select matched_role_ids from website_applications where id=$1',[id])).rows[0].matched_role_ids,ids);});
test('TT payload cannot replace receipt source or candidate identity',async()=>{for(const patch of [{candidate_id:randomUUID()},{parsed_profile:{}},{resume_text:'Unproved'}]){const id=await app(),out=await processApp(id,{completion:{version:1,matched_role_ids:[],screening:null,...patch}});assert.equal(out.status,'failed');assert.equal((await pool.query('select count(*)::int n from person_private.application_completions where application_id=$1',[id])).rows[0].n,0);assert.equal((await pool.query('select status from website_applications where id=$1',[id])).rows[0].status,'queued');}});
test('historical readiness survives a newer completed preference intent',async()=>{const username=`synthetic-history-${randomUUID()}`,old=await app({preferred_roles:['Old']},username);const out=await processApp(old,{afterIntake:async first=>{const later=await processApp(await app({preferred_roles:['New']},username));assert.equal(later.status,'processed',later.error?.message);assert.equal(later.result.candidateId,first.candidateId);}});assert.equal(out.status,'processed',out.error?.message);assert.deepEqual((await pool.query('select role_preferences from candidates where id=$1',[out.result.candidateId])).rows[0].role_preferences.roles,['New']);const audit=await plan(out.result.candidateId);assert.equal(audit.status,'verified',audit.reason);});
test('removed readiness after intake prevents workflow completion',async()=>{const id=await app(),out=await processApp(id,{afterIntake:()=>pool.query('delete from person_private.application_intake_ready where application_id=$1',[id])});assert.equal(out.status,'failed');assert.equal((await pool.query('select count(*)::int n from person_private.application_completions where application_id=$1',[id])).rows[0].n,0);});
