import {createHash} from 'node:crypto';import test from 'node:test';import assert from 'node:assert/strict';
for(const key of ['OPENAI_API_KEY','HARVEST_API_KEY','AIRTABLE_API_TOKEN','RESEND_API_KEY','NOTION_TOKEN','TYPESAFE_API_KEY','LLAMA_CLOUD_API_KEY'])delete process.env[key];
Object.assign(process.env,{PERSON_TRANSITION_SUPPORT:'on',PERSON_WRITE_MODE:'live',SUPABASE_URL:'http://queue.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic'});
const TT='801865a7-6533-41d2-9c45-e4a90e6ad51a',TENANT='cf000000-0000-4000-8000-000000000001',id='cf000000-0000-4000-8000-000000000002',work='cf000000-0000-4000-8000-000000000003';
let calls=[],claimResult,startStatus='started',failFinalize=false,notifications=false,sent=0,failRenew=false,emptyFinalize=false,contactFixture=false,failContact=false,resumeSize=null,queueRows=null;
const snapshot={id,organization_id:TENANT,name:'Synthetic',email:'synthetic@example.test',linkedin_username:'synthetic',linkedin_url:'https://www.linkedin.com/in/synthetic',visa_status:null,preferred_locations:[],role_ids:[],resume_path:null,person_resume_sha256:null,source:'future',follow_up_at:null,preferred_roles:[],preferred_workplace:[],comp_expectation:null,input_version:1};
const input={submissionId:id,name:'untrusted callback copy',email:'ignored@example.test',linkedin:'ignored',visa:'',preferredLocations:[],roleIds:['ignored'],speculative:false,resumeBuf:null,resumeSafeName:'synthetic.pdf',resumePath:null,boardOrg:null,orgId:TENANT,applicationType:'Applied',fromQueue:true};
let cacheFixture=false;
const cacheProfile={must_haves:[],nice_to_haves:[],screening_questions:['Synthetic question'],min_years:null,visa_transfer_ok:true,onsite_city:null};
const cacheRole={id:'cf000000-0000-4000-8000-000000000077',external_id:'synthetic-role',title:'Synthetic',matching_profile:cacheProfile,tech_stack:'',locations:[]};
function admitted(patch={}){return{status:'admitted',work_id:work,generation:0,lease_until:new Date(Date.now()+60000).toISOString(),review_reserved:true,input_hash:'a'.repeat(64),snapshot:{...snapshot,...patch}};}
globalThis.fetch=async(input,init={})=>{
 if(cacheFixture&&String(input).startsWith('https://api.openai.com/'))return Response.json(String(input).includes('/embeddings')?{data:[{embedding:Array(1536).fill(0.1)}]}:{choices:[{message:{content:JSON.stringify({current_title:'Engineer',profile_summary:'Synthetic profile',top_skills:[]})}}]});
 const u=new URL(String(input));if(u.origin==='https://api.cloud.llamaindex.ai'){assert.ok(contactFixture);return Response.json(u.pathname.endsWith('/upload')?{id:'synthetic'}:u.pathname.endsWith('/markdown')?{markdown:'Synthetic Resume\nPhone: +1 202 555 0123'}:{status:'SUCCESS'});}if(u.origin==='https://api.resend.com'){assert.ok(notifications);sent++;return Response.json({id:'synthetic-notification'});}assert.equal(u.origin,'http://queue.invalid','no provider or other outbound request');
 if(resumeSize&&u.pathname.startsWith('/storage/'))return resumeSize==='header'?new Response('synthetic',{headers:{'content-length':String(9*1024*1024)}}):new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(8*1024*1024+1));c.close();}}));
 const body=init.body?JSON.parse(init.body):null;calls.push({path:u.pathname,method:init.method||'GET',body});
 if(cacheFixture&&u.pathname.endsWith('/org_roles'))return Response.json([cacheRole]);
 if(cacheFixture&&u.pathname.endsWith('/website_applications')&&u.searchParams.has('harvest_profile'))return Response.json([{harvest_profile:{firstName:'Synthetic',skills:[]}}]);
 if(cacheFixture&&u.pathname.endsWith('/match_org_roles'))return Response.json([{org_role_id:cacheRole.id,external_id:cacheRole.external_id,title:'Synthetic',similarity:0.9}]);
 if(cacheFixture&&u.pathname.endsWith('/match_verdicts')&&(!init.method||init.method==='GET'))return Response.json([{id:work,org_role_id:cacheRole.id,role_hash:createHash('sha256').update(JSON.stringify({m:cacheProfile.must_haves,q:cacheProfile.screening_questions})).digest('hex'),surfaced_count:1,verdict:{qualified:true,fit_score:0.8,answers:[],facts:{synthetic:true},origin_signal:'Synthetic cached origin'}}]);
 if(u.pathname.endsWith('/person_application_work_queue'))return Response.json({applications:(queueRows??[{id,organization_id:TENANT}]).slice(0,body.p_limit),waiting:queueRows?.length??1,review_required:0});
 if(u.pathname.endsWith('/person_application_work_claim'))return Response.json(queueRows&&body.p_org===TT?{status:'budget'}:claimResult);
 if(u.pathname.endsWith('/person_application_tenant_bind'))return Response.json({work_id:work,application_id:id,organization_id:TENANT,person_key:id});
 if(u.pathname.endsWith('/person_application_work_start'))return Response.json({status:startStatus,work_id:work});
 if(u.pathname.endsWith('/person_application_work_review'))return Response.json({status:'input_review',work_id:work});
 if(u.pathname.endsWith('/person_application_work_defer'))return Response.json({status:'deferred',work_id:work});
 if(u.pathname.endsWith('/person_application_work_complete'))return Response.json(emptyFinalize?{}:{status:'completed',work_id:work},{status:failFinalize||failContact?503:200});
 if(u.pathname.endsWith('/person_application_work_finish'))return Response.json({status:body.p_outcome,work_id:work});
 if(failRenew&&u.pathname.endsWith('/person_transition_renew'))return Response.json({}, {status:409});
 if(u.pathname.endsWith('/person_transition_renew'))return Response.json({status:'admitted',work_id:work,lease_until:new Date(Date.now()+60000).toISOString()});
 if(u.pathname.endsWith('/organizations'))return Response.json([{id:u.searchParams.get('id')==='eq.'+TENANT?TENANT:TT,slug:'synthetic',name:'Synthetic',daily_review_limit:0}]);
 if(contactFixture&&u.pathname.endsWith('/website_applications')&&(!init.method||init.method==='GET'))return Response.json([{id,organization_id:TENANT,linkedin_username:'synthetic',email:snapshot.email,contact:{}}]);
 if(contactFixture&&u.pathname.endsWith('/website_applications')&&body?.contact)return Response.json([{id}],{status:failContact?503:200});
 if(notifications&&u.pathname.endsWith('/website_applications')&&(!init.method||init.method==='GET'))return Response.json([{...snapshot,recruiter_profile_id:null,role_titles:[]}]);
 if(notifications&&u.pathname.endsWith('/org_members'))return Response.json([{user_id:id,email:'owner@example.test',member_role:'owner'}]);
 if(failFinalize&&u.pathname.endsWith('/website_applications')&&init.method==='PATCH')return Response.json({}, {status:503});
 if(u.pathname.endsWith('/website_applications')&&body?.status==='processed')return Response.json(emptyFinalize?[]:[{id}]);
 return Response.json([],{headers:{'content-range':'0-0/0'}});
};
const {runApplicantPipeline,reviewQueued}=await import('../dist/worker-lib.mjs');
test.beforeEach(()=>{calls=[];notifications=false;sent=0;failRenew=false;emptyFinalize=false;contactFixture=false;failContact=false;resumeSize=null;queueRows=null;delete process.env.LLAMA_CLOUD_API_KEY;delete process.env.RESEND_API_KEY;startStatus='started';failFinalize=false;claimResult={status:'held'};});
for(const status of ['held','budget','busy','unresolved','input_review','completed'])test(`${status} claim has no allowance, resume, provider or source effects`,async()=>{
 claimResult={status,...(['busy','unresolved','completed'].includes(status)?{work_id:work}:{})};
 const r=await runApplicantPipeline({...input,resumeBuf:Buffer.from('synthetic'),resumePath:'synthetic/input.pdf'});
 assert.equal(calls[0]?.path,'/rest/v1/rpc/person_application_work_claim','shared admission must be first');
 assert.equal(r,status==='completed'?'processed':'queued');assert.equal(calls.length,1);
});
test('a mismatched resume is held for review before effects start',async()=>{
 claimResult=admitted({resume_path:'synthetic/input.pdf',person_resume_sha256:'a'.repeat(64)});
 assert.equal(await runApplicantPipeline({...input,resumePath:'synthetic/input.pdf',resumeBuf:Buffer.from('wrong bytes')}),'queued');
 assert.deepEqual(calls.map(c=>c.path),['/rest/v1/rpc/person_application_work_claim','/rest/v1/rpc/person_application_work_review']);
});
test('admitted tenant processing uses retained inputs and finalizes its owned work',async()=>{
 claimResult=admitted();assert.equal(await runApplicantPipeline(input),'processed');
 assert.equal(calls[0]?.path,'/rest/v1/rpc/person_application_work_claim');
 assert.equal(calls.filter(c=>c.path.endsWith('/person_application_work_start')).length,1);
 const write=calls.find(c=>c.path.endsWith('/person_application_work_complete'));assert.equal(write?.body.p_result.name,snapshot.name);assert.equal(calls.some(c=>c.method==='PATCH'),false);
 assert.equal(calls.at(-1)?.path,'/rest/v1/rpc/person_application_work_complete');
 assert.equal(calls.filter(c=>c.path.endsWith('/rate_limit_events')).length,0,'fromQueue is not allowance authority');
});
test('a repeated start response cannot launch processing again',async()=>{
 claimResult=admitted();startStatus='already_started';assert.equal(await runApplicantPipeline(input),'queued');
 assert.equal(calls.some(c=>c.method==='PATCH'),false);assert.equal(calls.some(c=>c.path.endsWith('/person_application_work_finish')),false);
});
test('required finalize failure retains uncertainty and does not execute failure-tail writes',async()=>{
 claimResult=admitted();failFinalize=true;assert.equal(await runApplicantPipeline(input),'failed');
 assert.equal(calls.some(c=>c.method==='PATCH'),false);assert.equal(calls.filter(c=>c.path.endsWith('/person_application_work_complete')).length,1);
 assert.equal(calls.at(-1)?.body?.p_outcome,'uncertain');
});

