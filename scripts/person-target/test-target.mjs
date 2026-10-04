// Offline: no sockets, no files. Every synthetic value below is fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
 selectedTarget,hasSelectedTarget,restProjectRef,checkRestUrl,keyProjectRef,checkServiceKey,
 databaseIdentity,checkDatabaseUrl,checkLinkedWorkdir,checkTargetEnvironment,verifyRuntimeIdentity,identityValue,isTargetError,isSealedRestUrl,isLoopbackDatabaseUrl,
} from '../person-target.mjs';

const COPY='abcdefghijklmnopqrst',ORIGINAL='tsrqponmlkjihgfedcba';
const jwt=(payload)=>['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',Buffer.from(JSON.stringify(payload)).toString('base64url'),'sig'].join('.');
const rejects=(fn,code)=>assert.throws(fn,e=>isTargetError(e)&&e.message===`person_target:${code}`,code);

test('selection is explicit: missing, empty and malformed refs fail',()=>{
 rejects(()=>selectedTarget({}),'missing');
 rejects(()=>selectedTarget({PERSON_TARGET_PROJECT_REF:''}),'missing');
 rejects(()=>selectedTarget({PERSON_TARGET_PROJECT_REF:'Prod'}),'invalid');
 rejects(()=>selectedTarget({PERSON_TARGET_PROJECT_REF:`${COPY}.supabase.co`}),'invalid');
 assert.deepEqual(selectedTarget({PERSON_TARGET_PROJECT_REF:COPY}),{ref:COPY,local:false});
 assert.deepEqual(selectedTarget({PERSON_TARGET_PROJECT_REF:'local'}),{ref:'local',local:true});
 assert.equal(hasSelectedTarget({}),false);assert.equal(hasSelectedTarget({PERSON_TARGET_PROJECT_REF:COPY}),true);
});

test('REST URLs must name the selected project exactly',()=>{
 const target={ref:COPY,local:false};
 assert.equal(checkRestUrl(`https://${COPY}.supabase.co`,target),COPY);
 assert.equal(checkRestUrl(`https://${COPY}.supabase.co/`,target),COPY);
 rejects(()=>checkRestUrl(`https://${ORIGINAL}.supabase.co`,target),'rest_mismatch');
 rejects(()=>checkRestUrl(`http://${COPY}.supabase.co`,target),'rest_mismatch');
 rejects(()=>checkRestUrl(`https://${COPY}.supabase.co:8443`,target),'rest_mismatch');
 rejects(()=>checkRestUrl(`https://${COPY}.supabase.co/rest/v1`,target),'rest_mismatch');
 rejects(()=>checkRestUrl(`https://evil.example/${COPY}.supabase.co`,target),'rest_mismatch');
 rejects(()=>checkRestUrl(`https://${COPY}.supabase.co.evil.example`,target),'rest_mismatch');
 rejects(()=>checkRestUrl('',target),'rest_url');
 rejects(()=>checkRestUrl(undefined,target),'rest_url');
 assert.equal(restProjectRef('https://localhost:54321'),null);
 const local={ref:'local',local:true};
 assert.equal(checkRestUrl('http://127.0.0.1:54321',local),'local');
 assert.equal(checkRestUrl('http://local-only.invalid',local),'local');
 rejects(()=>checkRestUrl(`https://${COPY}.supabase.co`,local),'rest_mismatch');
 rejects(()=>checkRestUrl('https://api.example.test',local),'rest_mismatch');
});
test('sealed and loopback classification used by the server gate',()=>{
 assert.equal(isSealedRestUrl(undefined),true);assert.equal(isSealedRestUrl('http://local-only.invalid'),true);assert.equal(isSealedRestUrl('http://127.0.0.1:54321'),true);
 assert.equal(isSealedRestUrl(`https://${COPY}.supabase.co`),false);assert.equal(isSealedRestUrl('https://api.example.test'),false);assert.equal(isSealedRestUrl('not a url'),false);
 assert.equal(isLoopbackDatabaseUrl(undefined),true);assert.equal(isLoopbackDatabaseUrl('postgresql://postgres@127.0.0.1:55487/x'),true);
 assert.equal(isLoopbackDatabaseUrl(`postgres://postgres.${COPY}:pw@aws-0-us-east-2.pooler.supabase.com:6543/postgres`),false);
 assert.equal(isLoopbackDatabaseUrl('postgres://x@unknown.example:5432/db'),false);assert.equal(isLoopbackDatabaseUrl('garbage'),false);
});

