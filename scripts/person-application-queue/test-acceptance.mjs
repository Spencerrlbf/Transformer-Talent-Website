import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
for(const k of ['RESEND_API_KEY','OPENAI_API_KEY','HARVEST_API_KEY','TURNSTILE_SECRET_KEY'])delete process.env[k];
Object.assign(process.env,{SUPABASE_URL:'http://acceptance.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic',PERSON_TRANSITION_SUPPORT:'on',PERSON_WRITE_MODE:'live'});
const TT='801865a7-6533-41d2-9c45-e4a90e6ad51a',id='cf000000-0000-4000-8000-000000000004';
let writes=[],uploaded=[],failUpload=false,priorFuture=false,intents=new Set();
globalThis.acceptanceCallbacks=[];
globalThis.fetch=async(input,init={})=>{
 const u=new URL(String(input));assert.equal(u.origin,'http://acceptance.invalid','outbound request forbidden');const method=init.method||'GET';
 if(u.pathname.startsWith('/storage/')){assert.equal(method,'POST');uploaded.push({path:u.pathname,bytes:Buffer.from(init.body)});return new Response(null,{status:failUpload?503:200});}
 const table=u.pathname.split('/').at(-1),body=init.body?JSON.parse(init.body):null;
 if(method!=='GET')writes.push({table,method,body});
 if(table==='organizations')return Response.json([{id:TT,slug:'transformer-talent',name:'Synthetic',referral_amount:0}]);
 if(table==='rate_limit_events')return Response.json([],{headers:{'content-range':'0-0/0'}});
 if(table==='website_applications'&&method==='GET')return Response.json(priorFuture&&!u.searchParams.has('person_intent_hash')?[{id,candidate_id:id}]:[]);
 if(table==='website_applications'&&method==='POST'){
  const h=body.person_intent_hash;if(h&&intents.has(h))return Response.json([],{status:201});if(h)intents.add(h);return Response.json([{id}],{status:201});
 }
 return Response.json([]);
};
const routes=await import('./dist/routes.mjs');
function form(kind,withFile=true){const f=new FormData();for(const [k,v] of Object.entries({name:'Synthetic',email:'synthetic@example.test',linkedin:'https://www.linkedin.com/in/synthetic',months:'3',roleIds:'invalid-role'}))f.set(k,v);if(withFile)f.set('resume',new File(['synthetic PDF'], 'synthetic.pdf',{type:'application/pdf'}));return{formData:async()=>f,headers:new Headers()};}
test.beforeEach(()=>{writes=[];uploaded=[];failUpload=false;priorFuture=false;intents=new Set();globalThis.acceptanceCallbacks=[];process.env.PERSON_TRANSITION_SUPPORT='on';});
for(const kind of ['apply','future'])test(`${kind} persists verified resume and queued input before accepting`,async()=>{
 const response=await routes[kind](form(kind));assert.equal(response.status,200);
 const row=writes.find(w=>w.table==='website_applications'&&w.method==='POST')?.body;assert.equal(row?.status,'queued');
 assert.equal(row.person_resume_sha256,createHash('sha256').update('synthetic PDF').digest('hex'));assert.ok(row.resume_path);assert.equal(uploaded.length,1);assert.equal(globalThis.acceptanceCallbacks.length,1);
});
for(const kind of ['apply','future'])test(`${kind} refuses a failed supplied-file upload before inserting an application`,async()=>{
 failUpload=true;const response=await routes[kind](form(kind));assert.equal(response.status,502);assert.equal(writes.filter(w=>w.table==='website_applications').length,0);assert.equal(globalThis.acceptanceCallbacks.length,0);
});
test('fresh referral is durably queued before its original response callback',async()=>{
 const response=await routes.referral({json:async()=>({org:'transformer-talent',referrerName:'Synthetic',referrerEmail:'referrer@example.test',candidateEmail:'synthetic@example.test',candidateLinkedin:'https://www.linkedin.com/in/synthetic'}),headers:new Headers()});assert.equal(response.status,200);assert.equal(writes.find(w=>w.table==='website_applications')?.body.status,'queued');assert.equal(globalThis.acceptanceCallbacks.length,1);
});
test('future preference update creates immutable intent instead of patching incumbent rows',async()=>{
 priorFuture=true;assert.equal((await routes.future(form('future',false))).status,200);assert.equal(writes.some(w=>w.method==='PATCH'),false);assert.ok(writes.some(w=>w.table==='website_applications'&&w.method==='POST'));
});
test('concurrent identical future inputs share semantic intent despite different upload paths',async()=>{
 const responses=await Promise.all([routes.future(form('future')),routes.future(form('future'))]);assert.ok(responses.every(r=>r.status===200));
 const rows=writes.filter(w=>w.table==='website_applications'&&w.method==='POST').map(w=>w.body);assert.equal(rows.length,2);assert.match(rows[0].person_intent_hash,/^[a-f0-9]{64}$/);assert.equal(rows[0].person_intent_hash,rows[1].person_intent_hash);assert.notEqual(rows[0].resume_path,rows[1].resume_path);assert.equal(globalThis.acceptanceCallbacks.length,1);
});
test('support off keeps the legacy schema contract',async()=>{
 process.env.PERSON_TRANSITION_SUPPORT='off';const response=await routes.apply(form('apply'));assert.equal(response.status,200);const row=writes.find(w=>w.table==='website_applications')?.body;assert.equal(row.status,'processing');assert.equal(Object.hasOwn(row,'person_resume_sha256'),false);
});

test('encoded case variants of LinkedIn share one canonical future intent',async()=>{
 const a=form('future',false),b=form('future',false);(await a.formData()).set('linkedin','https://www.linkedin.com/in/alice');(await b.formData()).set('linkedin','https://www.linkedin.com/in/%41lice');
 assert.equal((await routes.future(a)).status,200);assert.equal((await routes.future(b)).status,200);
 const rows=writes.filter(w=>w.table==='website_applications').map(w=>w.body);assert.equal(rows[0].linkedin_username,rows[1].linkedin_username);assert.equal(rows[0].person_intent_hash,rows[1].person_intent_hash);assert.equal(globalThis.acceptanceCallbacks.length,1);
});
test('decoded surrounding whitespace uses the same canonical LinkedIn identity as intake',async()=>{
 const a=form('future',false),b=form('future',false);(await a.formData()).set('linkedin','https://www.linkedin.com/in/alice');(await b.formData()).set('linkedin','https://www.linkedin.com/in/%20ALICE%20');await routes.future(a);await routes.future(b);const rows=writes.filter(w=>w.table==='website_applications').map(w=>w.body);assert.equal(rows[0].linkedin_username,rows[1].linkedin_username);assert.equal(rows[0].person_intent_hash,rows[1].person_intent_hash);assert.equal(globalThis.acceptanceCallbacks.length,1);
});
test('decoded LinkedIn path separators are rejected before acceptance',async()=>{
 const request=form('future',false);(await request.formData()).set('linkedin','https://www.linkedin.com/in/alice%2Fother');assert.equal((await routes.future(request)).status,400);assert.equal(writes.filter(w=>w.table==='website_applications').length,0);
});
