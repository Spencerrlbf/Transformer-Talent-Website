import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {main, PIN, reasonOf, openReadOnlyDirectory} from './start-catchup.mjs';
function fixture(overrides={}){
 const calls=[],out=[],root=process.cwd();
 const config={run:'synthetic-catchup',limit:10,batch:2,commit:PIN,dry:false,resume:false,maxBytes:34000000000,maxSeconds:60};
 const env={PINNED_RUNNER_DIR:root,SUPABASE_URL:'https://kmuihequfurvjxpnugxf.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic',COMMS_DATABASE_URL:'postgresql://synthetic:secret-sentinel@127.0.0.1:55487/fixture',BACKFILL_CONFIG:JSON.stringify({reconcile:true,scope:'queue','dry-run':false})};
 const site={select:async()=>{calls.push('existing');return overrides.existing??[];},rpc:async(fn,args)=>{calls.push([fn,args]);if(fn==='person_backfill_metrics')return overrides.metrics??{database_bytes:100,blocked_sessions:0};if(overrides.startError)throw overrides.startError;return {run_id:config.run,status:'running'};},end:async()=>{calls.push('site_end');if(overrides.endError)throw Error('secret-sentinel');}};
 const comms={end:async()=>{calls.push('comms_end');if(overrides.endError)throw Error('secret-sentinel');}};
 const deps={env,verify:async()=>({root,bundleHash:'a'.repeat(64)}),out:r=>out.push(r),openDirectory:async()=>{calls.push('open_comms');if(overrides.openError)throw overrides.openError;return comms;},importPinned:async(_,file)=>{
  calls.push(file);
  if(file==='person-backfill.mjs')return {options:()=>({...config,...overrides.config})};
  if(file==='person-trial.mjs')return {restSite:()=>{calls.push('open_site');return site;},commsColumns:async()=>new Map()};
  if(file==='person-reconcile.mjs')return {externalFingerprint:async()=>{calls.push('fingerprint');if(overrides.fingerprintError)throw overrides.fingerprintError;return 'b'.repeat(32);}};
  return {};
 }};
 return {deps,calls,out,root};
}
const starts=c=>c.filter(x=>Array.isArray(x)&&x[0]==='person_reconcile_start');
test('successful start uses actual pin and fingerprint and closes both resources',async()=>{
 const f=fixture();const r=await main([],f.deps);assert.equal(r.commit,PIN);assert.equal(r.bundle_sha256,'a'.repeat(64));assert.equal(starts(f.calls).length,1);assert.equal(starts(f.calls)[0][1].p_external_hash,'b'.repeat(32));assert.equal(starts(f.calls)[0][1].p_resume,false);assert.ok(f.calls.indexOf('existing')<f.calls.indexOf('fingerprint'));assert.deepEqual(f.calls.slice(-2),['comms_end','site_end']);assert.equal(process.cwd(),f.root);assert.equal(f.out.length,1);
});
test('second connection failure still closes the first resource',async()=>{
 const f=fixture({openError:Error('secret-sentinel')});await assert.rejects(main([],f.deps));assert.equal(f.calls.filter(x=>x==='site_end').length,1);assert.equal(starts(f.calls).length,0);assert.equal(process.cwd(),f.root);assert.equal(f.out.length,0);
});
for(const status of ['running','paused','failed','review_required','completed'])test(`existing ${status} checkpoint is never restarted`,async()=>{
 const f=fixture({existing:[{run_id:'synthetic-catchup',status}]});await assert.rejects(main([],f.deps),/catchup_start:existing_run/);assert.ok(!f.calls.includes('fingerprint'));assert.equal(starts(f.calls).length,0);
});
for(const metrics of [{database_bytes:34000000000,blocked_sessions:0},{database_bytes:100,blocked_sessions:6},{blocked_sessions:0}])test('capacity refusal precedes fingerprint and start',async()=>{
 const f=fixture({metrics});await assert.rejects(main([],f.deps),/catchup_start:capacity/);assert.ok(!f.calls.includes('fingerprint'));assert.equal(starts(f.calls).length,0);
});
test('fingerprint failure leaves no start and closes both resources despite cleanup errors',async()=>{
 const f=fixture({fingerprintError:Object.assign(Error('secret-sentinel'),{code:'57014'}),endError:true});await assert.rejects(main([],f.deps),e=>reasonOf(e)==='operation_failed:57014');assert.equal(starts(f.calls).length,0);assert.deepEqual(f.calls.slice(-2),['comms_end','site_end']);assert.equal(process.cwd(),f.root);assert.equal(f.out.length,0);
});
test('lost start response is not retried automatically',async()=>{
 const f=fixture({startError:Object.assign(Error('secret-sentinel'),{code:'ECONNRESET'})});await assert.rejects(main([],f.deps),e=>reasonOf(e)==='operation_failed:unknown');assert.equal(starts(f.calls).length,1);assert.equal(f.out.length,0);
});
test('parser commit mismatch refuses before resource acquisition',async()=>{
 const f=fixture({config:{commit:'0'.repeat(40)}});await assert.rejects(main([],f.deps),/catchup_start:config/);assert.ok(!f.calls.includes('open_site'));
});
test('CLI overrides and local website targets are refused',async()=>{
 const f=fixture();await assert.rejects(main(['--commit='+PIN],f.deps),/catchup_start:config/);f.deps.env.LOCAL_DATABASE_URL='postgresql://synthetic@127.0.0.1/fixture';await assert.rejects(main([],f.deps),/catchup_start:credentials/);assert.ok(!f.calls.includes('open_site'));
});
for(const value of [Error('secret-sentinel'),new TypeError('secret-sentinel'),Object.assign(Error('secret-sentinel'),{code:'ECONNRESET'}),Error('catchup_start:secret-sentinel')])test('unknown errors expose no raw content',()=>assert.equal(reasonOf(value),'operation_failed:unknown'));
function fakeClient(fail){let instance;class Client extends EventEmitter{
 constructor(config){super();this.config=config;this.ends=0;this.sql=[];instance=this;}
 async connect(){if(fail==='connect')throw Object.assign(Error('secret-sentinel'),{code:'ETIMEDOUT'});}
 async query(sql){this.sql.push(sql);if(fail==='query')throw Error('secret-sentinel');}
 async end(){this.ends++;}
 }return {Client,get:()=>instance};}