test('held original callback keeps its acceptance notice while queue retries never resend',async()=>{
 notifications=true;process.env.RESEND_API_KEY='synthetic';
 assert.equal(await runApplicantPipeline({...input,fromQueue:false}),'queued');assert.equal(sent,1);
 assert.equal(await runApplicantPipeline(input),'queued');assert.equal(sent,1);
});

test('nightly queue shares admission without its own allowance or file download',async()=>{
 const r=await reviewQueued({max:10,deadline:Date.now()+10000});assert.deepEqual(r,{reviewed:0,failed:0,waiting:1});
 assert.deepEqual(calls.map(c=>c.path),['/rest/v1/rpc/person_application_work_queue','/rest/v1/rpc/person_application_work_claim','/rest/v1/rpc/person_application_work_queue']);
});

test('lost renewal stops the pipeline before any further source writes',async()=>{
 claimResult=admitted();failRenew=true;assert.equal(await runApplicantPipeline(input),'failed');assert.equal(calls.some(c=>c.method==='PATCH'),false);assert.equal(calls.at(-1).body.p_outcome,'uncertain');
});
test('an invalid atomic completion response cannot falsely complete application work',async()=>{
 claimResult=admitted();emptyFinalize=true;assert.equal(await runApplicantPipeline(input),'failed');assert.equal(calls.at(-1).body.p_outcome,'uncertain');
});
for(const fails of [false,true])test(`tenant contact proposal ${fails?'failure retains uncertainty':'shares atomic completion'}`,async()=>{
 contactFixture=true;failContact=fails;process.env.LLAMA_CLOUD_API_KEY='synthetic';const bytes=Buffer.from('synthetic pdf');claimResult=admitted({resume_path:'synthetic/file.pdf',person_resume_sha256:createHash('sha256').update(bytes).digest('hex')});
 const r=await runApplicantPipeline({...input,resumeBuf:bytes,resumePath:'synthetic/file.pdf'});assert.equal(r,fails?'failed':'processed');
 const final=calls.find(c=>c.path.endsWith('/person_application_work_complete'));assert.ok(final?.body.p_result.resume_contacts.phone);assert.equal(calls.some(c=>c.method==='PATCH'),false);if(fails)assert.equal(calls.at(-1).body.p_outcome,'uncertain');
});

