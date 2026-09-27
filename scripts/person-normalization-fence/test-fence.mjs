import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';import {randomUUID} from 'node:crypto';
const url=process.env.LOCAL_DATABASE_URL;if(!/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_normalization_fence_test$/.test(url||''))throw Error('local fixture required');
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
let candidate,document;const discriminatorCandidate=randomUUID();
await pool.query("insert into candidates(id,full_name,linkedin_username) values($1,'Synthetic',$2)",[discriminatorCandidate,`synthetic-discriminator-${discriminatorCandidate}`]);
await pool.query("insert into candidate_experiences(id,candidate_id,organization_id,source,title,company_name) values($1,$2,$3,'person','Synthetic','Synthetic')",[randomUUID(),discriminatorCandidate,TT]);
for(const setting of ["person.work_token='00000000-0000-4000-8000-000000000001'", "request.headers='{\"x-person-work-token\":\"00000000-0000-4000-8000-000000000001\"}'"])test(`partial work credentials cannot select the disabled legacy path: ${setting.split('=')[0]}`,async()=>{await assert.rejects(roleQuery(`set local ${setting};update schools set name=name where false`),/normalization_frame/);});
test('arming waits for an already-open legacy normalized write transaction',async()=>{
 const c=await pool.connect();let pending,done=false;
 try{await c.query('begin');await c.query('set local role service_role');await c.query('update schools set name=name where false');pending=pool.query("select person_private.transition_set('arm',1,1,'synthetic_test')").then(x=>{done=true;return x;});await new Promise(r=>setTimeout(r,80));assert.equal(done,false,'arm must wait behind the table statement gate');}
 finally{await c.query('commit');if(pending)await pending;c.release();}
});
test('armed claimed intake executes exact receipt documents and leaves no frame',async()=>{
 const id=await app(),out=await processApp(id);assert.equal(out.status,'processed',out.error?.message);candidate=out.result.candidateId;document=(await pool.query('select documents->0 doc from person_application_receipts where application_id=$1',[id])).rows[0].doc;
 assert.equal((await pool.query('select count(*)::int n from person_private.normalization_frames')).rows[0].n,0);
 assert.ok((await pool.query('select count(*)::int n from candidate_skills where candidate_id=$1',[candidate])).rows[0].n>0);
 assert.ok((await pool.query('select count(*)::int n from candidate_educations where candidate_id=$1',[candidate])).rows[0].n>0);
});
test('unchanged replay still requires admission before the writer early return',async()=>{assert.ok(document);await assert.rejects(roleQuery('select save_person($1)',[document]),/transition_admission|normalization_frame/);});
for(const fn of ['person_company','person_school'])test(`direct ${fn} arguments cannot open normalization authority`,async()=>{await assert.rejects(roleQuery(`select * from ${fn}($1,$2,$3)`,[null,candidate,randomUUID()]),/normalization_frame/);});
test('direct contact reranking cannot use a candidate ID as authority',async()=>{await assert.rejects(roleQuery('select person_rerank_contacts($1)',[candidate]),/normalization_frame/);});
for(const table of ['candidate_sources','candidate_profile_state','candidate_identities','candidate_educations','candidate_skills','candidate_contacts','companies','schools','skills'])test(`armed raw ${table} writes require the private frame`,async()=>{const column=['companies','schools','skills'].includes(table)?'name':'candidate_id';await assert.rejects(roleQuery(`update ${table} set ${column}=${column} where false`),/normalization_frame/);});
test('caller GUCs and valid work tokens cannot forge a frame or change a retained doc',async()=>{
 const id=await app();let checked=false;const out=await processApp(id,{queryHook:async(sql,values,c)=>{
  if(checked||!sql.startsWith('select public.save_person'))return;checked=true;
  await probe(c,async()=>{await c.query("set local person.normalization_frame='true'");await assert.rejects(c.query('update candidate_sources set payload_hash=payload_hash where false'),/normalization_frame/);});
  const bad=structuredClone(values[0]);bad.header={...bad.header,full_name:'Unretained Synthetic'};
  await probe(c,()=>assert.rejects(c.query('select public.save_person($1)',[bad]),/normalization_document/));
 }});assert.equal(out.status,'processed',out.error?.message);assert.ok(checked);
});
test('service cannot execute private cores, read frames or truncate normalized tables',async()=>{
 await assert.rejects(roleQuery('select * from person_private.normalization_frames'),/permission denied/);
 await assert.rejects(roleQuery('select person_private.save_person_core($1)',[document]),/permission denied/);
 const {rows:[{allowed}]}=await pool.query("select has_table_privilege('service_role','candidate_sources','TRUNCATE') allowed");assert.equal(allowed,false);
});
test('person experiences cannot escape the guarded discriminator',async()=>{
 await pool.query("insert into candidate_experiences(id,candidate_id,organization_id,source,title,company_name) values($1,$2,$3,'harvest','Synthetic','Synthetic')",[randomUUID(),candidate,TT]);
 await assert.rejects(roleQuery("update candidate_experiences set source='person' where candidate_id=$1",[candidate]),/normalization_frame/);
});

