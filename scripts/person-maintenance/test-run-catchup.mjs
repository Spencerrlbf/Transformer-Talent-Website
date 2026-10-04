// The production catch-up combination on the disposable local stack: the PINNED
// runner (c4d0e4e translator, website over REST through restSite, directory through
// openComms's pg.Client) driven by scripts/person-maintenance/run-catchup.mjs.
//
// Needs: a running local Supabase stack with the full chain (SUPABASE_URL loopback,
// SUPABASE_SERVICE_ROLE_KEY, WEBSITE_DATABASE_URL = its PostgreSQL for seeding and
// inspection), COMMS_DATABASE_URL = a loopback database this test fills with the
// synthetic directory schema, PINNED_RUNNER_DIR = a clean c4d0e4e checkout.
//
// Cases: (1) the pinned directory client with the helper's listener: an idle loss is
// not uncaught and the next query rejects; a loss inside a query rejects that query;
// (2) the actual run: the directory connection is terminated while the runner is
// between pages → the pinned loop fails the run (status `failed`, reconcile_stopped,
// exit 1), last_id stays at the last committed checkpoint, no person is recorded
// twice; (3) resume with the identical configuration completes the run; every queued
// person is recorded exactly once and the run reaches `source_scan_complete`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import pg from 'pg';
import {installTransportListener,checkConfig} from './run-catchup.mjs';

const env=process.env;
for(const k of ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','WEBSITE_DATABASE_URL','COMMS_DATABASE_URL','PINNED_RUNNER_DIR'])if(!env[k])throw Error(`${k} required`);
for(const u of [env.SUPABASE_URL])if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(u))throw Error('loopback stack required');
for(const u of [env.WEBSITE_DATABASE_URL,env.COMMS_DATABASE_URL])if(!/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/[a-z_]+$/.test(u))throw Error('loopback databases required');
const site=new pg.Pool({connectionString:env.WEBSITE_DATABASE_URL,max:3});
const comms=new pg.Pool({connectionString:env.COMMS_DATABASE_URL,max:3});
site.on('error',()=>{});comms.on('error',()=>{});
test.after(async()=>{await site.end();await comms.end();});
const RUN=`catchup-${randomUUID().slice(0,8)}`;
const WS=randomUUID();
const people=Array.from({length:4},(_,i)=>({id:randomUUID(),contact:randomUUID(),n:i}));
const runnerEnv={PATH:env.PATH,HOME:env.HOME,PINNED_RUNNER_DIR:env.PINNED_RUNNER_DIR,PERSON_TARGET_PROJECT_REF:'local',SUPABASE_URL:env.SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY:env.SUPABASE_SERVICE_ROLE_KEY,
 COMMS_DATABASE_URL:env.COMMS_DATABASE_URL,COMMS_WORKSPACE:'Synthetic directory',
 BACKFILL_CONFIG:JSON.stringify({'run-id':RUN,reconcile:true,scope:'queue','dry-run':false,resume:true,limit:100,'batch-size':1,'max-seconds':600})};

