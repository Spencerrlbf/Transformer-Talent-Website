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
const clears=Array.from({length:3},(_,n)=>({id:randomUUID(),n,kinds:n===0?['email']:n===1?['phone']:['email','phone']}));
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
 for(const p of clears){
  await site.query("insert into candidates(id,full_name,linkedin_username,email,phone,source,created_at) values($1,'Synthetic Suppressed',$2,$3,'+12025550100','leaktest','2025-01-01')",[p.id,`suppressed-${p.id.slice(0,8)}`,`clear-${p.id}@example.test`]);
  const receipt=randomUUID();
  await site.query("insert into person_recruiter_receipts(id,candidate_id,actor_id,input_hash,edited_at,requested_contact,document,mode) values($1,$2,$3,'synthetic',clock_timestamp(),'{}'::jsonb,'{}'::jsonb,'shadow')",[receipt,p.id,randomUUID()]);
  for(const kind of p.kinds)await site.query('insert into person_recruiter_primary(candidate_id,kind,chosen_value,receipt_id,suppressed) values($1,$2,null,$3,true)',[p.id,kind,receipt]);
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
function runRunner({onLine,config}){
 return new Promise((resolve)=>{
  const child=spawn(process.execPath,[runnerScript],{env:config?{...runnerEnv,BACKFILL_CONFIG:JSON.stringify(config)}:runnerEnv,stdio:['ignore','pipe','pipe']});
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
 assert.match(r.out,/"runner":"derived_pinned"/);
 assert.match(r.err,/"phase":"reconcile_stopped"/,'the pinned loop\'s own failure path ran');
 assert.match(r.err,/catchup_comms_connection_lost/,'the loss was recorded by the listener');
 assert.doesNotMatch(r.out,/source_scan_complete/,'no false success');
 assert.doesNotMatch(r.err,/uncaught|Unhandled/i);
 const row=await runRow();
 assert.equal(row.status,'failed');assert.equal(row.notes.reconciliation_pending,true);
 assert.ok(row.processed>=1&&row.processed<people.length+clears.length,`processed ${row.processed} of ${people.length} before the loss`);
 const rows=await recorded();
 assert.equal(rows.length,row.processed,'exactly the committed checkpoints are recorded');
 assert.equal(new Set(rows.map(x=>x.candidate_id)).size,rows.length,'no person recorded twice');
 globalThis.__firstPass={processed:row.processed,rows:rows.map(x=>x.candidate_id)};
 const lost=r.err.split('\n').find(l=>l.includes('catchup_comms_connection_lost'));
 console.log(JSON.stringify({evidence:'loss_pass',exit:r.code,checkpoints_before_loss:checkpoints,processed:row.processed,status:row.status,error_code:row.notes.error_code,listener:lost?JSON.parse(lost).code:null,runner_stopped:(r.out.split('\n').find(l=>l.includes('catchup_runner_stopped'))??'').slice(0,200)}));
});

test('late inputs against the real pinned tree are refused before any transport: aliases, arguments, a dry-run override',async()=>{
 const before=await runRow();
 for(const [label,extra,argv] of [['alias BACKFILL_RESUME=false',{BACKFILL_RESUME:'false'},[]],['alias BACKFILL_RUN_ID',{BACKFILL_RUN_ID:'other-run'},[]],['CLI --dry-run=true',{},['--dry-run=true']],['CLI --commit=…',{},['--commit=0000000000000000000000000000000000000000']]]){
  const r=await new Promise((resolve)=>{const child=spawn(process.execPath,[runnerScript,...argv],{env:{...runnerEnv,...extra},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',(c)=>out+=c);child.stderr.on('data',(c)=>err+=c);child.on('close',(code)=>resolve({code,out,err}));});
  assert.equal(r.code,1,label);
  assert.match(r.err,/catchup_run:(aliases|arguments)/,label);
  assert.doesNotMatch(r.out,/catchup_runner|reconcile_start/,`${label}: nothing started`);
 }
 assert.deepEqual(await runRow(),before,'the failed run was not touched');
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

test('explicit email, phone and both clears actually verify and checkpoint with decisions and history preserved',async()=>{
 for(const p of clears){
  const r=(await site.query('select status,checks,counted from person_reconcile_people where run_id=$1 and candidate_id=$2',[RUN,p.id])).rows[0];
  assert.equal(r.status,'verified');assert.equal(r.counted,true);assert.equal(r.checks.integrity_ok,true);
  const decisions=(await site.query('select kind,chosen_value,suppressed from person_recruiter_primary where candidate_id=$1 order by kind',[p.id])).rows;
  assert.deepEqual(decisions,p.kinds.map(kind=>({kind,chosen_value:null,suppressed:true})));
  const contacts=(await site.query('select kind,rank from candidate_contacts where candidate_id=$1',[p.id])).rows;
  for(const kind of p.kinds){assert.ok(contacts.some(c=>c.kind===kind));assert.ok(contacts.filter(c=>c.kind===kind).every(c=>c.rank===null));}
  assert.equal((await site.query('select count(*)::int n from person_reconcile_pending where candidate_id=$1',[p.id])).rows[0].n,0);
 }
});

async function derivedIO(){
 const {prepareCompatibilityRuntime}=await import('./contact-compat-runtime.mjs');
 const runtime=prepareCompatibilityRuntime({root:path.resolve(env.PINNED_RUNNER_DIR)});
 const trial=await import(pathToFileURL(runtime.root+'/scripts/person-trial.mjs'));
 const reconcile=await import(pathToFileURL(runtime.root+'/scripts/person-reconcile.mjs'));
 const lib=await import(pathToFileURL(runtime.root+'/scripts/dist/worker-lib.mjs'));
 const rest=trial.restSite(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY);
 const directory=await trial.openComms(env.COMMS_DATABASE_URL);
 return {trial,reconcile,lib,rest,directory,cols:await trial.commsColumns(directory)};
}
async function startRun(io,run,{limit=500,batch=500}={}){
 const hash=await io.reconcile.externalFingerprint(io.rest,io.directory,io.cols,io.lib);
 return io.rest.rpc('person_reconcile_start',{p_run:run,p_commit:'c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc',p_limit:limit,p_batch:batch,p_resume:false,p_scope:'queue',p_external_hash:hash});
}
async function certifiedClear(cid){
 const before=process.env.PERSON_TRANSITION_SUPPORT;process.env.PERSON_TRANSITION_SUPPORT='on';
 const current=await import('../dist/worker-lib.mjs');
 const connection=await site.connect();
 try{return await current.saveRecruiterContactOnConnection(connection,{organizationId:'801865a7-6533-41d2-9c45-e4a90e6ad51a',candidateId:cid,actorId:randomUUID(),requestId:randomUUID(),mode:'shadow',contact:{email:null,phone:null,github:null,otherEmails:[]}});}
 finally{connection.release();if(before===undefined)delete process.env.PERSON_TRANSITION_SUPPORT;else process.env.PERSON_TRANSITION_SUPPORT=before;}
}
for(const variant of [{curated:false,outcome:'verified'},{curated:true,outcome:'review'}])test(`certified clear race (${variant.curated?'curated':'scalar'} contacts): pending CAS, advanced checkpoint, new queue run ${variant.outcome}`,async()=>{
 const cid=randomUUID(),run=`race-${randomUUID().slice(0,8)}`;
 await site.query("insert into candidates(id,full_name,linkedin_username,email,phone,source,created_at,contact) values($1,'Synthetic Race',$2,$3,'+12025550101','leaktest','2025-01-01',$4::jsonb)",[cid,`race-${cid.slice(0,8)}`,`race-${cid}@example.test`,variant.curated?JSON.stringify({email:`race-${cid}@example.test`,phone:'+12025550101'}):null]);
 const io=await derivedIO();
 try{
  const baseline=`baseline-${randomUUID().slice(0,8)}`;
  await startRun(io,baseline);
  const initial=(await io.rest.rpc('person_reconcile_page',{p_run:baseline,p_size:500})).filter(p=>p.id===cid);
  await io.reconcile.reconcilePage({site:io.rest,lib:io.lib,comms:io.directory,cols:io.cols,config:{run:baseline,dry:false},page:initial});
  assert.equal((await site.query('select status from person_reconcile_people where run_id=$1 and candidate_id=$2',[baseline,cid])).rows[0].status,'verified');
  const {openAnchorDatabase}=await import('../person-audit/database.mjs');
  const current=await import('../dist/worker-lib.mjs');
  const anchor=await openAnchorDatabase({LOCAL_DATABASE_URL:env.WEBSITE_DATABASE_URL});
  try{
   const snapshots=await anchor.rpc('person_audit_anchor_inputs',{p_ids:[cid]});
   const prepared=snapshots.map(current.prepareLegacyAuditAnchor);assert.equal(prepared[0].status,'ready');
   assert.equal((await anchor.rpc('person_audit_anchor_commit',{p_items:prepared}))[0].status,'created');
  }finally{await anchor.end();}
  await site.query("update backfill_runs set status='paused' where run_id=$1",[baseline]);
  await site.query('insert into person_change_queue(candidate_id,version) select $1,max(id) from person_change_events where candidate_id=$1 on conflict(candidate_id) do update set version=excluded.version',[cid]);
  await startRun(io,run);
  const page=(await io.rest.rpc('person_reconcile_page',{p_run:run,p_size:500})).filter(p=>p.id===cid);
  assert.equal(page.length,1);
  let snapshotRevision;
  await io.reconcile.reconcilePage({site:io.rest,lib:io.lib,comms:io.directory,cols:io.cols,config:{run,dry:false},page,beforeRecord:async()=>{
   snapshotRevision=(await site.query('select rev from candidate_profile_state where candidate_id=$1',[cid])).rows[0].rev;
   const saved=await certifiedClear(cid);assert.equal(saved.contact.email,null);assert.equal(saved.contact.phone,null);
  }});
  const recorded=(await site.query('select status,counted,revision from person_reconcile_people where run_id=$1 and candidate_id=$2',[run,cid])).rows[0];
  assert.equal(recorded.status,'pending');assert.equal(recorded.counted,true);assert.equal(Number(recorded.revision),Number(snapshotRevision));
  const row=(await site.query('select last_id,processed from backfill_runs where run_id=$1',[run])).rows[0];
  assert.equal(row.last_id,cid);assert.equal(row.processed,1);
  const version=(await site.query('select version from person_change_queue where candidate_id=$1',[cid])).rows[0].version;
  assert.ok(Number(version)>Number(page[0].captured_version));
  assert.ok(Number((await site.query('select rev from candidate_profile_state where candidate_id=$1',[cid])).rows[0].rev)>Number(snapshotRevision));
  assert.ok(!(await io.rest.rpc('person_reconcile_page',{p_run:run,p_size:500})).some(p=>p.id===cid),'same-run resume does not revisit older id');
  // Close the synthetic partial run before preparing the new bounded queue run.
  await site.query("update backfill_runs set status='paused' where run_id=$1",[run]);
  const follow=`follow-${randomUUID().slice(0,8)}`;await startRun(io,follow);
  const next=(await io.rest.rpc('person_reconcile_page',{p_run:follow,p_size:500})).filter(p=>p.id===cid);assert.equal(next.length,1);
  await io.reconcile.reconcilePage({site:io.rest,lib:io.lib,comms:io.directory,cols:io.cols,config:{run:follow,dry:false},page:next});
  const review=(await site.query('select status,checks,counted from person_reconcile_people where run_id=$1 and candidate_id=$2',[follow,cid])).rows[0];
  assert.equal(review.status,variant.outcome);if(variant.curated)assert.equal(review.checks.reason,'same_snapshot_mutation');else assert.equal(review.checks.integrity_ok,true);assert.equal(review.counted,true);
  assert.equal((await site.query('select count(*)::int n from person_reconcile_pending where candidate_id=$1',[cid])).rows[0].n,variant.curated?1:0,'review stays queued; verified scalar clear drains');
  const decisions=(await site.query('select kind,chosen_value,suppressed from person_recruiter_primary where candidate_id=$1 order by kind',[cid])).rows;
  assert.deepEqual(decisions,['email','phone'].map(kind=>({kind,chosen_value:null,suppressed:true})));
  assert.ok((await site.query('select rank from candidate_contacts where candidate_id=$1',[cid])).rows.every(c=>c.rank===null));
  assert.ok((await site.query('select count(*)::int n from candidate_contacts where candidate_id=$1',[cid])).rows[0].n>=2,'email and phone history retained');
 }finally{await io.directory.end();await io.rest.end?.();}
});

test('normalized selected contact later bounced uses SQL eligible fallback accepted by both historical and derived verifiers',async()=>{
 const cid=randomUUID(),receipt=randomUUID();
 await site.query("insert into candidates(id,full_name,linkedin_username,source,created_at) values($1,'Synthetic Bounced',$2,'leaktest','2025-01-01')",[cid,`bounced-${cid.slice(0,8)}`]);
 await site.query("insert into person_recruiter_receipts(id,candidate_id,actor_id,input_hash,edited_at,requested_contact,document,mode) values($1,$2,$3,'synthetic',clock_timestamp(),'{}'::jsonb,'{}'::jsonb,'shadow')",[receipt,cid,randomUUID()]);
 await site.query("insert into person_recruiter_primary(candidate_id,kind,chosen_value,receipt_id,suppressed) values($1,'email','selected@example.test',$2,false)",[cid,receipt]);
 await site.query("insert into candidate_contacts(candidate_id,kind,value_raw,value_normalized,source,status) values($1,'email','selected@example.test','selected@example.test','legacy_import','active'),($1,'email','fallback@example.test','fallback@example.test','legacy_import','active')",[cid]);
 await site.query('select person_rerank_contacts($1)',[cid]);
 assert.equal((await site.query('select value_normalized from candidate_contacts where candidate_id=$1 and rank=1',[cid])).rows[0].value_normalized,'selected@example.test');
 await site.query("update candidate_contacts set status='bounced',rank=null where candidate_id=$1 and value_normalized='selected@example.test'",[cid]);
 await site.query('select person_rerank_contacts($1)',[cid]);
 assert.equal((await site.query('select value_normalized from candidate_contacts where candidate_id=$1 and rank=1',[cid])).rows[0].value_normalized,'fallback@example.test');
 const io=await derivedIO();
 try{
  await site.query('insert into candidate_profile_state(candidate_id,rev) values($1,1)',[cid]);
  const stored=await io.trial.readNew(io.rest,[cid],{globalCounts:false});
  const old=await import(pathToFileURL(path.join(env.PINNED_RUNNER_DIR,'scripts/person-trial.mjs')));
  for(const mod of [old,io.trial]){const tally=new mod.Tally();mod.checkStored(tally,cid,{row:{work_experience:[]},legacy:[],v2:[],ledger:[],apps:[]},[],stored,{project:()=>({})});assert.equal(tally.fail.size,0);}
  assert.equal(stored.decisions.get(`${cid}:email`).chosen_value,'selected@example.test');
 }finally{await io.directory.end();await io.rest.end?.();}
});

test('actual scalar REST snapshot bypasses row cap and finds affected candidate after >1001 global suppressed decisions',async()=>{
 const fillers=Array.from({length:1002},()=>`00000000${randomUUID().slice(8)}`),cid=`ffffffff${randomUUID().slice(8)}`;
 const ids=[...fillers,cid];
 await site.query("insert into candidates(id,full_name,linkedin_username,source,created_at) select id,'Synthetic Cap','cap-'||id::text,'leaktest','2025-01-01' from unnest($1::uuid[]) id",[ids]);
 await site.query("insert into person_recruiter_receipts(id,candidate_id,actor_id,input_hash,edited_at,requested_contact,document,mode) select gen_random_uuid(),id,gen_random_uuid(),'synthetic',clock_timestamp(),'{}'::jsonb,'{}'::jsonb,'shadow' from unnest($1::uuid[]) id",[ids]);
 await site.query("insert into person_recruiter_primary(candidate_id,kind,chosen_value,receipt_id,suppressed) select candidate_id,'email',null,id,true from person_recruiter_receipts where candidate_id=any($1::uuid[])",[ids]);
 await site.query("insert into candidate_contacts(candidate_id,kind,value_raw,value_normalized,source,status) select $1,'email','cap-'||n||'@example.test','cap-'||n||'@example.test','legacy_import','active' from generate_series(1,1500) n",[cid]);
 // The unrelated historical decision population is outside this run's pending queue.
 await site.query('update person_change_events set reconciled_at=clock_timestamp() where candidate_id=any($1::uuid[])',[fillers]);
 await site.query('delete from person_change_queue where candidate_id=any($1::uuid[])',[fillers]);
 const headers={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`};
 const cap=await fetch(`${env.SUPABASE_URL}/rest/v1/candidate_contacts?candidate_id=eq.${cid}&select=id&limit=2000`,{headers});assert.equal(cap.ok,true);assert.equal((await cap.json()).length,1000,'actual PostgREST row cap');
 const scan=await fetch(`${env.SUPABASE_URL}/rest/v1/person_recruiter_primary?suppressed=eq.true&select=candidate_id&order=candidate_id.asc&limit=1001`,{headers});assert.equal(scan.ok,true);assert.ok(!(await scan.json()).some(r=>r.candidate_id===cid),'old global scan would miss target');
 const io=await derivedIO();
 try{
  await site.query('insert into candidate_profile_state(candidate_id,rev) values($1,1)',[cid]);
  const stored=await io.trial.readNew(io.rest,[cid],{globalCounts:false});assert.equal(stored.contacts.get(cid).length,1500);assert.equal(stored.decisions.get(`${cid}:email`).suppressed,true);
  const run=`cap-${randomUUID().slice(0,8)}`;await startRun(io,run,{limit:100,batch:1});
  const config={...JSON.parse(runnerEnv.BACKFILL_CONFIG),'run-id':run};
  const r=await runRunner({config});assert.equal(r.code,0,r.out+r.err);
  const record=(await site.query('select status,checks,counted from person_reconcile_people where run_id=$1 and candidate_id=$2',[run,cid])).rows[0];
  assert.equal(record.status,'verified');assert.equal(record.counted,true);assert.equal(record.checks.integrity_ok,true);
  assert.equal((await site.query('select count(*)::int n from candidate_contacts where candidate_id=$1',[cid])).rows[0].n,1500);
  assert.equal((await site.query('select count(*)::int n from person_reconcile_pending where candidate_id=$1',[cid])).rows[0].n,0);
 }finally{await io.directory.end();await io.rest.end?.();}
});
test('real REST snapshot row and serialized-byte capacity failures abort without truncating evidence',async()=>{
 const rowCid=randomUUID(),byteCid=randomUUID();
 for(const cid of [rowCid,byteCid]){
  await site.query("insert into candidates(id,full_name,linkedin_username,source,created_at) values($1,'Synthetic Capacity',$2,'leaktest','2025-01-01')",[cid,`capacity-${cid.slice(0,8)}`]);
  await site.query('insert into candidate_profile_state(candidate_id,rev) values($1,1)',[cid]);
 }
 await site.query("insert into candidate_contacts(candidate_id,kind,value_raw,value_normalized,source,status) select $1,'email','row-'||n||'@example.test','row-'||n||'@example.test','legacy_import','active' from generate_series(1,10001) n",[rowCid]);
 await site.query("insert into candidate_contacts(candidate_id,kind,value_raw,value_normalized,source,status) values($1,'email',repeat('x',1048576),'byte@example.test','legacy_import','active')",[byteCid]);
 const io=await derivedIO();
 try{
  assert.equal((await io.trial.readNew(io.rest,[byteCid],{globalCounts:false})).contacts.get(byteCid).length,1,'below byte budget succeeds');
  await assert.rejects(io.trial.readNew(io.rest,[rowCid],{globalCounts:false}),/contact_snapshot_capacity/);
  await site.query("update candidate_contacts set value_raw=repeat('x',9000000) where candidate_id=$1",[byteCid]);
  await assert.rejects(io.trial.readNew(io.rest,[byteCid],{globalCounts:false}),/contact_snapshot_capacity/);
  assert.equal((await site.query('select count(*)::int n from candidate_contacts where candidate_id=$1',[rowCid])).rows[0].n,10001,'capacity refusal preserves all stored rows');
  // Exactly 10,000 small rows approach the serialized budget from below, then
  // cross it by one extra raw byte per row. No full aggregation occurs above it.
  const nearCid=randomUUID();
  await site.query("insert into candidates(id,full_name,linkedin_username,source,created_at) values($1,'Synthetic Near Capacity',$2,'leaktest','2025-01-01')",[nearCid,`near-${nearCid.slice(0,8)}`]);
  await site.query('insert into candidate_profile_state(candidate_id,rev) values($1,1)',[nearCid]);
  await site.query("insert into candidate_contacts(candidate_id,kind,value_raw,value_normalized,source,status) select $1,'email','x',n::text,'legacy_import','active' from generate_series(1,10000) n",[nearCid]);
  const budget=Number((await site.query("select (select sum(octet_length(to_jsonb(c)::text)) from candidate_contacts c where candidate_id=$1)+(select octet_length(to_jsonb(s)::text) from candidate_contact_summary s where candidate_id=$1)+(select octet_length(to_jsonb(s)::text) from candidate_profile_state s where candidate_id=$1)+16*(10000+4)+1024 n",[nearCid])).rows[0].n);
  assert.ok(budget<8388608);
  const pad=1+Math.floor((8388608-budget-1024)/10000);
  await site.query("update candidate_contacts set value_raw=repeat('x',$2) where candidate_id=$1",[nearCid,pad]);
  assert.equal((await io.trial.readNew(io.rest,[nearCid],{globalCounts:false})).contacts.get(nearCid).length,10000);
  await site.query("update candidate_contacts set value_raw=repeat('x',$2) where candidate_id=$1",[nearCid,pad+2]);
  await assert.rejects(io.trial.readNew(io.rest,[nearCid],{globalCounts:false}),/contact_snapshot_capacity/);

 }finally{await io.directory.end();await io.rest.end?.();}
});
test('real reconcile page snapshot failures and stripped decision evidence cannot record or checkpoint; retry succeeds',async()=>{
 const cid=randomUUID(),receipt=randomUUID(),run=`evidence-${randomUUID().slice(0,8)}`;
 await site.query("insert into candidates(id,full_name,linkedin_username,email,source,created_at) values($1,'Synthetic Evidence',$2,$3,'leaktest','2025-01-01')",[cid,`evidence-${cid.slice(0,8)}`,`evidence-${cid}@example.test`]);
 await site.query("insert into person_recruiter_receipts(id,candidate_id,actor_id,input_hash,edited_at,requested_contact,document,mode) values($1,$2,$3,'synthetic',clock_timestamp(),'{}'::jsonb,'{}'::jsonb,'shadow')",[receipt,cid,randomUUID()]);
 await site.query("insert into person_recruiter_primary(candidate_id,kind,chosen_value,receipt_id,suppressed) values($1,'email',null,$2,true)",[cid,receipt]);
 const io=await derivedIO();
 try{
  await startRun(io,run);
  const page=(await io.rest.rpc('person_reconcile_page',{p_run:run,p_size:500})).filter(p=>p.id===cid);assert.equal(page.length,1);
  for(const mode of ['unavailable','partial','rank1','rank2']){
   const fault={...io.rest,rpc:async(name,args)=>{
    if(name==='person_catchup_contact_snapshot'){
     if(mode==='unavailable')throw Error('fixture_snapshot_unavailable');
     if(mode==='rank1'||mode==='rank2')await site.query('update candidate_contacts set rank=$2 where candidate_id=$1 and kind=\'email\'',[cid,mode==='rank1'?1:2]);
     const snapshot=await io.rest.rpc(name,args);assert.equal(snapshot.decisions.length,1);return mode==='partial'?{...snapshot,decisions:[]}:snapshot;
    }
    return io.rest.rpc(name,args);
   }};
   await assert.rejects(io.reconcile.reconcilePage({site:fault,lib:io.lib,comms:io.directory,cols:io.cols,config:{run,dry:false},page}),mode==='unavailable'?/fixture_snapshot_unavailable/:mode==='partial'?/contact_snapshot/:/post_save_integrity:one_primary_email/);
   if(mode==='rank1'||mode==='rank2')await site.query('update candidate_contacts set rank=null where candidate_id=$1',[cid]);
   assert.equal((await site.query('select count(*)::int n from person_reconcile_people where run_id=$1',[run])).rows[0].n,0);
   const checkpoint=(await site.query('select processed,last_id from backfill_runs where run_id=$1',[run])).rows[0];assert.equal(checkpoint.processed,0);assert.equal(checkpoint.last_id,null);
  }
  await io.reconcile.reconcilePage({site:io.rest,lib:io.lib,comms:io.directory,cols:io.cols,config:{run,dry:false},page});
  assert.equal((await site.query('select status,counted from person_reconcile_people where run_id=$1 and candidate_id=$2',[run,cid])).rows[0].status,'verified');
 }finally{await io.directory.end();await io.rest.end?.();}
});
