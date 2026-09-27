import test from 'node:test';import assert from 'node:assert/strict';
// Run the actual cleanup against a local in-memory HTTP boundary. No request can
// leave this process; the sentinel rows represent a real job and another run.
Object.assign(process.env,{SUPABASE_URL:'http://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic',SUPABASE_ANON_KEY:'synthetic'});
const TT='801865a7-6533-41d2-9c45-e4a90e6ad51a',run='scope1234';
const tables=['candidate_role_statuses','stage_events','tasks','role_attachments','no_reply_marks'];
let state, roleExists, failOnceTable;
function reset() {
 state=Object.fromEntries(tables.map(table=>[table,[{id:'own',job:'99551'},{id:'other-run',job:'99552'},{id:'incumbent',job:'99553'}]]));
 roleExists=true; failOnceTable=null;
}
function assertPreserved() {
 for(const table of tables)assert.deepEqual(state[table].map(row=>row.id),['other-run','incumbent'],table);
 assert.equal(roleExists,false);
}
globalThis.fetch=async(input,init={})=>{
 const u=new URL(String(input));assert.equal(u.origin,'http://fixture.invalid');const table=u.pathname.split('/').at(-1);const method=init.method||'GET';
 if(method==='GET'&&table==='organizations'&&u.searchParams.get('slug')==='eq.transformer-talent')return Response.json([{id:TT}]);
 if(method==='GET'&&table==='org_roles')return Response.json(roleExists?[{id:'cf000000-0000-4000-8000-000000000001',external_id:'99551',title:`zzlk${run}-owned`}]:[]);
 if(method==='DELETE'&&table==='org_roles')roleExists=false;
 if(method==='DELETE'&&tables.includes(table)&&u.searchParams.has('job_id')){
  const filter=u.searchParams.get('job_id');assert.equal(u.searchParams.get('organization_id'),`eq.${TT}`);
  if(failOnceTable===table){failOnceTable=null;return Response.json({message:'synthetic transient failure'},{status:500});}
  state[table]=state[table].filter(row=>!(filter==='like.99___'?/^99...$/.test(row.job):filter===`eq.${row.job}`));
 }
 if(u.pathname.endsWith('/admin/users'))return Response.json({users:[]});
 return method==='DELETE'?new Response(null,{status:204}):Response.json([]);
};
const {teardown}=await import('./fixture.mjs');
test('one run cleanup preserves other jobs even within the reserved job-number range',async()=>{
 reset();
 await teardown({runId:run});
 assertPreserved();
});
test('failed job cleanup keeps ownership records so an exact retry can finish',async()=>{
 reset();failOnceTable='tasks';
 await assert.rejects(teardown({runId:run}),/synthetic transient failure/);
 assert.equal(roleExists,true,'ownership must survive the failed child DELETE');
 assert.equal(state.tasks.some(row=>row.id==='own'),true);
 await teardown({runId:run});
 assertPreserved();
});
