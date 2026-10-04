// After 20261005090000 and 20261005100000: the upgrade preserved every reader's
// pre-upgrade behaviour. A: still no email anywhere (linked reads, net_ drawer,
// Network ranking, Send RPC), and after publication too. B: still the fallback
// (automatic). C: still no phone anywhere while the email stays. Synthetic rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
Object.assign(process.env,{PERSON_TRANSITION_SUPPORT:'on',PERSON_WRITE_MODE:'live',SUPABASE_URL:'http://local-only.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic',PERSON_DATABASE_URL:process.env.LOCAL_DATABASE_URL});
for(const key of ['OPENAI_API_KEY','HARVEST_API_KEY','AIRTABLE_API_TOKEN','RESEND_API_KEY','LLAMA_CLOUD_API_KEY'])delete process.env[key];
import {pool} from './fixture-pool.mjs';
const TT='801865a7-6533-41d2-9c45-e4a90e6ad51a';
const saved=JSON.parse(fs.readFileSync(process.env.UPGRADE_STATE,'utf8'));
const lib=await import('../person-application-edits/dist/contact.mjs');
const row=async(table,id)=>(await pool.query(`select * from ${table} where id=$1`,[id])).rows[0];
const decisions=async(cid)=>(await pool.query('select kind,chosen_value,suppressed from person_recruiter_primary where candidate_id=$1 order by kind',[cid])).rows;
const ranks=async(cid,kind)=>(await pool.query('select value_normalized,rank from candidate_contacts where candidate_id=$1 and kind=$2 order by value_normalized',[cid,kind])).rows;
// REST GETs answered from the database, as in the edits suite.
const restFromDatabase=(actor)=>async(input,init={})=>{
 const u=new URL(String(input));assert.equal(u.origin,'http://local-only.invalid');assert.equal(init.method??'GET','GET');
 if(u.pathname.endsWith('/auth/v1/user'))return Response.json({id:actor,email:'synthetic@example.test'});
 if(u.pathname.endsWith('/org_members'))return Response.json([{member_role:'owner',organizations:{id:TT,slug:'transformer-talent',name:'Synthetic'}}]);
 const table=u.pathname.split('/').at(-1);
 if(!['candidates','candidate_emails','candidate_emails_v2','website_applications','person_recruiter_primary'].includes(table))return Response.json([]);
 if(!(await pool.query('select to_regclass($1) r',[`public.${table}`])).rows[0].r)return Response.json([]);
 const columns=new Set((await pool.query('select column_name from information_schema.columns where table_schema=$1 and table_name=$2',['public',table])).rows.map(r=>r.column_name));
 const expr=(e)=>columns.has(e.split(/->|->>/)[0])?e.replace(/(->>?)([a-z_]+)/g,"$1'$2'"):'null';
 const where=[],args=[];let select='*',limit='';
 for(const [key,raw] of u.searchParams){
  if(key==='select'){select=raw.split(',').map(item=>{const [a,b]=item.split(':');return b?`${expr(b)} as "${a}"`:`${expr(a)} as "${a}"`;}).join(',');continue;}
  if(key==='limit'){limit=` limit ${Number(raw)}`;continue;}
  if(key==='order')continue;
  const m=/^(eq|in|is)\.(.*)$/s.exec(raw);
  if(m[1]==='eq'){args.push(m[2]);where.push(`${key}=$${args.length}`);}
  else if(m[1]==='is')where.push(`${key} is ${m[2]}`);
  else{args.push(m[2].slice(1,-1).split(',').map(v=>v.replace(/^"|"$/g,'')));where.push(`${key}=any($${args.length}::text[]::${key==='id'||key==='candidate_id'?'uuid':'text'}[])`);}
 }
 return Response.json((await pool.query(`select ${select} from ${table}${where.length?` where ${where.join(' and ')}`:''}${limit}`,args)).rows);
};
async function reads(id,cid){
 const prior=globalThis.fetch,priorMode=process.env.PERSON_WRITE_MODE;globalThis.fetch=restFromDatabase(randomUUID());process.env.PERSON_WRITE_MODE='shadow';
 try{
  const detail=await lib.unifiedCandidateDetail(TT,`app_${id}`);
  const compose=await lib.candidateContact(TT,`app_${id}`);
  const net=await lib.unifiedCandidateDetail(TT,`net_${cid}`);
  const c=await row('candidates',cid);
  const ranked=(await lib.poolEmails([cid],new Map([[cid,c.contact?.email??c.email]]))).get(cid)??[];
  return {detail:detail.contact.email,detailPhone:detail.contact.phone,compose:compose.email,net:net.contact.email,netPhone:net.contact.phone,ranked:ranked.map(e=>e.email)};
 }finally{globalThis.fetch=prior;process.env.PERSON_WRITE_MODE=priorMode;}
}
// The caller's snapshot exactly as the server builds it (poolEmails / poolPhone over
// REST rows), so the RPC comparison is the real one.
async function sendRow(cid,job){
 const c=await row('candidates',cid);const t=v=>typeof v==='string'&&v.trim()?v.trim():null;
 const canonical=(await lib.publishedPoolContactsOnConnection(pool,[cid])).get(cid);
 const prior=globalThis.fetch;globalThis.fetch=restFromDatabase(randomUUID());
 let email,phone;
 try{
  const dec=(await lib.recruiterContactDecisions([cid])).get(cid);
  email=canonical?canonical.contact.email:((await lib.poolEmails([cid],new Map([[cid,c.contact?.email??c.email]]))).get(cid)?.[0]?.email??null);
  phone=canonical?canonical.contact.phone:lib.poolPhone(dec,c.contact?.phone,c.phone);
 }finally{globalThis.fetch=prior;}
 return {organization_id:TT,name:c.full_name||'Candidate',email:email??'',linkedin_url:c.linkedin_url??null,linkedin_username:c.linkedin_username??null,role_ids:[job],role_titles:[`Synthetic Role (#${job})`],status:'processed',source:'transformer_talent',candidate_id:cid,
  parsed_profile:{current_title:t(c.current_title),current_company:t(c.current_company),location:t(c.location)},harvest_profile:null,screening:null,contact:canonical||email||phone?{email:email??null,phone:phone??null}:null};
}
const send=async(r)=>(await pool.query('select person_network_send($1::jsonb) r',[JSON.stringify(r)])).rows[0].r;

