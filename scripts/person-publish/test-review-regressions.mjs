// Synthetic PostgreSQL regressions for the independently reproduced runbook defects.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import * as lib from '../dist/worker-lib.mjs';
import {prepareAuditFixture} from '../person-audit/local-fixture.mjs';
import {runPublish, SPEC} from '../person-publish.mjs';
import {runUndo, SPEC as UNDO} from '../person-publish-undo.mjs';
import {parseOptions,databaseConfig} from './lib.mjs';
import {setGuard, testAllowed} from '../person-guard.mjs';

const url = process.env.LOCAL_DATABASE_URL;
assert.ok(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname));
const pool = new pg.Pool({connectionString: url, max: 4, statement_timeout: 15000});
const quiet = () => {};
const read = async id => (await pool.query('select to_jsonb(c) row from candidates c where id=$1', [id])).rows[0].row;
const options = (run, ids, extra=[]) => parseOptions([`--run-id=${run}`, '--mode=publish', `--ids=${ids}`, ...extra], SPEC);
const publish = (run, ids, extra=[], hooks={}) => runPublish({pool, lib, options: options(run, ids, extra), onProgress: quiet, hooks});
const undo = run => runUndo({pool, lib, options: parseOptions([`--run-id=${run}`, '--apply'], UNDO), onProgress: quiet});
async function fixture({anchor=true, job=true}={}) {
  const id = randomUUID(), name = `Synthetic ${id}`;
  await pool.query(`insert into candidates(id, full_name, linkedin_username, current_title, current_company, work_experience, created_at)
    values($1::uuid,$2,$1::text,$3,$4,$5,'2025-01-01')`,
  [id, name, job?'Engineer':null, job?name:null, job?JSON.stringify([{title:'Engineer', company:name, is_current:true, start_date:{year:2020,month:'Jan'}}]):null]);
  if (anchor) await prepareAuditFixture(id);
  else await pool.query('select save_person($1::jsonb)', [lib.fromLegacyImport(await read(id), [], [], [])]);
  return id;
}
test.after(() => pool.end());

test('run CLIs require a dedicated direct/session connection on the explicitly selected project', () => {
  // Fictional project refs: the selected target and a different project.
  const ref='abcdefghijklmnopqrst', other='tsrqponmlkjihgfedcba';
  const direct=`postgresql://postgres:synthetic@db.${ref}.supabase.co:5432/postgres?sslmode=require`;
  const session=`postgresql://postgres.${ref}:synthetic@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require`;
  const env={PERSON_TARGET_PROJECT_REF:ref};
  assert.equal(databaseConfig({...env,PERSON_PUBLISH_DATABASE_URL:direct}).connectionString,direct);
  assert.equal(databaseConfig({...env,PERSON_PUBLISH_DATABASE_URL:session}).connectionString,session);
  for(const url of [direct.replace(':5432/',':6543/'),session.replace(':5432/',':6543/'),direct.replace(`db.${ref}.supabase.co`,'unknown-proxy.example.test')])
    assert.throws(()=>databaseConfig({...env,PERSON_PUBLISH_DATABASE_URL:url}),/publish_session_connection_required/);
  assert.throws(()=>databaseConfig({...env,PERSON_DATABASE_URL:session}),/publish_database_url_required/);
  // RR-06/07: a hosted URL without a selection, or for another project, is refused.
  assert.throws(()=>databaseConfig({PERSON_PUBLISH_DATABASE_URL:session}),/person_target:missing/);
  assert.throws(()=>databaseConfig({...env,PERSON_PUBLISH_DATABASE_URL:session.replace(`postgres.${ref}`,`postgres.${other}`)}),/person_target:database_mismatch/);
  assert.throws(()=>databaseConfig({...env,PERSON_PUBLISH_DATABASE_URL:direct.replace(ref,other)}),/person_target:database_mismatch/);
  // Loopback fixtures need no selection.
  assert.equal(databaseConfig({LOCAL_DATABASE_URL:'postgresql://postgres@127.0.0.1:55487/fixture'}).connectionString,'postgresql://postgres@127.0.0.1:55487/fixture');
});

test('unchanged publication without an anchor writes no publication state', async () => {
  const id = await fixture({anchor:false, job:false});
  const result = await publish('reg-no-anchor', id);
  assert.equal(result.audit_blocked, 1);
  assert.equal((await pool.query('select count(*)::int n from person_projection_state where candidate_id=$1',[id])).rows[0].n, 0);
});

test('unchanged publication still rejects an unattributed source metadata edit', async () => {
  const id = await fixture({job:false});
  await pool.query("update candidates set linkedin_enrichment_date='2025-03-01' where id=$1",[id]);
  const result = await publish('reg-noop-stale', id);
  assert.equal(result.audit_blocked, 1);
  assert.equal((await pool.query('select count(*)::int n from person_projection_state where candidate_id=$1',[id])).rows[0].n, 0);
});

