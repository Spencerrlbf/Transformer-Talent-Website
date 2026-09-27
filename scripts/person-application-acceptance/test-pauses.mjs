import test from 'node:test';import assert from 'node:assert/strict';
Object.assign(process.env,{PERSON_TRANSITION_SUPPORT:'on',PERSON_WRITE_MODE:'legacy',SUPABASE_URL:'http://pause.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic'});
for(const k of ['RESEND_API_KEY','OPENAI_API_KEY','HARVEST_API_KEY','NOTION_TOKEN','NOTION_DATABASE_ID','AIRTABLE_API_TOKEN'])delete process.env[k];
const TT='801865a7-6533-41d2-9c45-e4a90e6ad51a',A='ce000000-0000-4000-8000-000000000002',id='ce000000-0000-4000-8000-000000000003';let statusReads=0,candidateReads=0,writes=[],enabled=true,broken=false,linked=false;
globalThis.fetch=async(input,init={})=>{const u=new URL(String(input));assert.equal(u.origin,'http://pause.invalid','outbound forbidden');const table=u.pathname.split('/').at(-1),method=init.method||'GET';if(method!=='GET'&&!table.startsWith('person_')&&table!=='rate_limit_events')writes.push({path:u.pathname,method});
 if(u.pathname==='/auth/v1/user')return Response.json({id,email:'synthetic@example.test'});
 if(table==='org_members')return Response.json([{member_role:'owner',organizations:{id:TT,slug:'transformer-talent',name:'Synthetic'}}]);
 if(table==='organizations')return Response.json([{id:TT,slug:'transformer-talent'}]);
 if(table==='person_transition_status'){statusReads++;return broken?Response.json({},{status:503}):Response.json({enabled});}
 if(table==='org_roles')return Response.json([{id,title:'Synthetic',linked_org_role:linked?{orgId:A,jobId:'1'}:null}]);
 if(table==='rate_limit_events')return Response.json([],{headers:{'content-range':'0-0/0'}});
 if(table==='website_applications')return Response.json([{id,candidate_id:id,follow_up_at:'2027-01-01',created_at:new Date().toISOString(),role_ids:[],role_titles:[],matched_role_ids:['1']}]);
 if(table==='candidates'){candidateReads++;return Response.json([]);}
 return Response.json([]);
};
const routes=await import('./dist/routes.mjs');
function req(body={}){const f=new FormData();f.set('file',new File(['synthetic'], 'resume.pdf',{type:'application/pdf'}));return{headers:new Headers({authorization:'Bearer synthetic'}),json:async()=>body,formData:async()=>f};}
const ctx={params:Promise.resolve({key:'app_'+id})};test.beforeEach(()=>{statusReads=0;candidateReads=0;writes=[];enabled=true;broken=false;linked=false;process.env.PERSON_TRANSITION_SUPPORT='on';});
for(const [route,body]of [['resume',{}],['contact',{phone:'+12025550123'}],['clear',{}],['followup',{at:'2027-01-01'}],['addRole',{applicationId:id,jobId:'1'}],['send',{candidateId:id,jobId:'1'}]])test(`${route} pauses before storage, mirrors or pool mutations`,async()=>{const r=await routes[route](req(body),ctx);assert.equal(r.status,503);assert.equal((await r.json()).error,'temporarily_unavailable');assert.deepEqual(writes,[]);});
test('missing enabled schema/status fails closed before resume upload',async()=>{broken=true;assert.equal((await routes.resume(req(),ctx)).status,503);assert.deepEqual(writes,[]);});
test('tenant editor preflight bypasses the TT controller',async()=>{broken=true;assert.equal(await routes.applicationEditsPaused(A),false);});
test('disabled and schema-absent legacy preflight remain available',async()=>{enabled=false;assert.equal(await routes.applicationEditsPaused(TT),false);process.env.PERSON_TRANSITION_SUPPORT='off';broken=true;assert.equal(await routes.applicationEditsPaused(TT),false);});

test('client-target Send reaches its existing lookup without a TT edit pause',async()=>{linked=true;broken=true;const r=await routes.send(req({candidateId:id,jobId:'1'}));assert.equal(r.status,404);assert.equal((await r.json()).error,'candidate_not_found');assert.equal(statusReads,0);assert.equal(candidateReads,1);assert.deepEqual(writes,[]);});