test('setup: synthetic directory and four queued directory-linked legacy people (controller disabled)',async()=>{
 await comms.query(`drop schema if exists comms cascade;drop schema if exists board cascade;create schema comms;create schema board;
 create table comms.workspaces(id uuid primary key,name text);
 create table comms.contacts(id uuid primary key,workspace_id uuid);
 create table board.candidates(contact_id uuid primary key,name text,linkedin_url text,primary_email text,email_status text,status text,do_not_contact bool,updated_at timestamptz);
 create table comms.harvest_profiles(contact_id uuid primary key,fetched_at timestamptz,public_identifier text,headline text,source_version_id uuid);
 create table comms.contact_experiences(contact_id uuid,title text,company_name text,start_year int,is_current bool,superseded_at timestamptz,sort_order int);
 create table comms.contact_educations(contact_id uuid,school_name text,superseded_at timestamptz,sort_order int);
 create table comms.emails(contact_id uuid,normalized text,original_value text,classification text,verification jsonb);
 create table comms.profile_facts(id uuid primary key,contact_id uuid,field text,value jsonb,provenance text,recorded_at timestamptz);
 create table comms.identifiers(contact_id uuid,kind text,value text,original_value text);
 create table comms.source_versions(id uuid primary key,payload jsonb,captured_at timestamptz)`);
 await comms.query('insert into comms.workspaces values($1,$2)',[WS,'Synthetic directory']);
 const c=(await site.query('select enabled from person_private.transition_control where singleton')).rows[0];
 assert.equal(c.enabled,false,'the disposable stack starts disabled');
 for(const p of people){
  const u=`directory-catchup-${p.n}-${p.id.slice(0,8)}`;
  await comms.query('insert into comms.contacts values($1,$2)',[p.contact,WS]);
  await comms.query("insert into board.candidates values($1,$2,$3,$4,'Verified','Replied',false,'2026-09-01')",[p.contact,`Synthetic Directory ${p.n}`,`https://www.linkedin.com/in/${u}`,`${u}@example.test`]);
  await comms.query("insert into comms.harvest_profiles values($1,'2026-08-01',$2,'Synthetic headline',null)",[p.contact,u]);
  await comms.query("insert into comms.contact_experiences values($1,'Senior Engineer','Synthetic Co',2020,true,null,0)",[p.contact]);
  await comms.query(`insert into comms.emails values($1,$2,$2,'personal','{"status":"Verified","primary":true,"checked_at":"2026-08-01"}')`,[p.contact,`${u}@example.test`]);
  await site.query("insert into candidates(id,full_name,linkedin_username,linkedin_url,email,current_title,current_company,source,directory_contact_id,created_at) values($1,$2,$3::text,'https://www.linkedin.com/in/'||$3::text,$4::text,'Senior Engineer','Synthetic Co','directory',$5,'2025-01-01')",
   [p.id,`Synthetic Directory ${p.n}`,u,`${u}@example.test`,p.contact]);
 }
 assert.equal((await site.query('select count(*)::int n from person_reconcile_pending where candidate_id=any($1::uuid[])',[people.map(p=>p.id)])).rows[0].n,4);
 // The pinned fingerprint covers every directory-linked person in the website
 // database (earlier runs of this test on the same stack included): each needs a
 // directory record, as in production.
 const others=(await site.query('select distinct c.directory_contact_id id,c.linkedin_username u,c.full_name f from candidates c where c.directory_contact_id is not null and not (c.directory_contact_id=any($1::uuid[]))',[people.map(p=>p.contact)])).rows;
 for(const o of others){
  await comms.query('insert into comms.contacts values($1,$2) on conflict do nothing',[o.id,WS]);
  await comms.query("insert into board.candidates values($1,$2,$3,null,null,'Replied',false,'2026-09-01') on conflict do nothing",[o.id,o.f,`https://www.linkedin.com/in/${o.u}`]);
  await comms.query("insert into comms.harvest_profiles values($1,'2026-08-01',$2,'Synthetic headline',null) on conflict do nothing",[o.id,o.u]);
 }
});

