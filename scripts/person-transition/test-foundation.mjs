import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const url=process.env.LOCAL_DATABASE_URL;
if(!/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_transition_test$/.test(url||''))throw Error('local fixture database required');
const pool=new pg.Pool({connectionString:url,max:8});
const TT='801865a7-6533-41d2-9c45-e4a90e6ad51a',TENANT='cf000000-0000-4000-8000-000000000001';
const hash='a'.repeat(64);
const identity=(overrides={})=>({scope:'tt_person',org:TT,family:'application',resource:randomUUID(),hash,token:randomUUID(),lease:60,...overrides});
async function claim(w,c=pool){return (await c.query('select person_transition_claim($1,$2,$3,$4,$5,$6,$7) r',[w.scope,w.org,w.family,w.resource,w.hash,w.token,w.lease])).rows[0].r;}
async function state(c=pool){return (await c.query('select person_transition_status() r')).rows[0].r;}
async function action(name,c=pool,expected){const s=expected||await state();return (await c.query('select person_private.transition_set($1,$2,$3,$4) r',[name,s.revision,s.generation,'synthetic_test'])).rows[0].r;}
async function finish(w,id,outcome='completed',c=pool){return (await c.query('select person_transition_finish($1,$2,$3) r',[id,w.token,outcome])).rows[0].r;}
async function check(w,id,c=pool,header=false){
 const client=c===pool?await pool.connect():c;
 try{if(c===pool)await client.query('begin');
  if(header)await client.query("select set_config('request.headers',$1,true)",[JSON.stringify({'x-person-work-id':id,'x-person-work-token':w.token})]);
  else await client.query("select set_config('person.work_id',$1,true),set_config('person.work_token',$2,true)",[id,w.token]);
  const r=await client.query('select person_transition_assert($1,$2,$3,$4) r',[w.scope,w.org,w.family,w.resource]);
  if(c===pool)await client.query('commit');return r.rows[0].r;
 }catch(e){if(c===pool)await client.query('rollback');throw e;}finally{if(c===pool)client.release();}
}
test.after(()=>pool.end());
test('foundation exists before any runtime may be enabled',async()=>{
 assert.ok((await pool.query("select to_regprocedure('public.person_transition_claim(text,uuid,text,text,text,uuid,integer)') p")).rows[0].p,'durable transition admission is absent');
});
test.beforeEach(async t=>{
 if(t.name==='foundation exists before any runtime may be enabled')return;
 await pool.query('truncate person_private.transition_work,person_private.transition_events');
 await pool.query("update person_private.transition_control set enabled=false,phase='open',generation=1,revision=1");
});
test('disabled by default, anonymous legacy assertions preserve compatibility',async()=>{
 assert.deepEqual(await state(),{enabled:false,phase:'open',generation:1,revision:1,active:0,expired:0,uncertain:0});
 assert.equal((await pool.query('select person_transition_assert($1,$2,$3,$4) r',['tt_person',TT,'application',randomUUID()])).rows[0].r,'disabled');
});
test('claim survives a lost response, competing tokens cannot adopt it or change its input',async()=>{
 const w=identity(),a=await claim(w);assert.equal(a.status,'admitted');assert.equal((await claim(w)).work_id,a.work_id);
 assert.equal((await claim({...w,token:randomUUID()})).status,'busy');
 await assert.rejects(claim({...w,hash:'b'.repeat(64)}),/transition_input_changed/);
 const row=(await pool.query('select input_hash,token_hash from person_private.transition_work')).rows[0];
 assert.equal(row.input_hash,hash);assert.notEqual(row.token_hash,w.token);
});
test('concurrent claims admit exactly one owner',async()=>{
 const w=identity(),r=await Promise.all([claim(w),claim({...w,token:randomUUID()})]);assert.deepEqual(r.map(x=>x.status).sort(),['admitted','busy']);
});
test('armed assertions require exact organization, family, resource and token',async()=>{
 await action('arm');const w=identity(),a=await claim(w);
 assert.equal(await check(w,a.work_id),'admitted');assert.equal(await check(w,a.work_id,pool,true),'admitted');
 for(const bad of [{token:randomUUID()},{resource:randomUUID()},{family:'refresh'},{scope:'tenant_application',org:TENANT}])await assert.rejects(check({...w,...bad},a.work_id),/transition_admission/);
 await assert.rejects(pool.query('select person_transition_assert($1,$2,$3,$4)',['tt_person',TT,'application',w.resource]),/transition_admission/);
});
test('TT scope cannot be forged by a tenant or used for an unknown family',async()=>{
 for(const bad of [{org:TENANT},{scope:'tenant_application'},{scope:'tenant_application',org:TENANT,family:'refresh'},{family:'anything'},{resource:'person@example.test'},{lease:0},{lease:901},{hash:'not-a-hash'}])await assert.rejects(claim(identity(bad)),/transition_(scope|input)/);
});
test('draining rejects new work, lets admitted work finish and held rejects late writes',async()=>{
 await action('arm');const w=identity(),a=await claim(w);await action('drain');
 assert.equal((await claim(identity())).status,'draining');assert.equal(await check(w,a.work_id),'admitted');
 await assert.rejects(action('seal'),/transition_unresolved/);await finish(w,a.work_id);await action('seal');
 assert.equal((await claim(identity())).status,'held');await assert.rejects(check(w,a.work_id),/transition_held/);
 await action('reopen');assert.equal((await claim(w)).status,'completed');await assert.rejects(check(w,a.work_id),/transition_admission/);
});
test('expired leases are unresolved and cannot be renewed or finished automatically',async()=>{
 await action('arm');const w=identity(),a=await claim(w);
 await pool.query("update person_private.transition_work set lease_until=clock_timestamp()-interval '1s' where id=$1",[a.work_id]);
 assert.equal((await claim(w)).status,'unresolved');
 await assert.rejects(finish(w,a.work_id),/transition_expired/);
 await assert.rejects(pool.query('select person_transition_renew($1,$2,$3)',[a.work_id,w.token,60]),/transition_expired/);
 await action('drain');assert.equal((await state()).expired,1);await assert.rejects(action('seal'),/transition_unresolved/);
});
test('uncertain provider outcome remains unresolved even with the original owner',async()=>{
 await action('arm');const w=identity(),a=await claim(w);await finish(w,a.work_id,'uncertain');
 assert.equal((await claim(w)).status,'unresolved');await assert.rejects(finish(w,a.work_id),/transition_unresolved/);
 await action('drain');assert.equal((await state()).uncertain,1);await assert.rejects(action('seal'),/transition_unresolved/);
});
test('tenant application work continues while TT is held and does not block TT seal',async()=>{
 await action('arm');const w=identity({scope:'tenant_application',org:TENANT}),a=await claim(w);await action('drain');await action('seal');
 assert.equal(await check(w,a.work_id),'admitted');assert.equal((await claim(identity({scope:'tenant_application',org:TENANT}))).status,'admitted');await finish(w,a.work_id);
});
test('stale transition controls and unsafe transitions fail without state change',async()=>{
 const s=await state();await action('arm');await assert.rejects(action('drain',pool,s),/transition_stale/);
 await assert.rejects(action('disarm'),/transition_state/);await action('drain');await action('seal');await action('disarm');assert.equal((await state()).enabled,false);
 assert.equal((await pool.query('select count(*)::int n from person_private.transition_events')).rows[0].n,4);
});
test('enabling cannot silently invalidate work that began while controller was disabled',async()=>{
 const w=identity(),a=await claim(w);await assert.rejects(action('arm'),/transition_unresolved/);await finish(w,a.work_id);await action('arm');
});
test('renew requires ownership and can extend admitted work while draining',async()=>{
 await action('arm');const w=identity(),a=await claim(w);await action('drain');
 await assert.rejects(pool.query('select person_transition_renew($1,$2,$3)',[a.work_id,randomUUID(),60]),/transition_admission/);
 assert.equal((await pool.query('select person_transition_renew($1,$2,$3) r',[a.work_id,w.token,120])).rows[0].r.status,'admitted');
});
test('repeatable-read transaction begun before a drain cannot admit on stale open state',async()=>{
 await action('arm');const c=await pool.connect();try{
  await c.query('begin isolation level repeatable read');await c.query('select 1 from person_private.transition_control');await action('drain');
  await assert.rejects(claim(identity(),c),e=>e.code==='40001');
 }finally{await c.query('rollback');c.release();}
});
test('controller waits for admitted short transaction, never seals over an in-flight write',async()=>{
 await action('arm');const w=identity(),a=await claim(w),c=await pool.connect(),d=await pool.connect();
 try{await c.query('begin');await check(w,a.work_id,c);
  await d.query('begin');await d.query("set local lock_timeout='100ms'");const s=await state();
  await assert.rejects(action('drain',d,s),e=>e.code==='55P03');await d.query('rollback');
  await c.query('commit');await action('drain');
 }finally{await c.query('rollback');await d.query('rollback');c.release();d.release();}
});
test('completed work is idempotent and cannot mint another token or write',async()=>{
 await action('arm');const w=identity(),a=await claim(w);await finish(w,a.work_id);assert.equal((await finish(w,a.work_id)).status,'completed');assert.equal((await claim({...w,token:randomUUID()})).status,'completed');await assert.rejects(check(w,a.work_id),/transition_admission/);
});
test('service role cannot change controller or write ledger directly; public users cannot claim',async()=>{
 const c=await pool.connect();try{
  for(const role of ['anon','authenticated','service_role']){
   await c.query('begin');await c.query(`set local role ${role}`);
   await assert.rejects(c.query("update person_private.transition_control set enabled=true"),e=>e.code==='42501');await c.query('rollback');
  }
  for(const role of ['anon','authenticated']){await c.query('begin');await c.query(`set local role ${role}`);await assert.rejects(claim(identity(),c),e=>e.code==='42501');await c.query('rollback');}
  await c.query('begin');await c.query('set local role service_role');assert.equal((await claim(identity(),c)).status,'admitted');await c.query('rollback');
 }finally{await c.query('rollback');c.release();}
});
test('stale controller snapshot cannot miss a claim committed after its first read',async()=>{
 const c=await pool.connect();try{
  await c.query('begin isolation level repeatable read');const stale=await state(c);await claim(identity());
  await assert.rejects(action('arm',c,stale),/transition_isolation/);
 }finally{await c.query('rollback');c.release();}
 assert.equal((await state()).enabled,false);assert.equal((await state()).active,1);
});
test('synthetic row trigger refuses legacy and mismatched writes after arming',async()=>{
 const w=identity();
 await pool.query(`create table public.transition_fixture(resource_key text primary key,organization_id uuid not null,n integer not null);
 create function public.transition_fixture_fence() returns trigger language plpgsql as $$begin
 perform public.person_transition_assert('tt_person',new.organization_id,'application',new.resource_key);return new;end$$;
 create trigger fixture_fence before insert or update on public.transition_fixture for each row execute function public.transition_fixture_fence()`);
 const c=await pool.connect();try{
  await pool.query('insert into transition_fixture values($1,$2,1)',[w.resource,TT]);await action('arm');const a=await claim(w);
  await assert.rejects(pool.query('update transition_fixture set n=2'),/transition_admission/);
  await c.query('begin');await check(w,a.work_id,c);await c.query('update transition_fixture set n=2 where resource_key=$1',[w.resource]);await c.query('commit');
  await action('drain');await finish(w,a.work_id);await action('seal');await assert.rejects(pool.query('update transition_fixture set n=3'),/transition_held/);
  assert.equal((await pool.query('select n from transition_fixture')).rows[0].n,2);
 }finally{await c.query('rollback');c.release();await pool.query('drop table transition_fixture;drop function transition_fixture_fence()');}
});
