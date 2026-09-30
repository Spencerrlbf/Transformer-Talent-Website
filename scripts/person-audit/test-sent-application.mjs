// Original insertion evidence is required; later checked edits do not invalidate it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sentApplication} from './evidence.mjs';
import {stableStringify} from '../dist/worker-lib.mjs';
const lib={TT_ORG_ID:'801865a7-6533-41d2-9c45-e4a90e6ad51a',stableStringify};
const cid='aa000000-0000-4000-8000-000000000001',app='aa000000-0000-4000-8000-0000000000a1';
const row={id:app,candidate_id:cid,organization_id:lib.TT_ORG_ID,source:'transformer_talent',status:'processed',email:'original@example.test',resume_text:null};
const {resume_text,...payload}=row;
const event={id:'123',candidate_id:cid,source_table:'website_applications',source_row_id:app,operation:'INSERT',transaction_id:'900',previous_payload:null,payload,actual_event_hash:'a'.repeat(32)};
const snap=()=>({candidate_id:cid,application_sends:[{application_id:app,candidate_id:cid,transaction_id:'900',inserted_row:structuredClone(row),row_hash:'b'.repeat(32),actual_row_hash:'b'.repeat(32),event_id:'123',event_hash:'a'.repeat(32),insert_event:structuredClone(event)}]});
test('a witnessed Send from its exact insert is a pipeline entry',()=>assert.equal(sentApplication(snap(),row,lib,event),true));
test('a later checked resume edit retains the original insert proof',()=>assert.equal(sentApplication(snap(),{...row,resume_path:'new.pdf',resume_text:'new'},lib),true));
for(const [name,change] of [
 ['missing witness',s=>s.application_sends=[]],['duplicate witness',s=>s.application_sends.push(s.application_sends[0])],
 ['missing captured insert',s=>delete s.application_sends[0].insert_event],['changed captured payload',s=>s.application_sends[0].insert_event.payload.email='changed@example.test'],
 ['changed captured hash',s=>s.application_sends[0].insert_event.actual_event_hash='c'.repeat(32)],['changed stored row',s=>s.application_sends[0].actual_row_hash='c'.repeat(32)],
 ['wrong transaction',s=>s.application_sends[0].transaction_id='901'],['wrong event ID',s=>s.application_sends[0].event_id='124'],
 ['wrong person',s=>s.application_sends[0].candidate_id='other'],['not an INSERT',s=>s.application_sends[0].insert_event.operation='UPDATE'],
])test(`Send audit refuses ${name}`,()=>{const s=snap();change(s);assert.equal(sentApplication(s,row,lib),false);});
test('the current raw event must be the witnessed original event',()=>assert.equal(sentApplication(snap(),row,lib,{...event,id:'124'}),false));
test('a changed row status, source or owner is not exempt',()=>{for(const change of [{status:'queued'},{source:'apply'},{organization_id:'other'},{candidate_id:'other'}])assert.equal(sentApplication(snap(),{...row,...change},lib),false);});