test('service keys: claim must match; claimless keys are accepted only when permitted',()=>{
 const target={ref:COPY,local:false};
 assert.equal(keyProjectRef(jwt({iss:'supabase',ref:COPY,role:'service_role'})),COPY);
 assert.equal(keyProjectRef('sb_secret_abc'),null);
 assert.equal(keyProjectRef(jwt({role:'service_role'})),null);
 assert.equal(checkServiceKey(jwt({ref:COPY}),target),COPY);
 rejects(()=>checkServiceKey(jwt({ref:ORIGINAL}),target),'key_mismatch');
 rejects(()=>checkServiceKey('',target),'key_missing');
 assert.equal(checkServiceKey('sb_secret_abc',target),null);
 rejects(()=>checkServiceKey('sb_secret_abc',target,{requireClaim:true}),'key_unverifiable');
 rejects(()=>checkServiceKey(jwt({ref:COPY}),{ref:'local',local:true}),'key_mismatch');
 assert.equal(checkServiceKey('any-local-key',{ref:'local',local:true}),null);
});

test('PostgreSQL identity: direct host, pooler username suffix, loopback',()=>{
 assert.deepEqual(databaseIdentity(`postgresql://postgres:pw@db.${COPY}.supabase.co:5432/postgres`),{kind:'direct',ref:COPY,host:`db.${COPY}.supabase.co`,port:'5432',role:'postgres'});
 assert.deepEqual(databaseIdentity(`postgres://postgres.${COPY}:pw@aws-0-us-east-2.pooler.supabase.com:6543/postgres`),{kind:'pooler',ref:COPY,host:'aws-0-us-east-2.pooler.supabase.com',port:'6543',role:'postgres'});
 assert.deepEqual(databaseIdentity(`postgres://tt_readonly.${COPY}:pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`).role,'tt_readonly');
 assert.equal(databaseIdentity('postgresql://postgres@127.0.0.1:55487/x').kind,'local');
 assert.equal(databaseIdentity('postgresql://postgres@localhost:5432/x').kind,'local');
 assert.equal(databaseIdentity('postgresql://postgres@[::1]:5432/x').kind,'local');
 rejects(()=>databaseIdentity('postgres://postgres:pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres'),'pooler_username');
 rejects(()=>databaseIdentity('postgres://postgres:pw@proxy.example.com:5432/postgres'),'database_host');
 rejects(()=>databaseIdentity(`https://db.${COPY}.supabase.co`),'database_url');
 rejects(()=>databaseIdentity(`postgres://postgres:pw@db.${COPY}.supabase.co/postgres#frag`),'database_url');
 rejects(()=>databaseIdentity(''),'database_url');
});

test('database URLs are bound to the selection and optional transport ports',()=>{
 const target={ref:COPY,local:false};
 const session=`postgres://postgres.${COPY}:pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
 const transaction=`postgres://postgres.${COPY}:pw@aws-0-us-east-2.pooler.supabase.com:6543/postgres`;
 assert.equal(checkDatabaseUrl(session,target,{ports:['5432']}).kind,'pooler');
 rejects(()=>checkDatabaseUrl(transaction,target,{ports:['5432']}),'database_port');
 assert.equal(checkDatabaseUrl(transaction,target).port,'6543');
 // The shared pooler host is identical for every project in the region: only the
 // username distinguishes the original from the copy.
 rejects(()=>checkDatabaseUrl(`postgres://postgres.${ORIGINAL}:pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`,target),'database_mismatch');
 rejects(()=>checkDatabaseUrl(`postgresql://postgres:pw@db.${ORIGINAL}.supabase.co:5432/postgres`,target),'database_mismatch');
 rejects(()=>checkDatabaseUrl('postgresql://postgres@127.0.0.1:55487/x',target),'database_mismatch');
 const local={ref:'local',local:true};
 assert.equal(checkDatabaseUrl('postgresql://postgres@127.0.0.1:55487/x',local,{ports:['5432']}).kind,'local');
 rejects(()=>checkDatabaseUrl(session,local),'database_mismatch');
});

