import {createHash} from 'node:crypto';import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';
import * as lib from '../dist/worker-lib.mjs';import {prepareAuditFixture} from './local-fixture.mjs';import {planAudit} from './postcutover.mjs';
const url=process.env.LOCAL_DATABASE_URL;if(!url||new URL(url).pathname!=='/person_postcutover_test'||!['localhost','127.0.0.1'].includes(new URL(url).hostname))throw Error('audit_test_database');
const pool=new pg.Pool({connectionString:url,max:4,statement_timeout:15000,options:'-c timezone=UTC'}),org=lib.TT_ORG_ID;
const id=n=>`ee000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const use=async fn=>{const c=await pool.connect();try{return await fn(c);}finally{c.release();}};
const snapshot=cid=>use(async c=>{try{await c.query('begin');await c.query("set local statement_timeout='15s'");return (await c.query('select person_postcutover_audit_inputs_with_witness($1::jsonb) r',[JSON.stringify([cid])])).rows[0].r[0];}finally{await c.query('rollback');}});
const audit=async(cid,rows=new Map())=>planAudit(await snapshot(cid),lib,{complete:true,rows});
async function seed(n){await pool.query("insert into candidates(id,full_name,linkedin_username,linkedin_url,current_title,created_at) values($1,'Synthetic audit writer',$2,$3,'Original','2020-01-01')",[id(n),`audit-writer-${n}`,`https://www.linkedin.com/in/audit-writer-${n}`]);await prepareAuditFixture(id(n));}
const directory=n=>({board:{contact_id:id(n+1000),name:'Synthetic audit writer',linkedin_url:`https://www.linkedin.com/in/audit-writer-${n}`,updated_at:'2026-09-26'},harvest:null,exps:[],edus:[],emails:[],phones:[],facts:[],identifiers:[]});
async function stage(n,snapshot){const workspaceId=id(n+3000);const claim=await use(c=>lib.claimDirectoryScanOnConnection(c,{organizationId:org,workspaceId}));const staged=await use(c=>lib.stageDirectoryOnConnection(c,{organizationId:org,workspaceId,token:claim.token,snapshot}));return staged.receiptId;}
test.after(()=>pool.end());
for(const [i,writer] of ['application','refresh','directory','recruiter'].entries())for(const mode of ['shadow','live'])test(`${writer} ${mode} first admission and replay retain provable evidence`,async()=>{
 const n=100+i*10+(mode==='live'?1:0);await seed(n);let save,retry,rows=new Map();
 if(writer==='application'){
  await pool.query("insert into website_applications(id,organization_id,name,email,linkedin_username) values($1,$2,'Synthetic audit writer',$3,$4)",[id(n+1000),org,`writer-${n}@example.test`,`audit-writer-${n}`]);
  save=()=>use(c=>lib.saveApplicationPersonOnConnection(c,{organizationId:org,applicationId:id(n+1000),linkedinUsername:`audit-writer-${n}`,name:'Synthetic audit writer',parsed:{current_title:'Incoming'},resumeText:null,mode}));
 }else if(writer==='refresh'){
  await pool.query('insert into refresh_queue(id,candidate_id,organization_id) values($1,$2,$3)',[id(n+1000),id(n),org]);
  await pool.query('insert into candidate_enrichments(id,candidate_id,organization_id,linkedin_username,raw_payload) values($1,$2,$3,$4,$5)',[id(n+2000),id(n),org,`audit-writer-${n}`,{headline:'Incoming'}]);
  const claim=await use(c=>lib.claimRefreshOnConnection(c,{organizationId:org,queueId:id(n+1000),dailyCap:0,allowPaid:false}));assert.equal(claim.status,'claimed');assert.equal(claim.needsHarvest,false);
  save=()=>use(c=>lib.saveRefreshOnConnection(c,{organizationId:org,queueId:id(n+1000),token:claim.token,mode}));
  retry=async()=>{const done=await use(c=>lib.claimRefreshOnConnection(c,{organizationId:org,queueId:id(n+1000),dailyCap:0,allowPaid:false}));assert.equal(done.status,'done');};
 }else if(writer==='recruiter')save=()=>use(c=>lib.saveRecruiterContactOnConnection(c,{organizationId:org,candidateId:id(n),actorId:id(9000),requestId:id(n+1000),contact:{email:`recruiter-${n}@example.test`},mode}));
 else{const s=directory(n),receiptId=await stage(n,s);rows=new Map([[s.board.contact_id,s]]);save=()=>use(c=>lib.saveDirectoryOnConnection(c,{organizationId:org,receiptId,mode}));}
 await save();const first=await audit(id(n),rows);assert.equal(first.status,'verified',JSON.stringify({reason:first.reason,checks:first.checks}));
 await (retry??save)();const replay=await audit(id(n),rows);assert.equal(replay.status,'verified',JSON.stringify({reason:replay.reason,checks:replay.checks}));
});
test('two admitted directory identity snapshots may add timeless identifiers without inventing a fact date',async()=>{
 const n=200;await seed(n);const s=directory(n),first=await stage(n,s);await use(c=>lib.saveDirectoryOnConnection(c,{organizationId:org,receiptId:first,mode:'shadow'}));
 const newer={...s,identifiers:[{kind:'linkedin_username',value:`audit-writer-${n}`},{kind:'airtable_id',value:'rec12345678901234'}]};
 // Existing scan lease is retained; stage in its same workspace/token.
 const token=(await pool.query('select token from person_directory_scans where workspace_id=$1',[id(n+3000)])).rows[0].token;
 const staged=await use(c=>lib.stageDirectoryOnConnection(c,{organizationId:org,workspaceId:id(n+3000),token,snapshot:newer}));await use(c=>lib.saveDirectoryOnConnection(c,{organizationId:org,receiptId:staged.receiptId,mode:'shadow'}));
 const outcome=await audit(id(n),new Map([[s.board.contact_id,newer]]));assert.equal(outcome.status,'verified',JSON.stringify({reason:outcome.reason,checks:outcome.checks}));
});