test('undo A cannot restore later B at the same normalized revision', async () => {
  const id = await fixture();
  assert.equal((await publish('reg-undo-a', id)).projected, 1);
  await pool.query("update companies set linkedin_url='https://www.linkedin.com/company/synthetic-review-company' where id in(select company_id from candidate_experiences where candidate_id=$1 and source='person')",[id]);
  assert.equal((await publish('reg-undo-b', id)).projected, 1);
  const before = await read(id);
  const history = (await pool.query('select id::text,revision::text from person_projection_history where candidate_id=$1 order by id',[id])).rows;
  assert.equal(history[0].revision, history[1].revision);
  const result = await undo('reg-undo-a');
  assert.equal(result.conflict, 1);
  assert.equal(result.restored, 0);
  assert.deepEqual(await read(id), before);
  assert.equal((await pool.query('select count(*)::int n from person_projection_history where candidate_id=$1 and restored_at is not null',[id])).rows[0].n,0);
  assert.equal((await undo('reg-undo-b')).restored, 1);
});

test('resume preserves one durable original outcome even after a lost page checkpoint', async () => {
  const id = await fixture();
  await assert.rejects(publish('reg-count',id,[],{afterPerson(){throw Error('synthetic_crash');}}), /synthetic_crash/);
  const before=(await pool.query("select * from person_publish_results where run_id='reg-count'")).rows;
  const first=await publish('reg-count',id,['--resume']);
  const second=await publish('reg-count',id,['--resume']);
  assert.equal(first.processed,1); assert.equal(second.processed,1);
  assert.equal(second.projected,1); assert.equal(second.unchanged,0);
  assert.deepEqual((await pool.query("select * from person_publish_results where run_id='reg-count'")).rows,before);
});

test('resume pins the exact requested candidate set', async () => {
  const id=await fixture(), another=await fixture();
  await publish('reg-config',id);
  await assert.rejects(publish('reg-config',another,['--resume']),/publish_run_config_differs/);
});

test('a publication and its durable result commit together', async () => {
  const id=await fixture();
  await pool.query(`create function public.synthetic_fail_result() returns trigger language plpgsql as $$begin
    if new.run_id='reg-atomic' then raise exception 'synthetic_result_failure'; end if; return new; end$$;
    create trigger synthetic_fail_result before insert on person_publish_results for each row execute function synthetic_fail_result()`);
  try {
    const before=await read(id);
    await assert.rejects(publish('reg-atomic',id), /synthetic_result_failure/);
    assert.deepEqual(await read(id), before);
    assert.equal((await pool.query('select count(*)::int n from person_projection_history where candidate_id=$1',[id])).rows[0].n,0);
  } finally {await pool.query('drop trigger synthetic_fail_result on person_publish_results; drop function synthetic_fail_result()');}
});

test('enabled guard requires exact attribution at commit, not just a valid operation', async () => {
  const id=await fixture(), client=await pool.connect();
  await setGuard(pool,true,'synthetic regression');
  try {
    await client.query('begin; set local role service_role');
    await client.query('select pg_advisory_xact_lock_shared(72005,0)');
    await client.query('select pg_advisory_xact_lock(hashtext($1))',[id]);
    const before=(await client.query('select * from candidates where id=$1 for update',[id])).rows[0];
    await lib.beginGuardedAuditOperationLocked(client,before,{writer:'projection',receiptRef:'projection:reg-unattributed',evidence:{}});
    await client.query("update candidates set headline='Synthetic unaccounted change' where id=$1",[id]);
    await assert.rejects(client.query('commit'), /person_profile_write_guard/);
    assert.equal((await read(id)).headline,before.headline);
    assert.equal(await testAllowed(client,id,lib),'allowed');
  } finally {await client.query('rollback');client.release();await setGuard(pool,false,'synthetic regression end');}
});

test('enabled guard covers bare creation and source/contact contract fields', async () => {
  const id=await fixture();
  await setGuard(pool,true,'synthetic contract regression');
  try {
    await assert.rejects(pool.query("insert into candidates(id,full_name,linkedin_username) values($1::uuid,'Synthetic unreceipted',$1::text)",[randomUUID()]), /person_profile_write_guard/);
    for(const assignment of ["contact='{\"email\":\"synthetic@example.test\"}'::jsonb", "source='legacy_import'", "linkedin_enrichment_date='2025-04-01'", "linkedin_url='https://www.linkedin.com/in/synthetic-other'"])
      await assert.rejects(pool.query(`update candidates set ${assignment} where id=$1`,[id]), /person_profile_write_guard/);
    await pool.query("update candidates set status='Engaged',notes='Synthetic workflow' where id=$1",[id]);
  } finally {await setGuard(pool,false,'synthetic contract end');}
});