// R2-01: pg gives URL query options precedence over the authority. Every option that
// could move the driver's effective destination, and every option the validator does
// not understand, is refused; the validated identity must be the one pg connects to.
test('PostgreSQL query options cannot change the validated destination (R2-01)',async()=>{
 const target={ref:COPY,local:false};
 const direct=`postgresql://postgres:pw@db.${COPY}.supabase.co:5432/postgres`;
 const pooler=`postgres://postgres.${COPY}:pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
 const overrides=[
  [`${pooler}?user=postgres.${ORIGINAL}`,'pooler user override'],
  [`${direct}?host=db.${ORIGINAL}.supabase.co`,'direct host override'],
  [`${direct}?port=6543`,'port override'],
  [`${direct}?%68ost=db.${ORIGINAL}.supabase.co`,'percent-encoded parameter name'],
  [`${direct}?sslmode=require&host=db.${ORIGINAL}.supabase.co`,'override next to an allowed option'],
  [`${direct}?sslmode=require&sslmode=disable`,'duplicate TLS option (last one wins in pg)'],
  [`${direct}?dbname=other`,'unknown option'],
  [`${direct}?password=x`,'credential option'],
  [`${direct}?options=-c%20search_path%3Dx`,'session options'],
  [`${direct}?application_name=x`,'any other option'],
  [`${direct}?=x`,'empty parameter name'],
 ];
 for(const [url,why] of overrides){
  rejects(()=>databaseIdentity(url),'database_options');
  rejects(()=>checkDatabaseUrl(url,target),'database_options');
  assert.equal(isLoopbackDatabaseUrl(url),false,why);
 }
 // A loopback authority with a hosted override is NOT local: it must not switch
 // the hosted target checks off.
 const loopbackOverride=`postgresql://postgres@127.0.0.1:55487/x?host=db.${ORIGINAL}.supabase.co`;
 rejects(()=>databaseIdentity(loopbackOverride),'database_options');
 assert.equal(isLoopbackDatabaseUrl(loopbackOverride),false);
 rejects(()=>checkDatabaseUrl(loopbackOverride,{ref:'local',local:true}),'database_options');
 rejects(()=>checkDatabaseUrl(`postgresql://postgres@127.0.0.1:55487/x?port=5432`,{ref:'local',local:true}),'database_options');
 // The one supported option, once, keeps working.
 assert.equal(databaseIdentity(`${direct}?sslmode=verify-full`).ref,COPY);
 assert.equal(checkDatabaseUrl(`${pooler}?sslmode=require`,target,{ports:['5432']}).kind,'pooler');
 assert.equal(databaseIdentity('postgresql://postgres@127.0.0.1:55487/x?sslmode=disable').kind,'local');
 assert.equal(databaseIdentity(`${direct}?`).ref,COPY);
 // Agreement with the installed driver, without connecting: for every accepted URL
 // pg's effective host/port/user equal the validated identity.
 const {default:pg}=await import('pg');
 const effective=(url)=>{const p=new pg.Client({connectionString:url}).connectionParameters;return {host:p.host,port:String(p.port),role:p.user};};
 for(const url of [direct,`${direct}?sslmode=verify-full`,pooler,`${pooler}?sslmode=require`,'postgresql://postgres@127.0.0.1:55487/x','postgresql://postgres@localhost:5432/x']){
  const id=databaseIdentity(url);
  const role=id.kind==='pooler'?`${id.role}.${id.ref}`:id.role;
  assert.deepEqual(effective(url),{host:id.host,port:id.port,role},url);
 }
 // ...and for every refused override the driver WOULD have gone elsewhere, which is
 // why they are refused rather than compared.
 for(const [url,why] of [...overrides.slice(0,5),[loopbackOverride,'loopback authority, hosted host override']])
  assert.notDeepEqual(effective(url),effective(url.replace(/\?.*$/,'')),why);
 assert.equal(effective(loopbackOverride).host,`db.${ORIGINAL}.supabase.co`);
});

