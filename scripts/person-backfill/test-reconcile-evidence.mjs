import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareEvidence,directoryEvidenceHash} from '../person-reconcile.mjs';
import {buildDocs,TT_ORG} from '../person-trial.mjs';
const lib=await import('../dist/worker-lib.mjs');
const id='d0000000-0000-4000-8000-000000000001';
const input=()=>({row:{id,full_name:'Synthetic Evidence',linkedin_username:'synthetic-evidence',created_at:'2025-01-01T00:00:00Z',current_title:'Engineer'},legacy:[],v2:[],ledger:[],apps:[],comms:[],dir:null});
test('irrelevant workflow changes do not invent a new source snapshot',async()=>{
 const inp=input(),sources=(await buildDocs(lib,id,inp)).docs.map(d=>d.source);
 const result=await prepareEvidence(lib,id,inp,[{source_table:'candidates',payload:{...inp.row,status:'engaged'},previous_payload:inp.row}],sources);
 assert.equal(result.review,undefined);assert.equal(result.needsSave,false);
});
test('a dated new Harvest snapshot keeps its real date and can be replayed',async()=>{
 const inp=input();const sources=(await buildDocs(lib,id,inp)).docs.map(d=>d.source);
 const row={id:'d0000000-0000-4000-8000-000000000002',organization_id:TT_ORG,candidate_id:id,provider:'harvest',status:'ok',created_at:'2026-01-01T00:00:00Z',raw_payload:{headline:'Engineer',firstName:'Synthetic',lastName:'Evidence'}};
 inp.ledger=[row];
 const result=await prepareEvidence(lib,id,inp,[{source_table:'candidate_enrichments',payload:row}],sources);
 assert.equal(result.review,undefined);assert.equal(result.needsSave,true);
 assert.equal(result.docs.find(d=>d.source.source==='harvest').source.fetched_at,'2026-01-01T00:00:00.000Z');
});
test('intermediate deleted contact evidence cannot be silently dropped',async()=>{
 const inp=input();
 const old={id:'d0000000-0000-4000-8000-000000000003',candidate_id:id,email_address:'synthetic-old@example.com'};
 const result=await prepareEvidence(lib,id,inp,[{source_table:'candidate_emails',payload:old,previous_payload:old}],[]);
 assert.equal(result.review,'same_snapshot_mutation');
});
test('client organization evidence is rejected before translating or saving',async()=>{
 const inp=input();const row={id:'synthetic-app',candidate_id:id,organization_id:'another-org',created_at:'2026-01-01',email:'synthetic-client@example.com'};
 await assert.rejects(prepareEvidence(lib,id,inp,[{source_table:'website_applications',payload:row}],[]),/source_event_tenancy/);
});
test('a new TT application is preserved as a separate claimed source',async()=>{
 const inp=input();const app={id:'d0000000-0000-4000-8000-000000000004',candidate_id:id,organization_id:TT_ORG,created_at:'2026-01-01T00:00:00Z',email:'synthetic-claim@example.com',name:'Claimed Name'};
 inp.apps=[app];
 const result=await prepareEvidence(lib,id,inp,[{source_table:'website_applications',payload:app}],[]);
 assert.equal(result.review,undefined);
 const doc=result.docs.find(d=>d.source.source==='application');assert.ok(doc);
 assert.equal(doc.contacts[0].status,'claimed');
});
test('an unchanged tied communication keeps the canonical reader order',async()=>{
 const inp=input();
 const email={id:'d0000000-0000-4000-8000-000000000003',candidate_id:id,email_address:'synthetic-tie@example.com'};
 const bounce={id:'d0000000-0000-4000-8000-000000000004',candidate_id:id,communication_type:'email',status:'bounced',email_used:email.id,communication_date:'2026-01-01T00:00:00Z',response_date:null};
 const reply={...bounce,id:'d0000000-0000-4000-8000-000000000005',status:'replied'};
 inp.legacy=[email];inp.comms=[bounce,reply];
 const sources=(await buildDocs(lib,id,inp)).docs.map(d=>d.source);
 const result=await prepareEvidence(lib,id,inp,[{source_table:'candidate_communications',previous_payload:bounce,payload:bounce}],sources);
 assert.equal(result.review,undefined);assert.equal(result.needsSave,false);
});
test('external directory fingerprints track translated facts, not unrelated metadata',()=>{
 const row={board:{contact_id:id,name:'Synthetic Directory',title:'Engineer',updated_at:'2026-01-01'},harvest:null,exps:[],edus:[],emails:[],phones:[]};
 const hash=directoryEvidenceHash(lib,row,id);
 assert.equal(directoryEvidenceHash(lib,{...row,board:{...row.board,unrelated_metric:42}},id),hash);
 assert.notEqual(directoryEvidenceHash(lib,{...row,board:{...row.board,title:'Staff Engineer'}},id),hash);
});
