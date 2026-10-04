// Phase 5: the upgraded database (older bodies + forward migrations) and a clean
// install of the release chain must have identical definitions for every object the
// forward migrations touch. Read-only catalog comparison on two loopback databases.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
const urls=[process.env.LOCAL_DATABASE_URL,process.env.CLEAN_DATABASE_URL];
for(const u of urls)if(!/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_[a-z_]+_test$/.test(u||''))throw Error('local fixtures required');
const [upgraded,clean]=urls.map(u=>new pg.Pool({connectionString:u,max:1}));
test.after(async()=>{await upgraded.end();await clean.end();});
const one=async(pool,sql,args=[])=>(await pool.query(sql,args)).rows[0].v;
const both=(sql,args)=>Promise.all([one(upgraded,sql,args),one(clean,sql,args)]);

test('function definitions are identical',async()=>{
 for(const fn of ['public.person_network_send(jsonb,text)','person_private.postcutover_snapshot(uuid)','public.person_application_contact_fill(uuid,text,jsonb)','public.person_target_identity()','person_private.application_source_guard()',
  // 20261005090000: ranking, the patched certified writer and its helper
  'public.person_contact_ranks(uuid)','person_private.recruiter_normalize(uuid)','person_private.recruiter_write(uuid,text,jsonb,jsonb)','person_private.recruiter_primary_suppressed(uuid,text,jsonb,jsonb,jsonb)']){
  const [a,b]=await both('select pg_get_functiondef($1::regprocedure) v',[fn]);
  assert.equal(a,b,fn);
 }
 const [a,b]=await both("select coalesce(jsonb_agg(pg_get_function_identity_arguments(p.oid) order by 1),'[]') v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='person_network_send'");
 assert.deepEqual(a,b);assert.deepEqual(a,['p_row jsonb, p_mode text']);
});
test('witness table: columns, nullability and constraints are identical',async()=>{
 const cols="select jsonb_agg(jsonb_build_object('c',column_name,'t',data_type,'n',is_nullable) order by column_name) v from information_schema.columns where table_schema='person_private' and table_name='application_send_witnesses'";
 const [a,b]=await both(cols);assert.deepEqual(a,b);
 assert.ok(a.every(c=>!['inserted_row','event_id','event_hash'].includes(c.c)||c.n==='NO'),'no unresolved witness: proof columns NOT NULL on both');
 const cons="select jsonb_agg(jsonb_build_object('n',conname,'d',pg_get_constraintdef(oid)) order by conname) v from pg_constraint where conrelid='person_private.application_send_witnesses'::regclass";
 const [c,d]=await both(cons);assert.deepEqual(c,d);
 assert.ok(c.some(x=>x.n==='application_send_witnesses_proof_complete'));
 const trg="select jsonb_agg(tgname order by tgname) v from pg_trigger where tgrelid='person_private.application_send_witnesses'::regclass and not tgisinternal";
 const [e,f]=await both(trg);assert.deepEqual(e,f);
});
test('identity index and privileges are identical',async()=>{
 const idx="select jsonb_build_object('def',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'unique',i.indisunique) v from pg_index i where i.indexrelid=to_regclass('public.candidates_person_username_idx')";
 const [a,b]=await both(idx);assert.deepEqual(a,b);
 for(const fn of ['public.person_network_send(jsonb,text)','public.person_application_contact_fill(uuid,text,jsonb)','public.person_target_identity()']){
  const [c,d]=await both("select coalesce(to_jsonb(proacl::text[]),'null') v from pg_proc where oid=$1::regprocedure",[fn]);
  assert.deepEqual(c,d,fn);
  for(const role of ['anon','authenticated']){const [e,f]=await both("select has_function_privilege($1,$2::regprocedure,'execute') v",[role,fn]);assert.equal(e,false,`${role} ${fn}`);assert.equal(f,false);}
 }
});
test('recruiter decision table: the suppressed column and its constraint are identical',async()=>{
 const cols="select jsonb_agg(jsonb_build_object('c',column_name,'t',data_type,'n',is_nullable,'d',column_default) order by column_name) v from information_schema.columns where table_schema='public' and table_name='person_recruiter_primary'";
 const [a,b]=await both(cols);assert.deepEqual(a,b);
 assert.ok(a.some(c=>c.c==='suppressed'&&c.n==='NO'&&c.d==='false'));
 const cons="select jsonb_agg(jsonb_build_object('n',conname,'d',pg_get_constraintdef(oid)) order by conname) v from pg_constraint where conrelid='public.person_recruiter_primary'::regclass";
 const [c,d]=await both(cons);assert.deepEqual(c,d);
 assert.ok(c.some(x=>x.n==='person_recruiter_primary_suppressed_null'));
});
