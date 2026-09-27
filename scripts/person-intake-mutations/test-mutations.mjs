import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';import {randomUUID} from 'node:crypto';
const url=process.env.LOCAL_DATABASE_URL;if(!/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_intake_mutations_test$/.test(url||''))throw Error('local fixture required');
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
async function processApp(id,{mutate,queryHook,harvest,sourceCheck,parsed={current_title:'Engineer',top_skills:['Synthetic Rust'],education_schools:['Synthetic University']},contacts={phone:'+12025550123'},afterIntake,mode="live",resumeText="Synthetic resume",vector}={}){
 let result,error;const source=(await pool.query('select * from website_applications where id=$1',[id])).rows[0];
 const status=await lib.runApplicationWork({submissionId:id,orgId:TT,boardOrg:null,fromQueue:true},async p=>{
  await lib.startApplicationEffects();let harvestLedgerId;
  if(sourceCheck)await sourceCheck(source);
  if(harvest==='fresh')harvestLedgerId=await lib.storeApplicationHarvest(TT,source.linkedin_username,{id:123,firstName:'Synthetic',lastName:'Profile',skills:[]});
  if(harvest==='cached')harvestLedgerId=(await lib.cachedApplicationHarvest(TT,source.linkedin_username,new Date(0).toISOString()))?.id;
  if(harvest)assert.ok(harvestLedgerId);
  if(mutate)await mutate();const c=await pool.connect();
  const wrapped={query:async(sql,values)=>{if(queryHook)await queryHook(sql,values,c);return c.query(sql,values);}};
  try{result=await lib.saveApplicationPersonOnConnection(wrapped,{organizationId:TT,applicationId:id,linkedinUsername:source.linkedin_username,name:'Resolved Synthetic',parsed,resumeText,resumeContacts:contacts,harvestLedgerId,mode,matchingVector:vector});}
  catch(e){error=e;throw e;}finally{c.release();}
  if(afterIntake)await afterIntake(result);lib.stageApplicationResult({version:1,matched_role_ids:[],screening:null});return 'processed';
 });return{status,result,error};
}
async function roleQuery(sql,args=[]){const c=await pool.connect();try{await c.query('begin');await c.query('set local role service_role');return await c.query(sql,args);}finally{await c.query('rollback');c.release();}}
async function probe(c,fn){await c.query('savepoint synthetic_probe');try{return await fn();}finally{await c.query('rollback to savepoint synthetic_probe');await c.query('release savepoint synthetic_probe');}}

