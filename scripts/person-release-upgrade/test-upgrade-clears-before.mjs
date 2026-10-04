// Upgrade path, before 20261005090000/100000 are applied: HISTORICAL recruiter
// decisions in the shape the old writer left them (chosen_value NULL, receipt with
// the requested NULL), for people in the states the old readers distinguished:
//   A. unpublished, shadow clear, verified historical address + stale scalar
//      (every reader showed NO email before the upgrade);
//   B. published (projection state), live NULL decision (the ranking showed the
//      eligible fallback before the upgrade);
//   C. unpublished, phone-only clear with a stale scalar phone and a valid email.
// Ids go to UPGRADE_STATE for the after-phase. Synthetic rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {pool} from './fixture-pool.mjs';
const TT='801865a7-6533-41d2-9c45-e4a90e6ad51a';
const state=process.env.UPGRADE_STATE;if(!state)throw Error('UPGRADE_STATE required');
const saved=JSON.parse(fs.readFileSync(state,'utf8'));
const row=async(table,id)=>(await pool.query(`select * from ${table} where id=$1`,[id])).rows[0];
async function disabled(fn){await pool.query("update person_private.transition_control set enabled=false where singleton");try{return await fn();}finally{await pool.query("update person_private.transition_control set enabled=true,phase='open' where singleton");}}
// An UNPUBLISHED normalized person linked to a TT application: a legacy pool row
// reconciled and anchored by the current translator (as the catch-up does), then a
// raw application row linking it (admitted while the controller is disabled).
async function unpublishedLinked(){
 const cid=randomUUID(),username=`upgrade-clear-${cid.slice(0,8)}`;
 const url=process.env.LOCAL_DATABASE_URL;
 return disabled(async()=>{
  await pool.query("insert into candidates(id,full_name,linkedin_username,linkedin_url,email,current_title,current_company,source,created_at) values($1,'Synthetic Upgrade',$2::text,'https://www.linkedin.com/in/'||$2::text,$3,'Engineer','Example Corp','future','2025-01-01')",[cid,username,`${cid}@example.test`]);
  const {pgSite}=await import('../person-trial.mjs'),{reconcilePage}=await import('../person-reconcile.mjs');
  const {openAnchorDatabase}=await import('../person-audit/database.mjs'),{prepareAnchors}=await import('../person-audit-anchors.mjs');
  const lib=await import('../dist/worker-lib.mjs');
  const site=await pgSite(url),run=`upg-${cid.slice(0,8)}`;
  try{await site.rpc('person_reconcile_start',{p_run:run,p_commit:'c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc',p_limit:1000,p_batch:100,p_resume:false,p_scope:'queue',p_external_hash:'1'.repeat(32)});
   let page;while((page=await site.rpc('person_reconcile_page',{p_run:run,p_size:100}))?.length)await reconcilePage({site,lib,config:{run,dry:false},page});}
  finally{await site.end?.();}
  assert.equal((await pool.query('select status from person_reconcile_people where run_id=$1 and candidate_id=$2',[run,cid])).rows[0]?.status,'verified');
  const anchors=await openAnchorDatabase({LOCAL_DATABASE_URL:url});
  try{await prepareAnchors({site:anchors,prepare:lib.prepareLegacyAuditAnchor,options:{save:true,limit:1000,batch:50,after:null,maxSeconds:60,maxBytes:1e12},onProgress:()=>{}});}finally{await anchors.end();}
  const [a]=(await pool.query("insert into website_applications(organization_id,name,email,linkedin_url,linkedin_username,candidate_id,role_ids,role_titles,status,source,contact) values($1,'Synthetic Upgrade','submitted@example.test','https://www.linkedin.com/in/'||$2::text,$2::text,$3,array['9700'],array['Synthetic Role (#9700)'],'processed','website_applicant',$4::jsonb) returning id",[TT,username,cid,JSON.stringify({email:'submitted@example.test',phone:null})])).rows;
  return {id:a.id,cid};
 });
}
// What the OLD writer left behind for a clear: the receipt (requested/effective NULL)
// and the decision row; the overlay cleared; history and scalars untouched.
async function oldClear(cid,mode,{email=true,phone=true,scalarEmail,scalarPhone,touchRow=true}={}){
 const receipt=randomUUID();
 await disabled(async()=>{
  if(touchRow){
   await pool.query("insert into candidate_emails(candidate_id,email_address,email_type,quality,result) values($1,'historical@example.test','personal','good','ok') on conflict do nothing",[cid]);
   await pool.query("update candidates set email=coalesce($2,email),phone=coalesce($3,phone),contact=jsonb_build_object('email',case when $4 then null else contact->>'email' end,'phone',case when $5 then null else contact->>'phone' end) where id=$1",[cid,scalarEmail??null,scalarPhone??null,email,phone]);
  }
  await pool.query("insert into person_recruiter_receipts(id,candidate_id,actor_id,input_hash,edited_at,requested_contact,before_contact,effective_contact,document,mode) values($1,$2,$3,'synthetic',clock_timestamp(),$4::jsonb,'{}'::jsonb,$4::jsonb,'{}'::jsonb,$5)",
   [receipt,cid,randomUUID(),JSON.stringify({email:email?null:'kept@example.test',phone:phone?null:'+15125550100',github:null,otherEmails:[]}),mode]);
  for(const kind of [...(email?['email']:[]),...(phone?['phone']:[])])
   await pool.query("insert into person_recruiter_primary(candidate_id,kind,chosen_value,receipt_id) values($1,$2,null,$3) on conflict(candidate_id,kind) do update set chosen_value=null,receipt_id=excluded.receipt_id",[cid,kind,receipt]);
  if(touchRow)await pool.query('select public.person_rerank_contacts($1)',[cid]);
 });
 return receipt;
}
test('the pre-clear schema: no suppressed column, Send ignores decisions',async()=>{
 assert.equal((await pool.query("select count(*)::int n from information_schema.columns where table_name='person_recruiter_primary' and column_name='suppressed'")).rows[0].n,0);
 assert.equal((await pool.query("select position('dec_email' in pg_get_functiondef('public.person_network_send(jsonb,text)'::regprocedure))>0 v")).rows[0].v,false);
});
test('A: unpublished shadow clear with history and a stale scalar',async()=>{
 const {id,cid}=await unpublishedLinked();
 assert.equal((await pool.query('select count(*)::int n from person_projection_state where candidate_id=$1',[cid])).rows[0].n,0);
 await oldClear(cid,'shadow',{scalarEmail:'stale@example.test'});
 saved.clearA={id,cid};
 // the old readers (this checkout's TypeScript at the previous commit) showed NO email
 // here; the ranking still ranks the history (pre-migration behaviour for the pool)
 assert.ok((await pool.query("select count(*)::int n from candidate_contacts where candidate_id=$1 and kind='email' and rank=1",[cid])).rows[0].n>=1,'the old ranking kept a rank-1 email');
});
test('B: published person with a live NULL decision (the fallback was shown)',async()=>{
 // a person phase 1 published (projection state present), with an eligible address
 const r=(await pool.query("select a.id,a.candidate_id cid from website_applications a join person_projection_state p on p.candidate_id=a.candidate_id join candidate_contacts c on c.candidate_id=a.candidate_id and c.kind='email' and c.rank=1 where a.organization_id=$1 and not exists(select 1 from person_recruiter_primary rp where rp.candidate_id=a.candidate_id) order by a.created_at limit 1",[TT])).rows[0];
 assert.ok(r,'a published person from phase 1');
 const {id,cid}=r;
 assert.equal((await pool.query('select count(*)::int n from person_projection_state where candidate_id=$1',[cid])).rows[0].n,1);
 // the old live writer re-projected in its own transaction; here only the decision
 // and its receipt are added, the published row and ranks stay as phase 1 left them
 await oldClear(cid,'live',{phone:false,touchRow:false});
 saved.autoB={id,cid};
});
test('C: unpublished phone-only clear with a stale scalar phone',async()=>{
 const {id,cid}=await unpublishedLinked();
 await oldClear(cid,'shadow',{email:false,scalarPhone:'+15125550199'});
 saved.clearC={id,cid};
});
test('D: certified shadow clears AFTER publication on the old schema retain their receipts and publication',async()=>{
 process.env.PERSON_TRANSITION_SUPPORT='on';
 const {saveRecruiterContactOnConnection}=await import('../dist/worker-lib.mjs');
 saved.publishedShadow=[];
 for(const kinds of [['email'],['phone'],['email','phone']]){
  const {id,cid}=await unpublishedLinked();
  const chosen={email:`published-${cid}@example.test`,phone:'+15125550177',github:null,otherEmails:[]};
  const c=await pool.connect();
  try{
   const save=async(contact,mode,requestId=randomUUID())=>saveRecruiterContactOnConnection(c,{organizationId:TT,candidateId:cid,actorId:randomUUID(),requestId,mode,contact});
   await save(chosen,'live');
   const projection=(await c.query('select to_jsonb(p) value from person_projection_state p where candidate_id=$1',[cid])).rows[0].value;
   const requestId=randomUUID(),contact={...chosen,...Object.fromEntries(kinds.map(k=>[k,null]))};
   const result=await save(contact,'shadow',requestId);
   assert.deepEqual(result.contact,contact,'the actual old writer returned the explicit clear');
   assert.deepEqual((await c.query('select to_jsonb(p) value from person_projection_state p where candidate_id=$1',[cid])).rows[0].value,projection,'shadow save retains publication');
   const receipt=(await c.query('select to_jsonb(r) value from person_recruiter_receipts r where id=$1',[requestId])).rows[0].value;
   assert.ok(receipt.result,'completed receipt');
   assert.equal((await c.query('select completed_at is not null done from person_private.recruiter_saves where id=$1',[requestId])).rows[0].done,true);
   for(const kind of kinds){
    assert.equal(receipt.requested_contact[kind],null);assert.equal(receipt.effective_contact[kind],null);
    assert.ok((await c.query('select count(*)::int n from candidate_contacts where candidate_id=$1 and kind=$2 and rank=1',[cid,kind])).rows[0].n>0,'old ranking retains the historical contact');
   }
   saved.publishedShadow.push({id,cid,kinds,contact,receipt,projection});
  }finally{c.release();}
 }
});
test('E: a later certified choice supersedes a historical shadow clear',async()=>{
 process.env.PERSON_TRANSITION_SUPPORT='on';
 const {saveRecruiterContactOnConnection}=await import('../dist/worker-lib.mjs');
 const {id,cid}=await unpublishedLinked(),c=await pool.connect();
 const chosen={email:`later-${cid}@example.test`,phone:'+15125550188',github:null,otherEmails:[]};
 try{
  const save=(contact,mode)=>saveRecruiterContactOnConnection(c,{organizationId:TT,candidateId:cid,actorId:randomUUID(),requestId:randomUUID(),mode,contact});
  await save(chosen,'live');
  await save({...chosen,email:null},'shadow');
  const later=await save(chosen,'shadow');
  assert.equal(later.contact.email,chosen.email);
  const receipt=(await c.query('select to_jsonb(r) value from person_recruiter_primary p join person_recruiter_receipts r on r.id=p.receipt_id where p.candidate_id=$1 and p.kind=\'email\'',[cid])).rows[0].value;
  saved.supersededClear={id,cid,chosen,receipt};
 }finally{c.release();}
});
test.after(()=>fs.writeFileSync(state,JSON.stringify(saved)));