for(const fail of ['connect','query'])test(`failed ${fail} cleans up its partially acquired client`,async()=>{
 const f=fakeClient(fail);await assert.rejects(openReadOnlyDirectory('postgresql://synthetic@127.0.0.1/fixture',f));assert.equal(f.get().ends,1);assert.equal(f.get().config.connectionTimeoutMillis,10000);assert.equal(f.get().config.query_timeout,9000);assert.doesNotThrow(()=>f.get().emit('error',Error('secret-sentinel')));
});
test('directory uses read-only default and explicit bounded statement timeout',async()=>{
 const f=fakeClient();const db=await openReadOnlyDirectory('postgresql://synthetic@127.0.0.1/fixture',f);assert.deepEqual(db.sql,["set statement_timeout='8s'",'set default_transaction_read_only=on']);await db.end();assert.equal(db.ends,1);
});
test('URL options cannot override transport timeout or target',async()=>{
 const f=fakeClient();await assert.rejects(openReadOnlyDirectory('postgresql://synthetic@127.0.0.1/fixture?options=-cstatement_timeout%3D0',f),/catchup_start:credentials/);assert.equal(f.get(),undefined);
});

for(const uri of ['postgresql://synthetic@aws-0-eu-west-1.pooler.supabase.com:6543/db','postgresql://synthetic@unverified.example:5432/db'])test('unverified or transaction-pooler directory endpoint is refused before connecting',async()=>{
 const f=fakeClient();await assert.rejects(openReadOnlyDirectory(uri,f),/catchup_start:session_connection_required/);assert.equal(f.get(),undefined);
});
test('verified session directory endpoint retains explicit query bounds',async()=>{
 const f=fakeClient();const db=await openReadOnlyDirectory('postgresql://synthetic@aws-0-eu-west-1.pooler.supabase.com:5432/db',f);assert.equal(f.get().config.statement_timeout,8000);await db.end();
});
test('elapsed helper budget refuses checkpoint start after fingerprint',async()=>{
 const f=fixture({config:{maxSeconds:1}});let now=0;f.deps.now=()=>now;
 const load=f.deps.importPinned;f.deps.importPinned=async(root,file)=>file==='person-reconcile.mjs'?{externalFingerprint:async()=>{now=1001;return 'b'.repeat(32);}}:load(root,file);
 await assert.rejects(main([],f.deps),/catchup_start:deadline/);assert.equal(starts(f.calls).length,0);assert.deepEqual(f.calls.slice(-2),['comms_end','site_end']);
});
