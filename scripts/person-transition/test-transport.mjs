import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import * as lib from './dist/transport.mjs';
const url=process.env.LOCAL_DATABASE_URL;
if(!/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_transition_test$/.test(url||''))throw Error('local fixture database required');
const pool=new pg.Pool({connectionString:url});
const TT='801865a7-6533-41d2-9c45-e4a90e6ad51a';
const input=()=>({scope:'tt_person',organizationId:TT,family:'application',resourceKey:randomUUID(),inputHash:'a'.repeat(64),token:randomUUID(),leaseSeconds:60});
let requestCount=0,malformed=false,redirectCode=0,foreignRequests=0;
const foreign=http.createServer(async(req,res)=>{foreignRequests++;for await(const _ of req){}res.end(JSON.stringify({status:'held'}));});
const server=http.createServer(async(req,res)=>{
 requestCount++;
 if(redirectCode && /^\/rest\/v1\/rpc\/person_(transition_(claim|renew|finish)|application_work_claim)$/.test(req.url)){res.writeHead(redirectCode,{Location:`http://127.0.0.1:${foreign.address().port}/sink`});res.end();return;}
 if(req.url==='/rest/v1/echo'){res.end(JSON.stringify({id:req.headers['x-person-work-id']||null,token:req.headers['x-person-work-token']||null}));return;}
 if(req.url==='/rest/v1/redirect'){res.writeHead(302,{Location:'/rest/v1/echo'});res.end();return;}
 const client=await pool.connect();
 try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const a=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  await client.query('begin');await client.query('set local role service_role');await client.query("select set_config('request.headers',$1,true)",[JSON.stringify(req.headers)]);
  let q;
  if(req.url==='/rest/v1/rpc/person_transition_claim')q=await client.query('select person_transition_claim($1,$2,$3,$4,$5,$6,$7) r',[a.p_scope,a.p_org,a.p_family,a.p_resource,a.p_hash,a.p_token,a.p_lease]);
  else if(req.url==='/rest/v1/rpc/person_transition_assert')q=await client.query('select person_transition_assert($1,$2,$3,$4) r',[a.p_scope,a.p_org,a.p_family,a.p_resource]);
  else throw Error('unknown synthetic path');
  await client.query('commit');res.end(JSON.stringify(malformed?{status:'admitted'}:q.rows[0].r));
 }catch{await client.query('rollback');res.statusCode=503;res.end(JSON.stringify({message:'synthetic error with private-token-value'}));}finally{client.release();}
});
test.before(async()=>{await new Promise(r=>foreign.listen(0,'127.0.0.1',r));await new Promise(r=>server.listen(0,'127.0.0.1',r));process.env.SUPABASE_URL=`http://127.0.0.1:${server.address().port}`;process.env.SUPABASE_SERVICE_ROLE_KEY='synthetic-local-key';});
test.beforeEach(async()=>{process.env.PERSON_TRANSITION_SUPPORT='on';malformed=false;redirectCode=0;foreignRequests=0;await pool.query('truncate person_private.transition_work,person_private.transition_events');await pool.query("update person_private.transition_control set enabled=false,phase='open',generation=1,revision=1");});
test.after(async()=>{await new Promise(r=>server.close(r));await new Promise(r=>foreign.close(r));await pool.end();});
async function arm(){await pool.query("select person_private.transition_set('arm',1,1,'synthetic_test')");}
async function claim(i=input()){const a=await lib.claimTransitionWork(i);assert.equal(a.status,'admitted');return {i,a};}
const assertion=i=>lib.sbRest('rpc/person_transition_assert',{method:'POST',body:JSON.stringify({p_scope:i.scope,p_org:i.organizationId,p_family:i.family,p_resource:i.resourceKey})});
test('off and absent support require no schema; unknown support fails closed',async()=>{
 const before=requestCount;delete process.env.PERSON_TRANSITION_SUPPORT;assert.equal((await lib.claimTransitionWork(input())).status,'disabled');
 process.env.PERSON_TRANSITION_SUPPORT='off';assert.equal((await lib.claimTransitionWork(input())).status,'disabled');assert.equal(requestCount,before);
 process.env.PERSON_TRANSITION_SUPPORT='typo';await assert.rejects(lib.claimTransitionWork(input()),/transition_configuration/);
});
test('enabled missing schema fails closed without leaking database response or token',async()=>{
 await pool.query('alter function person_transition_claim(text,uuid,text,text,text,uuid,integer) rename to person_transition_claim_saved');
 try{await assert.rejects(lib.claimTransitionWork(input()),e=>e.message==='transition_unavailable');}finally{await pool.query('alter function person_transition_claim_saved(text,uuid,text,text,text,uuid,integer) rename to person_transition_claim');}
});
test('real HTTP transports scoped credentials into database admission assertion',async()=>{
 await arm();const {i,a}=await claim();
 const r=await lib.withTransitionWork(a,()=>assertion(i));assert.equal(r.status,200);assert.equal(await r.json(),'admitted');
 assert.equal((await assertion(i)).status,503);
});
test('concurrent async scopes and nested scope restore never exchange admissions',async()=>{
 const first=await claim(),second=await claim();
 const echo=async()=>await(await lib.sbRest('echo')).json();
 const responses=await Promise.all([lib.withTransitionWork(first.a,async()=>{await new Promise(r=>setTimeout(r,15));const nested=await lib.withTransitionWork(second.a,echo);assert.equal(nested.id,second.a.workId);return echo();}),lib.withTransitionWork(second.a,echo)]);
 assert.equal(responses[0].id,first.a.workId);assert.equal(responses[1].id,second.a.workId);assert.deepEqual(await echo(),{id:null,token:null});
});
test('caller headers cannot forge credentials with any HeadersInit representation',async()=>{
 const {a}=await claim();
 for(const headers of [{'X-Person-Work-ID':randomUUID(),'x-person-work-token':'injected'},new Headers({'x-person-work-id':randomUUID(),'X-Person-Work-Token':'injected'}),[['X-Person-Work-ID',randomUUID()],['x-person-work-token','injected']]]){
  assert.deepEqual(await(await lib.sbRest('echo',{headers})).json(),{id:null,token:null});
  const actual=await lib.withTransitionWork(a,async()=>await(await lib.sbRest('echo',{headers})).json());assert.equal(actual.id,a.workId);assert.equal(actual.token,a.token);
 }
});
test('admitted REST requests cannot follow redirects with their credentials',async()=>{
 const {a}=await claim();await assert.rejects(lib.withTransitionWork(a,()=>lib.sbRest('redirect')));
});
test('direct transaction binding rolls back credentials and validates against the same ledger',async()=>{
 await arm();const {i,a}=await claim(),c=await pool.connect();
 try{await c.query('begin');await lib.withTransitionWork(a,()=>lib.bindTransitionWork(c));assert.equal((await c.query('select person_transition_assert($1,$2,$3,$4) r',[i.scope,i.organizationId,i.family,i.resourceKey])).rows[0].r,'admitted');await c.query('commit');
  assert.equal((await c.query("select nullif(current_setting('person.work_id',true),'') id")).rows[0].id,null);
  await assert.rejects(lib.bindTransitionWork(c),/transition_admission/);
 }finally{await c.query('rollback');c.release();}
});
test('malformed successful claim response fails closed',async()=>{
 malformed=true;await assert.rejects(lib.claimTransitionWork(input()),/transition_response/);
});

for(const code of [307,308])test(`first claim cannot redirect its token-bearing body (${code})`,async()=>{
 redirectCode=code;await assert.rejects(lib.claimTransitionWork(input()),/transition_unavailable/);assert.equal(foreignRequests,0);
});
for(const operation of ['renew','finish'])test(`${operation} RPC refuses redirects without an async context`,async()=>{
 redirectCode=307;await assert.rejects(lib.sbRest(`rpc/person_transition_${operation}`,{method:'POST',body:JSON.stringify({p_token:randomUUID()})}));assert.equal(foreignRequests,0);
});

test('application work claim cannot redirect its reservation token before context exists',async()=>{
 redirectCode=307;await assert.rejects(lib.sbRest('rpc/person_application_work_claim',{method:'POST',body:JSON.stringify({p_token:randomUUID()})}));assert.equal(foreignRequests,0);
});
