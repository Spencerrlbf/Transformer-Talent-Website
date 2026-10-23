import test from 'node:test';import assert from 'node:assert/strict';
Object.assign(process.env,{PERSON_TRANSITION_SUPPORT:'on',PERSON_WRITE_MODE:'live',SUPABASE_URL:'http://completion.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic'});
for(const key of ['OPENAI_API_KEY','HARVEST_API_KEY','AIRTABLE_API_TOKEN','RESEND_API_KEY','LLAMA_CLOUD_API_KEY'])delete process.env[key];
const org='cc000000-0000-4000-8000-000000000001',app='cc000000-0000-4000-8000-000000000002',work='cc000000-0000-4000-8000-000000000003';
let calls=[],completed=false,lost=false,badResponse=false,providers=0;
globalThis.fetch=async(input,init={})=>{const u=new URL(String(input));assert.equal(u.origin,'http://completion.invalid');const fn=u.pathname.split('/').at(-1),body=JSON.parse(init.body||'{}');calls.push({fn,body});
 if(fn==='person_application_work_claim')return Response.json(completed?{status:'completed',work_id:work}:{status:'admitted',work_id:work,generation:0,lease_until:new Date(Date.now()+60000).toISOString(),review_reserved:true,input_hash:'a'.repeat(64),snapshot:{id:app,organization_id:org,input_version:1,name:'Synthetic',email:'synthetic@example.test',linkedin_username:null,linkedin_url:null,source:'applied',role_ids:[],contact:{}}});
 if(fn==='organizations')return Response.json([{id:org,slug:'synthetic',name:'Synthetic'}]);
 if(fn==='person_application_work_start')return Response.json({status:'started',work_id:work});
 if(fn==='person_transition_renew')return Response.json({status:'admitted',work_id:work,lease_until:new Date(Date.now()+60000).toISOString()});
 if(fn==='person_application_work_complete'){assert.equal(new Headers(init.headers).get('x-person-work-id'),work);assert.deepEqual(Object.keys(body),['p_result']);completed=true;if(lost)throw Error('synthetic_lost_response');return Response.json({status:'completed',work_id:badResponse?app:work});}
 if(fn==='person_application_work_finish'){if(completed)return Response.json({message:'transition_state'},{status:409});return Response.json({status:body.p_outcome,work_id:work});}
 throw Error('unexpected_path');
};
const lib=await import('./dist/processing.mjs'),input={submissionId:app,orgId:org,boardOrg:null,fromQueue:true},result={version:1,matched_role_ids:[],screening:null,name:'Synthetic',harvest_profile:null,parsed_profile:null,resume_text:null,resume_contacts:{phone:null,emails:[]}};
test.beforeEach(()=>{calls=[];completed=false;lost=false;badResponse=false;providers=0;});
async function run(stage=true,twice=false){return lib.runApplicationWork(input,async()=>{await lib.startApplicationEffects();providers++;if(stage){lib.stageApplicationResult(result);if(twice)lib.stageApplicationResult(result);}return 'processed';});}
test('processed callback without a staged result cannot complete',async()=>{assert.equal(await run(false),'failed');assert.ok(!calls.some(c=>c.fn==='person_application_work_complete'));assert.equal(calls.at(-1).body.p_outcome,'uncertain');});
test('one staged result uses only the atomic completion endpoint',async()=>{assert.equal(await run(),'processed');assert.equal(calls.at(-1).fn,'person_application_work_complete');assert.ok(!calls.some(c=>c.fn==='person_application_work_finish'));});
test('a second staged result is rejected before completion',async()=>{assert.equal(await run(true,true),'failed');assert.ok(!calls.some(c=>c.fn==='person_application_work_complete'));});
test('lost response recovery never repeats processing or downgrades completion',async()=>{lost=true;assert.equal(await run(),'failed');assert.equal(completed,true);assert.equal(await run(),'processed');assert.equal(providers,1);assert.equal(calls.filter(c=>c.fn==='person_application_work_complete').length,1);});
test('malformed completion response is not accepted',async()=>{badResponse=true;assert.equal(await run(),'failed');assert.equal(completed,true);});
test('staging outside an admitted started context fails',()=>{assert.throws(()=>lib.stageApplicationResult(result),/application_result_stage/);});
