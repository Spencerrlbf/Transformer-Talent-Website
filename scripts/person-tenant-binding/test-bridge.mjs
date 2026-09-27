import test from 'node:test';import assert from 'node:assert/strict';
for(const key of ['OPENAI_API_KEY','HARVEST_API_KEY','AIRTABLE_API_TOKEN','RESEND_API_KEY','LLAMA_CLOUD_API_KEY'])delete process.env[key];
Object.assign(process.env,{PERSON_TRANSITION_SUPPORT:'on',PERSON_WRITE_MODE:'live',SUPABASE_URL:'http://tenant-binding.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic'});
const org='cc000000-0000-4000-8000-000000000001',app='cc000000-0000-4000-8000-000000000002',work='cc000000-0000-4000-8000-000000000003',key='cc000000-0000-4000-8000-000000000004';
let calls=[],username='synthetic',response={},rpcFailure=false;
globalThis.fetch=async(input,init={})=>{const u=new URL(String(input));assert.equal(u.origin,'http://tenant-binding.invalid');const fn=u.pathname.split('/').at(-1),body=JSON.parse(init.body||'{}');calls.push(fn);
 if(fn==='person_application_work_claim')return Response.json({status:'admitted',work_id:work,generation:0,lease_until:new Date(Date.now()+60000).toISOString(),review_reserved:true,input_hash:'a'.repeat(64),snapshot:{id:app,organization_id:org,input_version:1,name:'Synthetic',email:'synthetic@example.test',linkedin_username:username,linkedin_url:username?`https://www.linkedin.com/in/${username}`:null,source:'applied',role_ids:[],contact:{}}});
 if(fn==='organizations')return Response.json([{id:org,slug:'synthetic',name:'Synthetic'}]);
 if(fn==='person_application_work_start')return Response.json({status:'started',work_id:work});
 if(fn==='person_transition_renew')return Response.json({status:'admitted',work_id:work,lease_until:new Date(Date.now()+60000).toISOString()});
 if(fn==='person_application_work_finish')return Response.json({status:body.p_outcome,work_id:work});
 if(fn==='person_application_tenant_bind'){assert.equal(new Headers(init.headers).get('x-person-work-id'),work);if(rpcFailure)return Response.json({message:'synthetic_binding_failure'},{status:409});return Response.json({work_id:work,application_id:app,organization_id:org,person_key:key,...response});}
 if(fn==='website_applications')return Response.json([{id:key}]);throw Error('unexpected_path');
};
const lib=await import('./dist/processing.mjs');
test.beforeEach(()=>{calls=[];username='synthetic';response={};rpcFailure=false;});
async function run(args=[org,username,app]){let person;const status=await lib.runApplicationWork({submissionId:app,orgId:org,boardOrg:null,fromQueue:true},async()=>{await lib.startApplicationEffects();person=await lib.tenantPersonId(...args);return 'processed';});return{status,person};}
for(const missing of [false,true])test(`claimed ${missing?'missing':'present'} username uses the checked bridge`,async()=>{username=missing?null:'synthetic';const r=await run();assert.equal(r.status,'processed');assert.equal(r.person,key);assert.ok(calls.includes('person_application_tenant_bind'));assert.ok(!calls.includes('website_applications'));});
for(const field of [0,1,2])test(`mismatched argument ${field} cannot reach the RPC`,async()=>{const args=[org,username,app];args[field]='cc000000-0000-4000-8000-000000000099';assert.equal((await run(args)).status,'failed');assert.ok(!calls.includes('person_application_tenant_bind'));});
for(const patch of [{work_id:key},{application_id:key},{organization_id:key},{person_key:'invalid'}])test(`malformed ${Object.keys(patch)[0]} response cannot fall back to REST`,async()=>{response=patch;assert.equal((await run()).status,'failed');assert.ok(!calls.includes('website_applications'));});
test('a failed binding RPC cannot fall back to the submission or REST',async()=>{rpcFailure=true;assert.equal((await run()).status,'failed');assert.ok(!calls.includes('website_applications'));});
test('legacy lookup and missing-identity behavior remain unchanged',async()=>{process.env.PERSON_TRANSITION_SUPPORT='off';try{assert.equal(await lib.tenantPersonId(org,username,app),key);assert.equal(await lib.tenantPersonId(org,null,app),app);assert.deepEqual(calls,['website_applications']);}finally{process.env.PERSON_TRANSITION_SUPPORT='on';}});
test('support on rejects missing admission for both identity shapes',async()=>{for(const value of [null,username])await assert.rejects(lib.tenantPersonId(org,value,app),/transition_admission/);assert.deepEqual(calls,[]);});