for(const size of ['header','stream'])test(`oversized stored resume (${size}) creates a durable input hold`,async()=>{
 resumeSize=size;claimResult=admitted({resume_path:'synthetic/oversized.pdf',person_resume_sha256:'a'.repeat(64)});assert.equal(await runApplicantPipeline(input),'queued');assert.equal(calls.some(c=>c.path.endsWith('/person_application_work_start')),false);assert.equal(calls.at(-1).path,'/rest/v1/rpc/person_application_work_review');
});

test('a concurrent budget denial does not consume the queue maximum before another organization is tried',async()=>{
 queueRows=[{id:'cf000000-0000-4000-8000-000000000099',organization_id:TT},{id,organization_id:TENANT}];claimResult=admitted();const result=await reviewQueued({max:1,deadline:Date.now()+10000});assert.equal(result.reviewed,1);assert.deepEqual(calls.filter(c=>c.path.endsWith('/person_application_work_claim')).map(c=>c.body.p_org),[TT,TENANT]);
});
test('support off retains the legacy profile-before-contact write order',async()=>{
 process.env.PERSON_TRANSITION_SUPPORT='off';contactFixture=true;process.env.LLAMA_CLOUD_API_KEY='synthetic';
 try{assert.equal(await runApplicantPipeline({...input,resumeBuf:Buffer.from('synthetic pdf')}),'processed');const final=calls.findIndex(c=>c.body?.status==='processed'),contact=calls.findIndex(c=>c.method==='PATCH'&&c.body?.contact);assert.ok(final>=0&&contact>final);assert.equal(calls.some(c=>c.path.includes('person_application_work')),false);}finally{process.env.PERSON_TRANSITION_SUPPORT='on';}
});
test('cached screening metadata is not sent as typed completion output',async()=>{
 cacheFixture=true;process.env.OPENAI_API_KEY='synthetic';claimResult=admitted();try{assert.equal(await runApplicantPipeline(input),'processed');const final=calls.find(c=>c.path.endsWith('/person_application_work_complete'));assert.equal(final.body.p_result.screening.length,1);assert.equal(final.body.p_result.screening[0].cached,true);assert.equal(final.body.p_result.screening[0].facts,undefined);assert.equal(final.body.p_result.screening[0].origin_signal,undefined);}finally{cacheFixture=false;delete process.env.OPENAI_API_KEY;}
});