test('a run mutex rejects concurrent resume and undo, then permits retry', async () => {
  const id=await fixture();let entered,release;
  const atPerson=new Promise(r=>entered=r), proceed=new Promise(r=>release=r);
  const running=publish('reg-concurrent',id,[],{async afterPerson(){entered();await proceed;}});
  await atPerson;
  try {
    assert.equal((await pool.query('select pg_try_advisory_xact_lock(72007,hashtext($1)) available',['reg-concurrent'])).rows[0].available,true,'run mutex must not take the live username lock');
    await assert.rejects(publish('reg-concurrent',id,['--resume']),/publish_run_active/);
    await assert.rejects(undo('reg-concurrent'),/publish_run_active/);
  } finally {release();await running;}
  assert.equal((await publish('reg-concurrent',id,['--resume'])).processed,1);
});

test('exact attribution for one update cannot cover a later unrecorded update', async () => {
  const id=await fixture(),client=await pool.connect();
  await setGuard(pool,true,'synthetic second-write regression');
  try {
    await client.query('begin; set local role service_role');
    await client.query('select pg_advisory_xact_lock_shared(72005,0)');
    await client.query('select pg_advisory_xact_lock(hashtext($1))',[id]);
    const before=(await client.query('select * from candidates where id=$1 for update',[id])).rows[0];
    const op=await lib.beginGuardedAuditOperationLocked(client,before,{writer:'projection',receiptRef:'projection:reg-second-write',evidence:{}});
    await lib.attributeAuditMutation(client,op,{scope:'profile',table:'candidates',rowId:id},()=>client.query("update candidates set headline='Synthetic attributed' where id=$1 returning id",[id]));
    await client.query("update candidates set headline='Synthetic unrecorded second' where id=$1",[id]);
    await assert.rejects(client.query('set constraints all immediate'),/person_profile_write_guard/);
    await client.query('rollback');
    assert.equal((await read(id)).headline,before.headline);
  } finally {await client.query('rollback');client.release();await setGuard(pool,false,'synthetic second-write end');}
});

test('guard permits real receipt-backed TT application and directory creation', async () => {
  const org=lib.TT_ORG_ID,app=randomUUID(),workspaceId=randomUUID(),username=`synthetic-${randomUUID()}`;
  await pool.query("insert into website_applications(id,organization_id,name,email,linkedin_username) values($1,$2,'Synthetic Guard','synthetic-guard@example.test',$3)",[app,org,username]);
  const client=await pool.connect();
  await setGuard(pool,true,'synthetic real creation');
  try {
    await client.query('set role service_role');
    const applied=await lib.saveApplicationPersonOnConnection(client,{organizationId:org,applicationId:app,linkedinUsername:username,name:'Synthetic Guard',parsed:{headline:'Synthetic parsed headline'},resumeText:null,harvest:null,mode:'live'});
    assert.equal(applied.created,true);
    const claim=await lib.claimDirectoryScanOnConnection(client,{organizationId:org,workspaceId});
    const staged=await lib.stageDirectoryOnConnection(client,{organizationId:org,workspaceId,token:claim.token,snapshot:{board:{contact_id:randomUUID(),name:'Synthetic Directory Guard',linkedin_url:`https://www.linkedin.com/in/synthetic-${randomUUID()}`,updated_at:'2026-09-26'},harvest:null,exps:[],edus:[],emails:[],phones:[],facts:[],identifiers:[]}});
    const saved=await lib.saveDirectoryOnConnection(client,{organizationId:org,receiptId:staged.receiptId,mode:'live'});
    assert.equal(saved.created,true);
    assert.equal((await pool.query("select count(*)::int n from person_audit_anchors where candidate_id=any($1::uuid[]) and kind='receipt_created'",[[applied.candidateId,saved.candidateId]])).rows[0].n,2);
  } finally {await client.query('rollback; reset role');client.release();await setGuard(pool,false,'synthetic real creation end');}
});

test('a missing requested ID fails closed before any requested profile is published', async () => {
  const id=await fixture(),missing='00000000-0000-4000-8000-000000000000';
  await assert.rejects(publish('reg-missing',`${missing},${id}`,['--batch-size=1']),/publish_target_missing/);
  assert.equal((await pool.query('select count(*)::int n from person_projection_history where candidate_id=$1',[id])).rows[0].n,0);
});