import {prepareAuditFixture} from '../person-audit/local-fixture.mjs';
const incumbent=randomUUID();await pool.query("insert into candidates(id,full_name,linkedin_username,created_at) values($1,'Synthetic',$2,'2020-01-01')",[incumbent,`mutation-${incumbent}`]);await prepareAuditFixture(incumbent);
const filled=randomUUID();await pool.query("insert into candidates(id,full_name,linkedin_username,resume_text,total_experience_years,matching_embedding,embedding_type,created_at) values($1,'Synthetic',$2,'Retained resume',12,$3,'retained','2020-01-01')",[filled,`mutation-${filled}`,JSON.stringify(Array(1536).fill(0.25))]);await prepareAuditFixture(filled);
test('arm intake mutations',async()=>{await pool.query("select person_private.transition_set('arm',1,1,'synthetic_test')");});
test('raw candidate INSERT cannot create an unbound person',async()=>{await assert.rejects(pool.query("insert into candidates(full_name,linkedin_username) values('Synthetic','synthetic-unbound')"),/candidate_mutation_frame/);});
for(const patch of ["resume_text='forged'","total_experience_years=999","follow_up_at='2099-01-01'","visa_status='forged'","embedding_type='forged'"])test(`raw candidate mutation denied: ${patch.split('=')[0]}`,async()=>{await assert.rejects(pool.query(`update candidates set ${patch} where id=$1`,[incumbent]),/candidate_mutation_frame/);});
test('raw TT application receipt-field update is refused',async()=>{const id=await app();await assert.rejects(pool.query("update website_applications set resume_text='forged' where id=$1",[id]),/application_finalize_frame|application_result_frame/);});
test('actual first intake uses typed details, finalization and preferences',async()=>{
 const seen=new Set();const r=await processApp(await app(),{parsed:{current_title:'Engineer',total_experience_years:0},queryHook:async sql=>{for(const fn of ['person_application_candidate_details','person_application_finalize','person_application_preferences'])if(sql.includes(fn+'('))seen.add(fn);}});assert.equal(r.status,'processed',r.error?.message);assert.equal(seen.size,3);const row=(await pool.query('select * from candidates where id=$1',[r.result.candidateId])).rows[0];assert.equal(row.total_experience_years,0);assert.equal(row.resume_text,'Synthetic resume');
});
const v=()=>Array(1536).fill(0.1);
for(const mode of ['live','shadow'])test(`new ${mode} admission can initialize receipt-matched vector`,async()=>{const r=await processApp(await app(),{mode,parsed:{current_title:'Engineer',total_experience_years:3},vector:v()});assert.equal(r.status,'processed',r.error?.message);const row=(await pool.query('select matching_embedding is not null embedded,total_experience_years from candidates where id=$1',[r.result.candidateId])).rows[0];assert.equal(row.embedded,true);assert.equal(row.total_experience_years,3);});
test('existing shadow admission fills resume without an embedding or profile publication',async()=>{const before=(await pool.query('select current_title from candidates where id=$1',[incumbent])).rows[0].current_title;const r=await processApp(await app({},`mutation-${incumbent}`),{mode:'shadow',parsed:{current_title:'Engineer',total_experience_years:99},vector:v()});assert.equal(r.status,'processed',r.error?.message);const row=(await pool.query('select * from candidates where id=$1',[incumbent])).rows[0];assert.equal(row.current_title,before);assert.equal(row.resume_text,'Synthetic resume');assert.equal(row.total_experience_years,null);assert.equal(row.matching_embedding,null);});
test('incumbent resume, vector and experience survive a later application',async()=>{const before=(await pool.query('select resume_text,matching_embedding::text,embedding_type,total_experience_years from candidates where id=$1',[filled])).rows[0];const r=await processApp(await app({},`mutation-${filled}`),{parsed:{current_title:'Engineer',total_experience_years:99},vector:v(),resumeText:'Replacement'});assert.equal(r.status,'processed',r.error?.message);assert.deepEqual((await pool.query('select resume_text,matching_embedding::text,embedding_type,total_experience_years from candidates where id=$1',[filled])).rows[0],before);});
test('replay cannot replace first-admission metadata',async()=>{const id=await app();const r=await processApp(id,{parsed:{current_title:'Engineer',total_experience_years:0},vector:v(),afterIntake:async first=>{const before=(await pool.query('select resume_text,total_experience_years,matching_embedding::text from candidates where id=$1',[first.candidateId])).rows[0];const c=await pool.connect();try{const row=(await c.query('select linkedin_username from website_applications where id=$1',[id])).rows[0];await lib.saveApplicationPersonOnConnection(c,{organizationId:TT,applicationId:id,linkedinUsername:row.linkedin_username,name:'Changed',parsed:{current_title:'Wrong',total_experience_years:99},resumeText:'Changed',matchingVector:Array(1536).fill(0.9),mode:'live'});}finally{c.release();}assert.deepEqual((await pool.query('select resume_text,total_experience_years,matching_embedding::text from candidates where id=$1',[first.candidateId])).rows[0],before);}});assert.equal(r.status,'processed',r.error?.message);});
test('losing matching text cannot initialize a vector',async()=>{const r=await processApp(await app(),{parsed:{current_title:'Engineer'},vector:v(),queryHook:async(sql,values)=>{if(sql.includes('person_application_candidate_details('))values[3]='0'.repeat(64);}});assert.equal(r.status,'processed',r.error?.message);assert.equal((await pool.query('select matching_embedding from candidates where id=$1',[r.result.candidateId])).rows[0].matching_embedding,null);});
for(const vector of [[0.1],Array(1536).fill(NaN)])test(`invalid eligible vector ${vector.length===1?'length':'values'} rolls back intake`,async()=>{const id=await app();const r=await processApp(id,{parsed:{current_title:'Engineer'},vector});assert.equal(r.status,'failed');assert.match(r.error?.message||'',/person_intake_vector/);assert.equal((await pool.query('select count(*)::int n from person_private.application_candidates where application_id=$1',[id])).rows[0].n,0);});
test('SQL UTF16 matching units exactly preserve supplementary and split-surrogate input',async()=>{
 for(const [profile,resume] of [[null,'x'.repeat(1999)+'😀end'],[null,'😀'.repeat(1100)],[{profile_summary:'A😀é𐐀'},'ignored'],[{current_title:'😀',current_company:'Company'},null],[{profile_summary:''},''],[{},'x'.repeat(1999)+'�end']]){
  const bytes=(await pool.query('select person_private.application_matching_units($1,$2) value',[profile,resume])).rows[0].value;assert.deepEqual(bytes,Buffer.from(lib.applicationMatchingText(profile,resume),'utf16le'));
 }
});
test('resume UTF16 cap matches the existing node-postgres encoding behavior',async()=>{
 for(const text of ['x'.repeat(49999)+'😀tail','😀'.repeat(25001),'a'.repeat(50001)]){
  const expected=Buffer.from(text.slice(0,50000),'utf8').toString('utf8');assert.equal((await pool.query('select person_private.resume_utf16_prefix($1) value',[text])).rows[0].value,expected);
 }
 const text='x'.repeat(49999)+'😀tail',r=await processApp(await app(),{resumeText:text});assert.equal(r.status,'processed',r.error?.message);assert.equal((await pool.query('select resume_text from candidates where id=$1',[r.result.candidateId])).rows[0].resume_text,Buffer.from(text.slice(0,50000),'utf8').toString('utf8'));
});
test('foreign operations and removed credentials cannot authorize typed intake',async()=>{
 let checked=false;const r=await processApp(await app(),{queryHook:async(sql,values,c)=>{if(!sql.includes('person_application_candidate_details('))return;checked=true;await probe(c,()=>assert.rejects(c.query(sql,[randomUUID(),...values.slice(1)]),/intake_mutation_operation/));await probe(c,async()=>{await c.query("select set_config('person.work_id','',true),set_config('person.work_token','',true),set_config('request.headers','{}',true)");await assert.rejects(c.query(sql,values),/transition_admission/);});}});assert.equal(r.status,'processed',r.error?.message);assert.ok(checked);
});
test('private mutation frames and Unicode helpers are inaccessible to service',async()=>{for(const fn of ['intake_frame_open(uuid,uuid,uuid,text,jsonb,jsonb)','intake_frame_clear()','intake_mutation_context(uuid)','utf16_bytes(text)','resume_utf16_prefix(text)','application_matching_units(jsonb,text)'])assert.equal((await pool.query("select has_function_privilege('service_role',$1,'EXECUTE') allowed",[`person_private.${fn}`])).rows[0].allowed,false);assert.equal((await pool.query('select count(*)::int n from person_private.intake_mutation_frames')).rows[0].n,0);});
test('same-transaction metadata replay cannot change an already witnessed result',async()=>{
 let checked=false;const r=await processApp(await app(),{parsed:{current_title:'Engineer'},vector:v(),queryHook:async(sql,values,c)=>{if(!sql.includes('person_application_candidate_details('))return;checked=true;await probe(c,async()=>{await c.query(sql,[values[0],values[1],null,null]);await assert.rejects(c.query(sql,values),/intake_metadata_replay/);});}});assert.equal(r.status,'processed',r.error?.message);assert.ok(checked);
});
test('a later BEFORE trigger cannot append unapproved candidate fields',async()=>{
 await pool.query("create function person_private.synthetic_late_candidate_change() returns trigger language plpgsql as $$begin if exists(select 1 from person_private.intake_mutation_frames where backend_pid=pg_backend_pid() and kind='details') then new.notes:='Synthetic forbidden';end if;return new;end$$;create trigger z_synthetic_late_change before update on candidates for each row execute function person_private.synthetic_late_candidate_change()");
 try{const r=await processApp(await app());assert.equal(r.status,'failed');assert.match(r.error?.message||'',/candidate_mutation_frame/);}finally{await pool.query('drop trigger z_synthetic_late_change on candidates;drop function person_private.synthetic_late_candidate_change()');}
});
for(const returned of ['old','null'])test(`a suppressed details update returning ${returned.toUpperCase()} cannot mint a success witness`,async()=>{
 const id=await app();
 await pool.query(`create function person_private.synthetic_suppress_details() returns trigger language plpgsql as $$begin if exists(select 1 from person_private.intake_mutation_frames where backend_pid=pg_backend_pid() and kind='details') then return ${returned};end if;return new;end$$;create trigger z_synthetic_suppress_details before update on candidates for each row execute function person_private.synthetic_suppress_details()`);
 try{const r=await processApp(id);assert.equal(r.status,'failed');assert.match(r.error?.message||'',/candidate_mutation_frame|intake_metadata_write/);assert.equal((await pool.query('select count(*)::int n from person_private.application_candidates where application_id=$1',[id])).rows[0].n,0);assert.equal((await pool.query('select count(*)::int n from person_private.intake_mutation_frames')).rows[0].n,0);}finally{await pool.query('drop trigger z_synthetic_suppress_details on candidates;drop function person_private.synthetic_suppress_details()');}
});
test('checked finalization rejects a late unrelated field change',async()=>{
 let replayed=false;const r=await processApp(await app(),{queryHook:async(sql,values,c)=>{
  if(!sql.includes('person_application_finalize('))return;
  replayed=true;
  await c.query("create function person_private.synthetic_late_finalize() returns trigger language plpgsql as $$begin if exists(select 1 from person_private.intake_mutation_frames where backend_pid=pg_backend_pid() and kind='finalize') then new.status:='forged';end if;return new;end$$;create trigger z_synthetic_late_finalize before update on website_applications for each row execute function person_private.synthetic_late_finalize()");
 }});assert.ok(replayed);assert.equal(r.status,'failed');assert.match(r.error?.message||'',/application_finalize_frame|application_result_frame/);
});
test('identical metadata replay retains exactly one checked witness',async()=>{
 let operation;const r=await processApp(await app(),{vector:v(),queryHook:async(sql,values,c)=>{if(!sql.includes('person_application_candidate_details('))return;operation=values[0];await c.query(sql,values);}});assert.equal(r.status,'processed',r.error?.message);assert.equal((await pool.query('select count(*)::int n from person_private.intake_metadata_witnesses where operation_id=$1',[operation])).rows[0].n,1);
});
for(const phase of ['details','preferences'])test(`${phase} failure rolls back candidate, frame and metadata witness`,async()=>{
 const id=await app();let operation;
 const r=await processApp(id,{queryHook:async(sql,values,c)=>{
  if(sql.includes('person_application_candidate_details('))operation=values[0];
  if(!sql.includes(phase==='details'?'person_application_candidate_details(':'person_application_preferences('))return;
  if(phase==='details')await c.query("update person_private.transition_work set lease_until=clock_timestamp()+interval '100 milliseconds' where id=current_setting('person.work_id')::uuid");
  await c.query(`create function person_private.synthetic_intake_failure() returns trigger language plpgsql as $$begin if exists(select 1 from person_private.intake_mutation_frames where backend_pid=pg_backend_pid() and kind='${phase}') then ${phase==='details'?"perform pg_sleep(0.2);":"raise exception 'synthetic_preferences_failure';"}end if;return new;end$$;create trigger z_synthetic_intake_failure before update on candidates for each row execute function person_private.synthetic_intake_failure()`);
 }});assert.equal(r.status,'failed');assert.match(r.error?.message||'',phase==='details'?/transition_admission|transition_expired/:/synthetic_preferences_failure/);assert.equal((await pool.query('select count(*)::int n from person_private.application_candidates where application_id=$1',[id])).rows[0].n,0);assert.equal((await pool.query('select count(*)::int n from person_private.intake_metadata_witnesses where operation_id=$1',[operation])).rows[0].n,0);assert.equal((await pool.query('select count(*)::int n from person_private.intake_mutation_frames')).rows[0].n,0);
});
test('raw deletion and owner truncation cannot remove candidates',async()=>{
 await assert.rejects(pool.query('delete from candidates where id=$1',[filled]),/candidate_mutation_delete/);
 const c=await pool.connect();try{await c.query('begin');await assert.rejects(c.query('truncate candidates cascade'),/audit_proof_truncate/);}finally{await c.query('rollback');c.release();}
});
