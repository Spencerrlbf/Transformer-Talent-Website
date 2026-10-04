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