test('undo rollback/result are atomic and its durable totals survive retries', async () => {
  const id=await fixture();
  await publish('reg-undo-atomic',id);
  const before=await read(id);
  await pool.query(`create function public.synthetic_fail_undo_result() returns trigger language plpgsql as $$begin
    if new.status='undo_restored' then raise exception 'synthetic_undo_result_failure';end if;return new;end$$;
    create trigger synthetic_fail_undo_result before insert on person_publish_results for each row execute function synthetic_fail_undo_result()`);
  try {
    await assert.rejects(undo('reg-undo-atomic'),/synthetic_undo_result_failure/);
    assert.deepEqual(await read(id),before);
    assert.equal((await pool.query('select count(*)::int n from person_projection_history where candidate_id=$1 and restored_at is not null',[id])).rows[0].n,0);
  } finally {await pool.query('drop trigger synthetic_fail_undo_result on person_publish_results; drop function synthetic_fail_undo_result()');}
  const first=await undo('reg-undo-atomic'),second=await undo('reg-undo-atomic');
  assert.equal(first.restored,1);assert.equal(second.restored,1);assert.equal(second.processed,1);
});

test('undo refuses another publish run occupying its derived identifier', async () => {
  const id=await fixture(),another=await fixture();
  await publish('reg-undo-collision',id);
  await publish('reg-undo-collision-undo',another);
  const before=(await pool.query("select * from person_publish_runs where run_id='reg-undo-collision-undo'")).rows;
  await assert.rejects(undo('reg-undo-collision'),/publish_run_config_differs/);
  assert.deepEqual((await pool.query("select * from person_publish_runs where run_id='reg-undo-collision-undo'")).rows,before);
});

test('undo supports the maximum valid publish run identifier', async () => {
  const id=await fixture(),run='x'.repeat(100);
  await publish(run,id);
  assert.equal((await undo(run)).restored,1);
});

test('a competing legacy-email claim records the actual fallback projection', async () => {
  const id=await fixture(),other=await fixture(),email=`synthetic-race-${id}@example.test`;
  const c=await pool.connect();
  try {await lib.saveRecruiterContactOnConnection(c,{organizationId:lib.TT_ORG_ID,candidateId:id,actorId:randomUUID(),requestId:randomUUID(),contact:{email},mode:'shadow'});}
  finally {c.release();}
  let raced=false;
  const raceLib={...lib,publishPersonProjectionOnConnection(client,candidateId,args){
    return lib.publishPersonProjectionOnConnection({async query(sql,values){
      if(!raced&&sql.startsWith('update public.candidates set ')){
        raced=true;
        await pool.query('update candidates set email=$2 where id=$1',[other,email]);
      }
      return client.query(sql,values);
    }},candidateId,args);
  }};
  const result=await runPublish({pool,lib:raceLib,options:options('reg-email-race',id),onProgress:quiet});
  assert.equal(raced,true);
  assert.equal((await read(id)).email,null);
  assert.equal((await read(other)).email,email);
  assert.equal(result.email_collision,1);
  const stored=(await pool.query("select email_collision,changed_fields from person_publish_results where run_id='reg-email-race'")).rows[0];
  assert.equal(stored.email_collision,true);
  assert.equal(stored.changed_fields.includes('email'),false);
});

test('the deferred guard revalidates scope instead of trusting an inserted attribution', async () => {
  const id=await fixture(),client=await pool.connect();
  await setGuard(pool,true,'synthetic invalid proof');
  try {
    await client.query('begin; set local role service_role');
    await client.query('select pg_advisory_xact_lock_shared(72005,0)');
    await client.query('select pg_advisory_xact_lock(hashtext($1))',[id]);
    const before=(await client.query('select * from candidates where id=$1 for update',[id])).rows[0];
    const op=await lib.beginGuardedAuditOperationLocked(client,before,{writer:'projection',receiptRef:'projection:reg-wrong-proof',evidence:{}});
    await client.query("update candidates set headline='Synthetic invalid scope' where id=$1",[id]);
    await client.query(`insert into person_change_attributions(event_id,candidate_id,operation_id,scope,changed_fields,event_hash)
      select e.id,e.candidate_id,$2,'recruiter_contact',array['headline'],md5(jsonb_build_array(e.id,e.candidate_id,e.source_table,e.source_row_id,e.operation,e.transaction_id::text,e.previous_payload,e.payload)::text)
      from person_change_events e where e.candidate_id=$1 and e.source_table='candidates' and e.transaction_id=pg_current_xact_id()`,[id,op.id]);
    await assert.rejects(client.query('commit'),/person_profile_write_guard/);
    assert.equal((await read(id)).headline,before.headline);
  } finally {await client.query('rollback');client.release();await setGuard(pool,false,'synthetic invalid proof end');}
});