test('configuration contract: the helper refuses anything but the resumed queue reconcile under a selection',()=>{
 const base={...runnerEnv};
 assert.deepEqual(checkConfig(base),{run:RUN,target:'local'});
 assert.throws(()=>checkConfig({...base,BACKFILL_CONFIG:JSON.stringify({...JSON.parse(base.BACKFILL_CONFIG),resume:false})}),/catchup_run:config/);
 assert.throws(()=>checkConfig({...base,BACKFILL_CONFIG:JSON.stringify({...JSON.parse(base.BACKFILL_CONFIG),'dry-run':true})}),/catchup_run:config/);
 assert.throws(()=>checkConfig({...base,BACKFILL_CONFIG:JSON.stringify({...JSON.parse(base.BACKFILL_CONFIG),scope:'all'})}),/catchup_run:config/);
 assert.throws(()=>checkConfig({...base,BACKFILL_CONFIG:JSON.stringify({...JSON.parse(base.BACKFILL_CONFIG),commit:'0'.repeat(40)})}),/catchup_run:pin/);
 assert.throws(()=>checkConfig({...base,PERSON_TARGET_PROJECT_REF:undefined}),/person_target:missing/);
 assert.throws(()=>checkConfig({...base,LOCAL_DATABASE_URL:env.WEBSITE_DATABASE_URL}),/catchup_run:credentials/);
 assert.throws(()=>checkConfig({...base,SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co'}),/person_target:rest_mismatch/);
});

test('without the helper: the pinned directory client\'s idle loss kills the process (the defect being handled)',async()=>{
 // In a child, so the crash is observed and does not disturb this process.
 const root=path.resolve(env.PINNED_RUNNER_DIR);
 const script=`import {openComms} from ${JSON.stringify(pathToFileURL(path.join(root,'scripts','person-trial.mjs')).href)};
const c=await openComms(process.env.COMMS_DATABASE_URL);
console.log('listeners',c.listenerCount('error'));
await c.query('select pg_terminate_backend(pg_backend_pid())').catch(()=>{});
await new Promise(r=>setTimeout(r,500));
console.log('still_alive');`;
 const r=await new Promise((resolve)=>{const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{PATH:env.PATH,HOME:env.HOME,COMMS_DATABASE_URL:env.COMMS_DATABASE_URL},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',(c)=>out+=c);child.stderr.on('data',(c)=>err+=c);child.on('close',(code)=>resolve({code,out,err}));});
 assert.match(r.out,/listeners 0/,'the pinned client has no error listener');
 assert.notEqual(r.code,0,'the process dies');
 assert.doesNotMatch(r.out,/still_alive/);
 assert.match(r.err,/terminat|Connection terminated/i);
});

test('pinned directory client + listener: idle loss is not uncaught; a loss inside a query rejects it',async()=>{
 const uncaught=[];const onUncaught=(e)=>uncaught.push(e);process.on('uncaughtException',onUncaught);
 try{
  const root=path.resolve(env.PINNED_RUNNER_DIR);
  const logs=[];
  const {installed,losses}=installTransportListener(root,{log:(l)=>logs.push(l)});
  assert.equal(installed,true);
  const {openComms}=await import(pathToFileURL(path.join(root,'scripts','person-trial.mjs')).href);
  // idle loss
  const idle=await openComms(env.COMMS_DATABASE_URL);
  const pid=(await idle.query('select pg_backend_pid() pid')).rows[0].pid;
  await comms.query('select pg_terminate_backend($1)',[pid]);
  await new Promise(r=>setTimeout(r,300));
  assert.deepEqual(uncaught,[],'the pinned client without the listener would have thrown here');
  assert.ok(losses.length>=1,'the loss was recorded (pg may emit the error more than once)');assert.match(logs[0],/catchup_comms_connection_lost/);
  await assert.rejects(idle.query('select 1'),/not queryable|terminat|closed/i);
  await idle.end().catch(()=>{});
  // loss inside a query
  const busy=await openComms(env.COMMS_DATABASE_URL);
  const busyPid=(await busy.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending=busy.query('select pg_sleep(5)');
  await new Promise(r=>setTimeout(r,200));
  await comms.query('select pg_terminate_backend($1)',[busyPid]);
  await assert.rejects(pending,(e)=>/^(57P01|08\d{3})$/.test(e.code??'')||/terminat|closed/i.test(e.message));
  await busy.end().catch(()=>{});
  await new Promise(r=>setTimeout(r,100));
  assert.deepEqual(uncaught,[]);
  assert.equal(installTransportListener(root).installed,false,'idempotent');
 }finally{process.off('uncaughtException',onUncaught);}
});

const runnerScript=path.resolve('scripts/person-maintenance/run-catchup.mjs');
function runRunner({onLine}){
 return new Promise((resolve)=>{
  const child=spawn(process.execPath,[runnerScript],{env:runnerEnv,stdio:['ignore','pipe','pipe']});
  let out='',err='';
  const feed=(chunk,sink)=>{const text=chunk.toString();if(sink==='out')out+=text;else err+=text;for(const line of text.split('\n'))if(line.trim())onLine?.(line,sink,child);};
  child.stdout.on('data',(c)=>feed(c,'out'));child.stderr.on('data',(c)=>feed(c,'err'));
  child.on('close',(code)=>resolve({code,out,err}));
 });
}
const runRow=async()=>(await site.query('select status,processed,last_id,notes from backfill_runs where run_id=$1',[RUN])).rows[0];
const recorded=async()=>(await site.query('select candidate_id,status,counted from person_reconcile_people where run_id=$1 order by candidate_id',[RUN])).rows;

test('the actual run: the directory connection is lost between pages → controlled failure, checkpoint intact, nothing recorded twice',async()=>{
 // Start the checkpoint the way the start helper does on a hosted target (REST RPC):
 // one running reconcile run, queue scope, pinned commit, no pages yet.
 // The start helper computes the pinned external fingerprint over the pinned REST
 // site and directory client; do the same here so the final `external_stable`
 // comparison is the real one.
 const root=path.resolve(env.PINNED_RUNNER_DIR);
 const {restSite,openComms,commsColumns}=await import(pathToFileURL(path.join(root,'scripts','person-trial.mjs')).href);
 const {externalFingerprint}=await import(pathToFileURL(path.join(root,'scripts','person-reconcile.mjs')).href);
 const pinnedLib=await import(pathToFileURL(path.join(root,'scripts','dist','worker-lib.mjs')).href);
 const pinnedSite=restSite(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY),pinnedComms=await openComms(env.COMMS_DATABASE_URL);
 let hash;try{hash=await externalFingerprint(pinnedSite,pinnedComms,await commsColumns(pinnedComms),pinnedLib);}finally{await pinnedComms.end();await pinnedSite.end?.();}
 const H={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json'};
 const started=await (await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/person_reconcile_start`,{method:'POST',headers:H,body:JSON.stringify({p_run:RUN,p_commit:'c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc',p_limit:100,p_batch:1,p_resume:false,p_scope:'queue',p_external_hash:hash})})).json();
 assert.equal(started.status,'running',JSON.stringify(started));
 let killed=false,checkpoints=0;
 const r=await runRunner({onLine:async(line,sink)=>{
  if(sink!=='out')return;
  if(line.includes('"phase":"reconcile_checkpoint"')){checkpoints++;}
  // After the first committed checkpoint the runner is between pages: its directory
  // client is idle. Drop that backend from the server side.
  if(!killed&&line.includes('"phase":"reconcile_checkpoint"')){
   killed=true;
   await comms.query("select pg_terminate_backend(pid) from pg_stat_activity where application_name='tt-website-person-trial' and pid<>pg_backend_pid()");
  }
 }});
 assert.equal(r.code,1,`runner exit\n${r.out}\n${r.err}`);
 assert.match(r.out,/"phase":"catchup_runner"/);
 assert.match(r.out,/"runner":"pinned"/);
 assert.match(r.err,/"phase":"reconcile_stopped"/,'the pinned loop\'s own failure path ran');
 assert.match(r.err,/catchup_comms_connection_lost/,'the loss was recorded by the listener');
 assert.doesNotMatch(r.out,/source_scan_complete/,'no false success');
 assert.doesNotMatch(r.err,/uncaught|Unhandled/i);
 const row=await runRow();
 assert.equal(row.status,'failed');assert.equal(row.notes.reconciliation_pending,true);
 assert.ok(row.processed>=1&&row.processed<people.length,`processed ${row.processed} of ${people.length} before the loss`);
 const rows=await recorded();
 assert.equal(rows.length,row.processed,'exactly the committed checkpoints are recorded');
 assert.equal(new Set(rows.map(x=>x.candidate_id)).size,rows.length,'no person recorded twice');
 globalThis.__firstPass={processed:row.processed,rows:rows.map(x=>x.candidate_id)};
 const lost=r.err.split('\n').find(l=>l.includes('catchup_comms_connection_lost'));
 console.log(JSON.stringify({evidence:'loss_pass',exit:r.code,checkpoints_before_loss:checkpoints,processed:row.processed,status:row.status,error_code:row.notes.error_code,listener:lost?JSON.parse(lost).code:null,runner_stopped:(r.out.split('\n').find(l=>l.includes('catchup_runner_stopped'))??'').slice(0,200)}));
});

test('resume with the identical configuration completes the run; committed work is preserved, every person recorded once',async()=>{
 const r=await runRunner({});
 assert.equal(r.code,0,`runner exit\n${r.out}\n${r.err}`);
 assert.match(r.out,/"phase":"source_scan_complete"/);
 assert.match(r.out,/"connection_losses":0/);
 const row=await runRow();
 assert.equal(row.status,'paused');assert.equal(row.notes.source_scan_complete,true);
 assert.equal(row.notes.external_stable,true,'the directory did not change under the run');
 // The queue may also hold people left pending by earlier runs on the same stack; the
 // contract checked here is about THIS test's people: each recorded exactly once.
 const rows=await recorded();
 assert.equal(rows.length,row.processed,'processed equals the records');
 assert.equal(new Set(rows.map(x=>x.candidate_id)).size,rows.length,'nobody recorded twice');
 const mine=rows.filter(x=>people.some(p=>p.id===x.candidate_id));
 assert.equal(mine.length,people.length,'every queued person of this test recorded once');
 for(const id of globalThis.__firstPass.rows)assert.ok(rows.some(x=>x.candidate_id===id),'first-pass work preserved');
 assert.ok(rows.every(x=>['verified','review'].includes(x.status)),JSON.stringify(rows.map(x=>x.status)));
 assert.equal((await site.query('select count(*)::int n from person_reconcile_pending where candidate_id=any($1::uuid[])',[people.map(p=>p.id)])).rows[0].n,0,'the queue is drained for them');
 console.log(JSON.stringify({evidence:'resume_pass',exit:r.code,processed:row.processed,status:row.status,external_stable:row.notes.external_stable,recorded:rows.length,mine:mine.length,runner:(r.out.split('\n').find(l=>l.includes('"phase":"catchup_runner"'))??'').slice(0,400)}));
});