const rehash=doc=>{const {source,...content}=doc;source.payload_hash=createHash('sha256').update(lib.stableStringify({content,source:source.source,ref:source.source_ref,at:source.fetched_at,v:lib.PARSER_VERSION})).digest('hex');};
test('recruiter receipts prove the complete cleaned request and contacts-only envelope',async()=>{
 const original=await snapshot(id(130));
 for(const mutate of [r=>r.input_hash='0'.repeat(64),r=>{r.document.header.full_name='Injected';rehash(r.document);},r=>{r.document.mode='replace_lists';r.document.jobs=[];rehash(r.document);},r=>{r.requested_contact.github='unproved-handle';r.input_hash=createHash('sha256').update(lib.stableStringify(r.requested_contact)).digest('hex');}]){
  const s=structuredClone(original);mutate(s.recruiter_receipts[0]);assert.equal(planAudit(s,lib,{complete:true,rows:new Map()}).status,'review');
 }
});
test('attributed metadata must equal the immutable receipt values',async()=>{
 for(const [n,scope,field,value] of [[111,'refresh_metadata','linkedin_enrichment_date','2099-01-01'],[121,'directory_metadata','directory_sync_hash','unproved']]){
  const s=await snapshot(id(n)),e=s.events.find(x=>x.attribution?.scope===scope);assert.ok(e);e.payload[field]=value;
  assert.equal(planAudit(s,lib,{complete:true,rows:scope==='directory_metadata'?new Map([[directory(n).board.contact_id,directory(n)]]):new Map()}).status,'review');
 }
});
for(const writer of ['application','directory'])test(`${writer} receipt-created candidate retains exact seed evidence`,async()=>{
 const n=writer==='application'?300:310;let result,rows=new Map();
 if(writer==='application'){
  await pool.query("insert into website_applications(id,organization_id,name,email,linkedin_username) values($1,$2,'Synthetic created writer',$3,$4)",[id(n+1000),org,`created-${n}@example.test`,`audit-writer-${n}`]);
  result=await use(c=>lib.saveApplicationPersonOnConnection(c,{organizationId:org,applicationId:id(n+1000),linkedinUsername:`audit-writer-${n}`,name:'Synthetic created writer',parsed:{current_title:'New applicant'},resumeText:null,mode:'shadow'}));
 }else{const d=directory(n);rows.set(d.board.contact_id,d);const receiptId=await stage(n,d);result=await use(c=>lib.saveDirectoryOnConnection(c,{organizationId:org,receiptId,mode:'shadow'}));}
 const s=await snapshot(result.candidateId);assert.equal(planAudit(s,lib,{complete:true,rows}).status,'verified');
 const bad=structuredClone(s),e=bad.events.find(x=>x.attribution?.scope==='creation');assert.ok(e);e.attribution.candidate_id=id(999);assert.equal(planAudit(bad,lib,{complete:true,rows}).status,'review');
 const changed=structuredClone(s);changed.events.find(x=>x.attribution?.scope==='creation').payload.source='fabricated';assert.equal(planAudit(changed,lib,{complete:true,rows}).status,'review');
});
test('a successful undo and its replay preserve audit proof',async()=>{
 const n=330;await seed(n);await use(c=>lib.savePersonOnConnection(c,lib.fromHarvest({headline:'Updated undo headline'},{id:id(n+1000),created_at:'2026-09-26',organization_id:org},id(n)),{mode:'shadow'}));const projected=await use(c=>lib.publishPersonProjectionOnConnection(c,id(n),{runId:'audit-writer-undo',dryRun:false}));
 const result=await use(c=>lib.undoPersonProjectionOnConnection(c,id(n),projected.revision));assert.equal(result.status,'restored');assert.equal((await audit(id(n))).status,'verified');
 assert.equal((await use(c=>lib.undoPersonProjectionOnConnection(c,id(n),projected.revision))).status,'missing');assert.equal((await audit(id(n))).status,'verified');
});
test('an email-collision undo attempt records no restoration and leaves a valid audit',async()=>{
 const n=340;await pool.query("insert into candidates(id,full_name,linkedin_username,linkedin_url,email,created_at) values($1,'Synthetic undo collision',$2,$3,'undo-before@example.test','2020-01-01')",[id(n),`audit-writer-${n}`,`https://www.linkedin.com/in/audit-writer-${n}`]);await prepareAuditFixture(id(n));
 await use(c=>lib.saveRecruiterContactOnConnection(c,{organizationId:org,candidateId:id(n),actorId:id(9000),requestId:id(n+1000),contact:{email:'undo-after@example.test'},mode:'live'}));
 const before=await snapshot(id(n));assert.equal(planAudit(before,lib,{complete:true,rows:new Map()}).status,'verified');
 await pool.query("insert into candidates(id,full_name,linkedin_username,email) values($1,'Synthetic email owner','audit-undo-owner','undo-before@example.test')",[id(n+1)]);
 const result=await use(c=>lib.undoPersonProjectionOnConnection(c,id(n),before.normalized.state.rev));assert.equal(result.status,'conflict');const after=await snapshot(id(n));assert.equal(planAudit(after,lib,{complete:true,rows:new Map()}).status,'verified');assert.deepEqual(after.candidate,before.candidate);assert.ok(after.operations.some(o=>o.writer==='undo'));assert.equal(after.history.at(-1).restored_at,null);
});
test('same-reference historical jobs cannot replace a newer witnessed owner',async()=>{
 const n=350;await seed(n);
 const doc=lib.fromHarvest({headline:'Historical job',experience:[{position:'Engineer',company:'Synthetic company',description:'Older job',start_date:'2020-01-01'}]},{id:id(n+1000),created_at:'2026-09-24',organization_id:org},id(n));assert.ok(doc.jobs?.length);
 await use(c=>lib.savePersonOnConnection(c,doc,{mode:'shadow'}));const newer=structuredClone(doc);newer.jobs[0].description='Newer job';newer.source.fetched_at='2026-09-25T00:00:00.000Z';rehash(newer);await use(c=>lib.savePersonOnConnection(c,newer,{mode:'shadow'}));
 const s=await snapshot(id(n));assert.equal(planAudit(s,lib,{complete:true,rows:new Map()}).status,'verified');s.normalized.jobs.find(x=>!x.removed_at).description='Older job';s.normalized.jobs.find(x=>!x.removed_at).source_id=s.normalized.sources.find(x=>x.payload_hash===doc.source.payload_hash).id;assert.equal(planAudit(s,lib,{complete:true,rows:new Map()}).status,'review');
});