test('existing person experiences cannot be renamed to bypass protection',async()=>{await assert.rejects(roleQuery("update candidate_experiences set source='harvest' where candidate_id=$1",[discriminatorCandidate]),/normalization_frame/);});
test('an admitted unchanged receipt replay clears its frame before returning',async()=>{
 const id=await app();let replay;const out=await processApp(id,{afterIntake:async first=>{const c=await pool.connect();try{await c.query('begin');await c.query("select set_config('request.headers',$1,true)",[JSON.stringify(lib.transitionRequestHeaders())]);const d=(await c.query('select documents->0 doc from person_application_receipts where application_id=$1',[id])).rows[0].doc;replay=(await c.query('select save_person($1) r',[d])).rows[0].r;assert.equal((await c.query('select count(*)::int n from person_private.normalization_frames')).rows[0].n,0);await c.query('commit');}finally{await c.query('rollback');c.release();}}});assert.equal(out.status,'processed',out.error?.message);assert.equal(replay.status,'unchanged');
});
test('a core failure rolls back facts and removes the private execution frame',async()=>{
 await pool.query("create function person_private.synthetic_normalization_failure() returns trigger language plpgsql as $$begin if exists(select 1 from person_private.normalization_frames where backend_pid=pg_backend_pid()) then raise exception 'synthetic_core_failure';else raise exception 'synthetic_frame_missing';end if;end$$;create trigger synthetic_normalization_failure before insert on candidate_skills for each row execute function person_private.synthetic_normalization_failure()");
 const id=await app();try{const out=await processApp(id);assert.equal(out.status,'failed');assert.match(out.error?.message||'',/synthetic_core_failure/);assert.equal((await pool.query('select count(*)::int n from person_private.normalization_frames')).rows[0].n,0);assert.equal((await pool.query('select count(*)::int n from person_application_receipts where application_id=$1',[id])).rows[0].n,0);}finally{await pool.query('drop trigger synthetic_normalization_failure on candidate_skills;drop function person_private.synthetic_normalization_failure()');}
});
test('concurrent admitted applications converge on one shared school and skill',async()=>{
 const suffix=randomUUID(),school=`Synthetic Shared ${suffix}`,skill=`Synthetic Skill ${suffix}`,a=await app(),b=await app(),parsed={education_schools:[school],top_skills:[skill]};const rows=await Promise.all([processApp(a,{parsed}),processApp(b,{parsed})]);for(const r of rows)assert.equal(r.status,'processed',r.error?.message);
 const ids=rows.map(r=>r.result.candidateId);assert.equal((await pool.query('select count(distinct school_id)::int n from candidate_educations where candidate_id=any($1)',[ids])).rows[0].n,1);assert.equal((await pool.query('select count(distinct skill_id)::int n from candidate_skills where candidate_id=any($1)',[ids])).rows[0].n,1);assert.equal((await pool.query('select count(*)::int n from person_private.normalization_frames')).rows[0].n,0);
});