test('the upgraded schema: suppressed column, Send honours decisions, NOTICE classification',async()=>{
 assert.equal((await pool.query("select count(*)::int n from information_schema.columns where table_name='person_recruiter_primary' and column_name='suppressed'")).rows[0].n,1);
 assert.equal((await pool.query("select position('dec_email' in pg_get_functiondef('public.person_network_send(jsonb,text)'::regprocedure))>0 v")).rows[0].v,true);
});
test('receipt correction refuses an in-flight contact reader without partial writes or waiting',async()=>{
 const reader=await pool.connect(),migration=await pool.connect();
 const sql=fs.readFileSync(new URL('../../supabase/migrations/20261005110000_person_historical_shadow_clears.sql',import.meta.url),'utf8');
 const cid=saved.publishedShadow[0].cid,before=await decisions(cid);
 try{
  await reader.query('begin');
  await reader.query('select count(*) from candidate_contacts where candidate_id=$1',[cid]);
  // An unbounded lock attempt would wait here, or deadlock with a subsequent save.
  await migration.query("set statement_timeout='1500ms'");
  await assert.rejects(migration.query(sql),e=>e.code==='55P03');
  assert.deepEqual(await decisions(cid),before);
 }finally{await reader.query('rollback');await migration.query('reset statement_timeout');reader.release();migration.release();}
});
test('receipt correction is idempotent and restores disabled, replica and always trigger modes',async()=>{
 const fixture=saved.publishedShadow[0],cid=fixture.cid,kind=fixture.kinds[0];
 const sql=fs.readFileSync(new URL('../../supabase/migrations/20261005110000_person_historical_shadow_clears.sql',import.meta.url),'utf8');
 const c=await pool.connect();
 try{
  await c.query('begin');
  // Reproduce the old misclassification inside a rolled-back test transaction.
  await c.query('alter table person_recruiter_primary disable trigger user');
  await c.query('update person_recruiter_primary set suppressed=false where candidate_id=$1 and kind=$2',[cid,kind]);
  await c.query('alter table person_recruiter_primary enable trigger user');
  await c.query('alter table candidate_contacts disable trigger user');
  await c.query('update candidate_contacts set rank=1 where id=(select id from candidate_contacts where candidate_id=$1 and kind=$2 order by value_normalized limit 1)',[cid,kind]);
  await c.query('alter table candidate_contacts enable trigger user');
  await c.query(`create function public.upgrade_trigger_probe() returns trigger language plpgsql as $$begin raise exception 'correction left a trigger enabled';end$$;
   create trigger upgrade_probe_disabled after update on person_recruiter_primary for each row execute function public.upgrade_trigger_probe();
   create trigger upgrade_probe_replica after update on person_recruiter_primary for each row execute function public.upgrade_trigger_probe();
   create trigger upgrade_probe_always after update on candidate_contacts for each row execute function public.upgrade_trigger_probe();
   alter table person_recruiter_primary disable trigger upgrade_probe_disabled;
   alter table person_recruiter_primary enable replica trigger upgrade_probe_replica;
   alter table candidate_contacts enable always trigger upgrade_probe_always;`);
  const modes=async()=>(await c.query("select tgrelid::regclass::text relation,tgname,tgenabled from pg_trigger where tgrelid in ('person_recruiter_primary'::regclass,'candidate_contacts'::regclass) and not tgisinternal order by 1,2")).rows;
  const before=await modes();
  await c.query(sql);
  assert.deepEqual(await modes(),before,'every original trigger mode restored');
  assert.equal((await c.query('select suppressed from person_recruiter_primary where candidate_id=$1 and kind=$2',[cid,kind])).rows[0].suppressed,true);
  assert.equal((await c.query('select count(*)::int n from candidate_contacts where candidate_id=$1 and kind=$2 and rank is not null',[cid,kind])).rows[0].n,0);
  await c.query(sql);
  assert.deepEqual(await modes(),before,'no-op repeat preserves trigger modes too');
  assert.deepEqual((await c.query('select to_jsonb(r) value from person_recruiter_receipts r where id=$1',[fixture.receipt.id])).rows[0].value,fixture.receipt);
 }finally{await c.query('rollback');c.release();}
});
test('A: the historical unpublished shadow clear is still a clear everywhere; publication keeps it',async()=>{
 const {id,cid}=saved.clearA;
 assert.deepEqual(await decisions(cid),[{kind:'email',chosen_value:null,suppressed:true},{kind:'phone',chosen_value:null,suppressed:true}]);
 assert.ok((await pool.query("select count(*)::int n from candidate_emails where candidate_id=$1 and email_address='historical@example.test'",[cid])).rows[0].n>=1,'history kept');
 assert.ok((await ranks(cid,'email')).length>=1&&(await ranks(cid,'email')).every(r=>r.rank===null),'no email ranked after the upgrade');
 assert.deepEqual(await reads(id,cid),{detail:null,detailPhone:null,compose:null,net:null,netPhone:null,ranked:[]});
 // the real checked Send admits the blank snapshot (before this migration it returned contact_changed)
 const r=await send(await sendRow(cid,'9801'));
 assert.equal(r.status,'sent',JSON.stringify(r));
 const a=await row('website_applications',r.applicationId);assert.equal(a.email,'');assert.equal(a.contact,null);
 assert.deepEqual(await send(await sendRow(cid,'9801')),{status:'already_sent'});
 // a stale snapshot (an address the ranking does not admit) is still refused
 assert.deepEqual(await send({...(await sendRow(cid,'9802')),email:'historical@example.test',contact:{email:'historical@example.test',phone:null}}),{status:'contact_changed'});
});
test('B: the published live NULL decision stays automatic (the fallback the recruiter was shown)',async()=>{
 const {cid}=saved.autoB;
 assert.deepEqual(await decisions(cid),[{kind:'email',chosen_value:null,suppressed:false}]);
 assert.ok((await ranks(cid,'email')).some(r=>r.rank===1),'the eligible fallback is still ranked');
 assert.ok(((await lib.publishedPoolContactsOnConnection(pool,[cid])).get(cid)?.contact.email)!=null);
});
test('C: the historical phone-only clear is still a clear on the Network ranking, the net_ drawer and Send; the email stays',async()=>{
 const {id,cid}=saved.clearC;
 assert.deepEqual(await decisions(cid),[{kind:'phone',chosen_value:null,suppressed:true}]);
 const r=await reads(id,cid);
 assert.equal(r.detailPhone,null);assert.equal(r.netPhone,null);
 assert.ok(r.detail,'the email is still there');
 const s=await send(await sendRow(cid,'9803'));
 assert.equal(s.status,'sent',JSON.stringify(s));
 const a=await row('website_applications',s.applicationId);assert.equal(a.contact?.phone??null,null);assert.ok(a.email);
});
test('D: published-then-shadow clears survive upgrade, checked Send and later publication without rewriting evidence',async()=>{
 const {saveRecruiterContactOnConnection}=await import('../dist/worker-lib.mjs');
 for(const [index,fixture] of saved.publishedShadow.entries()){
  const {id,cid,kinds,contact,receipt,projection}=fixture;
  for(const decision of await decisions(cid))assert.equal(decision.suppressed,kinds.includes(decision.kind),`${kinds.join('+')}: ${decision.kind} decision`);
  assert.deepEqual((await pool.query('select to_jsonb(r) value from person_recruiter_receipts r where id=$1',[receipt.id])).rows[0].value,receipt,'immutable receipt unchanged');
  assert.deepEqual((await pool.query('select to_jsonb(p) value from person_projection_state p where candidate_id=$1',[cid])).rows[0].value,projection,'upgrade does not publish or change the legacy projection');
  const found=await reads(id,cid);
  assert.equal(found.detail,contact.email);assert.equal(found.compose,contact.email);assert.equal(found.net,contact.email);
  assert.equal(found.detailPhone,contact.phone);assert.equal(found.netPhone,contact.phone);
  for(const kind of kinds)assert.ok((await ranks(cid,kind)).every(r=>r.rank===null),'history retained but not ranked');
  // The prior publication is stale after the real shadow edit. Live Send must
  // refuse it until a certified live save republishes; do not bypass that gate.
  await assert.rejects(sendRow(cid,String(9810+index)),/person_profile_unavailable/);
  const c=await pool.connect();
  try{
   // Replaying the completed request in live mode must not publish it or alter its receipt.
   const replay=await saveRecruiterContactOnConnection(c,{organizationId:TT,candidateId:cid,actorId:receipt.actor_id,requestId:receipt.id,mode:'live',contact});
   assert.equal(replay.replayed,true);assert.equal(replay.contact.email,contact.email);assert.equal(replay.contact.phone,contact.phone);
   const later=await saveRecruiterContactOnConnection(c,{organizationId:TT,candidateId:cid,actorId:randomUUID(),requestId:randomUUID(),mode:'live',contact});
   assert.equal(later.contact.email,contact.email);assert.equal(later.contact.phone,contact.phone);
  }finally{c.release();}
  const published=(await lib.publishedPoolContactsOnConnection(pool,[cid])).get(cid)?.contact;
  assert.equal(published?.email,contact.email);assert.equal(published?.phone,contact.phone);
  const snapshot=await sendRow(cid,String(9810+index));
  assert.equal(snapshot.email,contact.email??'');assert.equal(snapshot.contact?.phone??null,contact.phone);
  const sent=await send(snapshot);assert.equal(sent.status,'sent',JSON.stringify(sent));
  assert.deepEqual(await send(snapshot),{status:'already_sent'});
  assert.deepEqual((await pool.query('select to_jsonb(r) value from person_recruiter_receipts r where id=$1',[receipt.id])).rows[0].value,receipt);
 }
});
test('E: an older clear cannot override the later chosen contact or its current receipt',async()=>{
 const {id,cid,chosen,receipt}=saved.supersededClear;
 const email=(await decisions(cid)).find(d=>d.kind==='email');
 assert.deepEqual(email,{kind:'email',chosen_value:chosen.email,suppressed:false});
 const found=await reads(id,cid);
 assert.equal(found.detail,chosen.email);assert.equal(found.compose,chosen.email);assert.equal(found.net,chosen.email);
 assert.deepEqual((await pool.query('select to_jsonb(r) value from person_recruiter_receipts r where id=$1',[receipt.id])).rows[0].value,receipt);
});