test('linked CLI workdirs',()=>{
 const target={ref:COPY,local:false};
 assert.equal(checkLinkedWorkdir(`${COPY}\n`,target),COPY);
 rejects(()=>checkLinkedWorkdir(ORIGINAL,target),'workdir_mismatch');
 rejects(()=>checkLinkedWorkdir('',target),'workdir_mismatch');
 rejects(()=>checkLinkedWorkdir(undefined,target),'workdir_mismatch');
 rejects(()=>checkLinkedWorkdir(COPY,{ref:'local',local:true}),'workdir_local');
});

test('whole-environment check: mixed REST/PG configurations are refused before any client exists',()=>{
 const env={PERSON_TARGET_PROJECT_REF:COPY,SUPABASE_URL:`https://${COPY}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:jwt({ref:COPY})};
 const ok=checkTargetEnvironment(env,{databaseUrls:[`postgres://postgres.${COPY}:pw@aws-0-us-east-2.pooler.supabase.com:6543/postgres`]});
 assert.deepEqual(ok,{ref:COPY,local:false,rest:COPY,key:COPY,databases:[{kind:'pooler',host:'aws-0-us-east-2.pooler.supabase.com',port:'6543'}]});
 // REST on the copy, PostgreSQL on the original: the review's mixed scenario.
 rejects(()=>checkTargetEnvironment(env,{databaseUrls:[`postgres://postgres.${ORIGINAL}:pw@aws-0-us-east-2.pooler.supabase.com:6543/postgres`]}),'database_mismatch');
 // Copy PostgreSQL with the original's key.
 rejects(()=>checkTargetEnvironment({...env,SUPABASE_SERVICE_ROLE_KEY:jwt({ref:ORIGINAL})}),'key_mismatch');
 // No selection at all.
 rejects(()=>checkTargetEnvironment({SUPABASE_URL:`https://${COPY}.supabase.co`}),'missing');
 // Absent signals are skipped, present ones are checked.
 assert.equal(checkTargetEnvironment({PERSON_TARGET_PROJECT_REF:COPY}).rest,null);
 assert.equal(checkTargetEnvironment({PERSON_TARGET_PROJECT_REF:COPY},{databaseUrls:[undefined]}).databases.length,0);
});

test('runtime identity: REST and PostgreSQL must report the same cluster',async()=>{
 assert.equal(identityValue({system_identifier:'7689662122152206805'}),'7689662122152206805');
 assert.equal(identityValue({identity:{system_identifier:'1'}}),'1');
 assert.equal(identityValue({system_identifier:'abc'}),null);
 assert.equal(identityValue(null),null);
 const same=await verifyRuntimeIdentity({readRest:async()=>({system_identifier:'42'}),readDatabase:async()=>({identity:{system_identifier:'42'}})});
 assert.deepEqual(same,{system_identifier:'42'});
 await assert.rejects(verifyRuntimeIdentity({readRest:async()=>({system_identifier:'42'}),readDatabase:async()=>({system_identifier:'43'})}),/person_target:identity_mismatch/);
 await assert.rejects(verifyRuntimeIdentity({readRest:async()=>{throw Error('HTTP_404');}}),/person_target:identity_rest/);
 await assert.rejects(verifyRuntimeIdentity({readDatabase:async()=>null}),/person_target:identity_database/);
 assert.deepEqual(await verifyRuntimeIdentity({readDatabase:async()=>({system_identifier:'7'})}),{system_identifier:'7'});
});
