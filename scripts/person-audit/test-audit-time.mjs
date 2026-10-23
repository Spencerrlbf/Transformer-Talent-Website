import test from 'node:test';import assert from 'node:assert/strict';import * as lib from '../dist/worker-lib.mjs';import {metadataEvidence} from './mutations.mjs';
test('metadata reconstruction uses the captured event clock across later calendar years',t=>{
 const before={id:'synthetic-time',work_experience:[{title:'Software Engineer',company:'Synthetic Company',start_date:{year:2020,month:1},is_current:true}],linkedin_enrichment_date:null,calculated_experience_years:null};
 const date='2026-09-26T00:00:00.000Z',value=Math.round(lib.poolSignals(before,new Date(date)).years);
 const receipt={phase:'done',queue_id:'synthetic-queue',ledger_snapshot:{created_at:date}},snapshot={refresh_receipts:[receipt]},op={receipt_ref:'refresh:synthetic-queue'};
 const e={recorded_at:date,previous_payload:before,payload:{...before,linkedin_enrichment_date:date,calculated_experience_years:value},attribution:{scope:'refresh_metadata'}};
 t.mock.timers.enable({apis:['Date'],now:new Date('2028-09-26')});assert.equal(metadataEvidence(snapshot,e,op,lib),true);
});
