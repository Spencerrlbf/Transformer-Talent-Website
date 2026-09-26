import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
const url=process.env.LOCAL_DATABASE_URL;
if(!url||!['127.0.0.1','localhost'].includes(new URL(url).hostname))throw Error('Local database required');
const lib=await import('../dist/worker-lib.mjs');
const admin=new pg.Client({connectionString:url});await admin.connect();
try{
 for(const scenario of ['identity-company','skill-email']){
  const bulk=new pg.Client({connectionString:url}),single=new pg.Client({connectionString:url});
  await bulk.connect();await single.connect();
  const ids=[crypto.randomUUID(),crypto.randomUUID()],run=`locks-${scenario}-${ids[0]}`;
  const rows=ids.map((id,i)=>({id,full_name:'Synthetic lock test',linkedin_username:scenario==='identity-company'?`shared-${ids[0]}`:id,
   created_at:'2025-01-01T00:00:00Z',email:scenario==='skill-email'?`${ids[0]}@example.com`:null,
   skills:scenario==='skill-email'?[`Synthetic skill ${ids[0]}`]:[],
   work_experience:[{title:'Engineer',company:scenario==='identity-company'?`Synthetic company ${ids[0]}`:`Synthetic company ${id}`,is_current:true,start_date:{year:2020}}]}));
  const docs=rows.map(row=>lib.fromLegacyImport(row));
  const items=[{candidate_id:ids[0],docs:[docs[0]],version:0}];
  try{
   await admin.query("insert into candidates(id,linkedin_username,full_name) select x,x::text,'Synthetic lock test' from unnest($1::uuid[]) x",[ids]);
   await admin.query("select person_backfill_start($1,'synthetic-locks','person-v3',10,2,false)",[run]);
   await bulk.query('begin');await bulk.query("set local statement_timeout='8s'");
   // Hold the same prelock used by the bulk RPC before the single writer starts.
   await bulk.query('select person_private.lock_backfill_items($1)',[JSON.stringify(items)]);
   const pid=(await single.query('select pg_backend_pid() pid')).rows[0].pid;
   await single.query("set statement_timeout='8s'");
   const other=single.query('select save_person($1)',[JSON.stringify(docs[1])]).then(()=>({ok:true}),e=>({ok:false,code:e.code}));
   let waiting=false;
   for(let i=0;i<100;i++){
    const state=(await admin.query('select wait_event from pg_stat_activity where pid=$1',[pid])).rows[0];
    if(state?.wait_event==='advisory'){waiting=true;break;}
    await new Promise(r=>setTimeout(r,10));
   }
   assert.ok(waiting,'single writer reached the shared lock boundary');
   let own;
   try{await bulk.query('select person_backfill_save_many($1,$2)',[run,JSON.stringify(items)]);await bulk.query('commit');own={ok:true};}
   catch(e){await bulk.query('rollback');own={ok:false,code:e.code};}
   assert.deepEqual([own,await other],[{ok:true},{ok:true}],`${scenario} bulk/single writers must both complete`);
   console.log(`PASS bulk and single writers: ${scenario} contention`);
  }finally{await bulk.query('rollback').catch(()=>{});await bulk.end();await single.end();}
 }
}finally{await admin.end();}