test('recruiter other-email preserves independently witnessed historical suppression',async()=>{
 const n=360;await seed(n);const doc=lib.fromHarvest({about:'Contact me at suppressed-history@example.test'},{id:id(n+1000),created_at:'2026-09-24',organization_id:org},id(n));assert.equal(doc.contacts[0].never_primary,true);
 await use(c=>lib.savePersonOnConnection(c,doc,{mode:'shadow'}));await use(c=>lib.saveRecruiterContactOnConnection(c,{organizationId:org,candidateId:id(n),actorId:id(9000),requestId:id(n+2000),contact:{otherEmails:['suppressed-history@example.test']},mode:'shadow'}));
 const outcome=await audit(id(n));assert.equal(outcome.status,'verified',outcome.reason);
});
test('a transaction begun before the recruiter but admitted later cannot rewrite earlier suppression proof',async()=>{
 const n=370;await seed(n);const email='suppression-race@example.test';const old=lib.fromHarvest({about:`Contact me at ${email}`},{id:id(n+1000),created_at:'2026-09-24',organization_id:org},id(n));await use(c=>lib.savePersonOnConnection(c,old,{mode:'shadow'}));
 const later=await pool.connect();try{
  await later.query('begin');await later.query('select pg_sleep(0.02)');
  await use(c=>lib.saveRecruiterContactOnConnection(c,{organizationId:org,candidateId:id(n),actorId:id(9000),requestId:id(n+2000),contact:{otherEmails:[email]},mode:'shadow'}));assert.equal((await audit(id(n))).status,'verified');
  const future=lib.fromApplication({id:id(n+3000),organization_id:org,created_at:'2026-09-26',email},false,id(n));await lib.savePersonOnConnection(later,future,{mode:'shadow'});
  const s=await snapshot(id(n));const source=s.normalized.sources.find(x=>x.payload_hash===future.source.payload_hash);assert.ok(Date.parse(source.created_at)<Date.parse(s.recruiter_receipts[0].edited_at));
  const result=planAudit(s,lib,{complete:true,rows:new Map()});assert.equal(result.status,'verified',result.reason);
 }finally{await later.query('rollback');later.release();}
});
test('an exact replay after the edit preserves pre-anchor historical contact evidence',async()=>{
 const n=380;await pool.query("insert into candidates(id,full_name,linkedin_username,linkedin_url,created_at) values($1,'Synthetic historical replay',$2,$3,'2020-01-01')",[id(n),`audit-writer-${n}`,`https://www.linkedin.com/in/audit-writer-${n}`]);
 const raw={about:'Contact me at historical-replay@example.test'};await pool.query("insert into candidate_enrichments(id,candidate_id,organization_id,linkedin_username,raw_payload,created_at) values($1,$2,$3,$4,$5,'2026-09-24')",[id(n+1000),id(n),org,`audit-writer-${n}`,raw]);
 const ledger=(await pool.query('select to_jsonb(l) r from candidate_enrichments l where id=$1',[id(n+1000)])).rows[0].r;const doc=lib.fromHarvest(raw,{...ledger,created_at:new Date(ledger.created_at).toISOString()},id(n));await prepareAuditFixture(id(n),{additionalDocuments:[doc]});
 await use(c=>lib.saveRecruiterContactOnConnection(c,{organizationId:org,candidateId:id(n),actorId:id(9000),requestId:id(n+2000),contact:{otherEmails:['historical-replay@example.test']},mode:'shadow'}));assert.equal((await audit(id(n))).status,'verified');
 await use(c=>lib.savePersonOnConnection(c,doc,{mode:'shadow'}));const result=await audit(id(n));assert.equal(result.status,'verified',result.reason);
});

test('recruiter prior-contact evidence is mandatory and structurally exact',async()=>{
 const original=await snapshot(id(130));for(const edit of [o=>delete o.evidence.prior_contact_flags,o=>o.evidence.prior_contact_flags.push(o.evidence.prior_contact_flags[0]),o=>o.evidence.prior_contact_flags[0].existed='false']){const s=structuredClone(original);edit(s.operations.find(o=>o.writer==='recruiter'));assert.equal(planAudit(s,lib,{complete:true,rows:new Map()}).status,'review');}
});
