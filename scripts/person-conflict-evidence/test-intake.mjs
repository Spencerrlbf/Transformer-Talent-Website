import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {pool,app,processApp,plan,lib} from '../person-application-enrichment/test-tt-enrichment.mjs';
test('normalization records legitimate shared-email evidence and unchanged replay does not duplicate it',async()=>{const one=await processApp(await app()),two=await processApp(await app());assert.equal(one.status,'processed',one.error?.message);assert.equal(two.status,'processed',two.error?.message);const row=(await pool.query("select * from identity_conflicts where kind='email_owned_by_other' and $1::uuid=any(candidate_ids) and incoming->>'incoming_candidate'=$1::text",[two.result.candidateId])).rows[0];assert.ok(row);assert.ok(row.candidate_ids.includes(one.result.candidateId));assert.ok(row.source_id);assert.equal((await plan(two.result.candidateId)).status,'verified');const before=(await pool.query('select count(*)::int n from identity_conflicts')).rows[0].n;const again=await processApp((await pool.query('select application_id from person_application_receipts where candidate_id=$1',[two.result.candidateId])).rows[0].application_id);assert.equal(again.status,'processed');assert.equal((await pool.query('select count(*)::int n from identity_conflicts')).rows[0].n,before);});
for(const change of ['insert','resolve','delete'])test(`a valid normalization frame cannot authorize raw conflict ${change}`,async()=>{const marker=randomUUID().replaceAll('-','');await pool.query('update person_private.transition_control set enabled=false where singleton');const row=(await pool.query("insert into identity_conflicts(kind,candidate_ids,incoming,evidence_hash) values('identity_taken',array[$1::uuid],'{}',$2) returning id",[randomUUID(),marker])).rows[0];await pool.query('update person_private.transition_control set enabled=true where singleton');const body=change==='insert'?`insert into public.identity_conflicts(kind,evidence_hash) values('identity_taken','${marker}x');`:change==='resolve'?`update public.identity_conflicts set status='resolved' where id='${row.id}';`:`delete from public.identity_conflicts where id='${row.id}';`;await pool.query(`create function person_private.synthetic_conflict_raw() returns trigger language plpgsql as $$begin ${body}return new;end$$;create trigger zz_synthetic_conflict_raw after insert on candidate_sources for each row execute function person_private.synthetic_conflict_raw()`);try{const out=await processApp(await app());assert.equal(out.status,'failed');assert.match(out.error?.message||'',/conflict_evidence_/);}finally{await pool.query('drop trigger zz_synthetic_conflict_raw on candidate_sources;drop function person_private.synthetic_conflict_raw()');}});
for(const altered of ['null','incoming'])test(`a ${altered} conflict insert cannot silently lose or change evidence`,async()=>{await pool.query(`create function person_private.synthetic_conflict_insert() returns trigger language plpgsql as $$begin ${altered==='null'?'return null;':"new.incoming:='{}';return new;"}end$$;create trigger zz_synthetic_conflict_insert before insert on identity_conflicts for each row execute function person_private.synthetic_conflict_insert()`);try{const out=await processApp(await app());assert.equal(out.status,'failed');assert.match(out.error?.message||'',/conflict_evidence_/);}finally{await pool.query('drop trigger zz_synthetic_conflict_insert on identity_conflicts;drop function person_private.synthetic_conflict_insert()');}});

const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const serialize=v=>JSON.stringify(stable(v));
function chooseEmail(v,email){const e=v[2],after=JSON.parse(e.after),semantic=JSON.parse(e.semanticAfter);after.email=email;semantic.email=email;e.after=serialize(after);e.semanticAfter=serialize(semantic);const evidence=JSON.parse(e.collision);evidence[1]=email;e.collision=serialize(evidence);}
// Local fixture owner only: create an exact synthetic competitor without opening
// a public candidate-write path. The racing fixture retains its uncommitted row.
async function seedCompetitor(c,id,username,email){
 const seed={id,full_name:'Synthetic',linkedin_username:username,email,status:'Active'};
 await c.query("select person_private.intake_frame_open($1,$2,$3,'seed',null,$4)",[randomUUID(),randomUUID(),id,seed]);
 await c.query("insert into candidates(id,full_name,linkedin_username,email) values($1,'Synthetic',$2,$3)",[id,username,email]);
 await c.query('select person_private.intake_frame_clear()');
}
for(const racing of [false,true])test(`${racing?'concurrent':'preexisting'} email collision selects fallback hash atomically`,async()=>{
 const email=`${randomUUID()}@example.test`,owner=randomUUID(),competitor=await pool.connect();let waiting,waitObserved=false;
 try{await competitor.query('begin');await seedCompetitor(competitor,owner,`collision-${owner}`,email);if(!racing)await competitor.query('commit');
 const id=await app();const r=await processApp(id,{queryHook:async(sql,v,c)=>{
  if(!sql.startsWith('select public.person_application_project('))return;chooseEmail(v,email);
  if(racing){const pid=(await c.query('select pg_backend_pid() pid')).rows[0].pid;
   waiting=(async()=>{for(let i=0;i<100;i++){const x=(await pool.query("select wait_event_type='Lock' waiting from pg_stat_activity where pid=$1",[pid])).rows[0];if(x?.waiting){waitObserved=true;break;}await new Promise(r=>setTimeout(r,5));}await competitor.query('commit');})();
  }
 }});if(waiting)await waiting;assert.equal(r.status,'processed',r.error?.message);if(racing)assert.ok(waitObserved,'real unique-index wait');
 const row=(await pool.query('select * from candidates where id=$1',[r.result.candidateId])).rows[0],state=(await pool.query('select * from person_projection_state where candidate_id=$1',[r.result.candidateId])).rows[0];assert.equal(row.email,null);assert.equal(state.profile_hash,lib.projectionProfileHash(row));assert.equal(state.semantic_hash,lib.semanticProfileHash(row));
 const history=(await pool.query('select * from person_projection_history where candidate_id=$1 order by id desc limit 1',[row.id])).rows[0];assert.equal(history.after_hash,state.profile_hash);assert.equal(history.semantic_after,state.semantic_hash);
 const conflict=(await pool.query("select * from identity_conflicts where kind='legacy_email_collision' and candidate_ids=array[$1::uuid]",[row.id])).rows[0];const {createHash}=await import('node:crypto');assert.equal(conflict.evidence_hash,createHash('sha256').update(JSON.stringify([row.id,email])).digest('hex'));
 }finally{await competitor.query('rollback');if(waiting)await waiting;competitor.release();}
});

// Owner-only local proof setup. Test the retained resolver bodies and helper
// contracts within the real intake transaction, rolling all probes back.
async function probe(c,fn){await c.query('savepoint conflict_probe');try{return await fn();}finally{await c.query('rollback to savepoint conflict_probe');await c.query('release savepoint conflict_probe');}}
async function normalizedProbe(fn){let checked=false;const out=await processApp(await app(),{queryHook:async(sql,v,c)=>{if(!sql.startsWith('select public.person_application_project('))return;checked=true;await probe(c,async()=>{const f=(await c.query("select b.*,d.doc,s.id source_id from person_private.application_candidates b join public.person_application_receipts r using(application_id) cross join lateral jsonb_array_elements(r.documents) d(doc) join public.candidate_sources s on s.candidate_id=b.candidate_id and s.payload_hash=d.doc->'source'->>'payload_hash' where b.transaction_id=pg_current_xact_id() limit 1")).rows[0];assert.ok(f);await c.query('insert into person_private.normalization_frames values(pg_backend_pid(),pg_current_xact_id(),$1,$2,$3,$4)',[f.work_id,f.application_id,f.candidate_id,f.doc]);await fn(c,f);});}});assert.ok(checked);assert.equal(out.status,'processed',out.error?.message);}
test('helper refuses unrelated sources and preserves exact global dedup and zero-row FOUND',()=>normalizedProbe(async(c,f)=>{
 const key=randomUUID().replaceAll('-',''),args=['company_identity',[f.candidate_id],{synthetic:true},key,f.source_id],sql='select * from person_private.conflict_insert($1,$2,$3,$4,$5)';
 await probe(c,()=>assert.rejects(c.query(sql,[...args.slice(0,4),randomUUID()]),/conflict_evidence_source/));
 await probe(c,()=>assert.rejects(c.query(sql,[args[0],[randomUUID()],...args.slice(2)]),/conflict_evidence_source/));
 const first=(await c.query(sql,args)).rows;assert.equal(first.length,1);assert.equal((await c.query(sql,args)).rowCount,0);
 // A projection frame alone must not admit normalization conflict kinds.
 await c.query('delete from person_private.normalization_frames where backend_pid=pg_backend_pid()');
 await c.query("insert into person_private.application_projection_frames(backend_pid,transaction_id,work_id,candidate_id,operation_id,before_profile,after_profile) values(pg_backend_pid(),pg_current_xact_id(),$1,$2,gen_random_uuid(),'{}','{}')",[f.work_id,randomUUID()]);
 await probe(c,()=>assert.rejects(c.query(sql,args),/conflict_evidence_projection/));
}));
for(const family of ['company','school'])test(`${family} resolver retains inserted versus dedup conflict counters across candidates`,()=>normalizedProbe(async(c,f)=>{
 const url='https://www.linkedin.com/'+(family==='company'?'company/':'school/')+randomUUID(),id=randomUUID().replaceAll('-','');
 // A mismatched existing identity makes the resolver record a conflict.
 if(family==='company')await c.query("insert into companies(name,linkedin_id,linkedin_url_normalized) values('Synthetic clash',$1,$2)",['old-'+id,url]);
 else await c.query("insert into schools(name,normalized_name,linkedin_org_id,linkedin_url_normalized,identity_basis) values('Synthetic clash',$1,$2,$3,'linkedin_org_id')",[id,'old-'+id,url]);
 const input={id,url,name:'Synthetic incoming',norm:'synthetic incoming'},sql=`select * from public.person_${family}($1,$2,$3)`;
 const one=(await c.query(sql,[input,f.candidate_id,f.source_id])).rows[0];assert.equal(one.conflicts,1);assert.equal(one.created,true);
 const first=(await c.query('select * from identity_conflicts where kind=$1 and source_id=$2',[family+'_identity',f.source_id])).rows[0];assert.ok(first);
 // Remove only this synthetic resolver row, retaining the conflict. A repeat
 // therefore reaches INSERT again and must return conflicts=0, not FOUND=true.
 await c.query(`delete from ${family==='company'?'companies':'schools'} where id=$1`,[one[family+'_id']]);
 const other=(await c.query("select b.*,d.doc,s.id source_id from person_private.application_candidates b join public.person_application_receipts r using(application_id) cross join lateral jsonb_array_elements(r.documents) d(doc) join public.candidate_sources s on s.candidate_id=b.candidate_id and s.payload_hash=d.doc->'source'->>'payload_hash' where b.candidate_id<>$1 limit 1",[f.candidate_id])).rows[0];assert.ok(other);
 await c.query('update person_private.normalization_frames set candidate_id=$1,application_id=$2,work_id=$3,document=$4 where backend_pid=pg_backend_pid()',[other.candidate_id,other.application_id,other.work_id,other.doc]);
 const two=(await c.query(sql,[input,other.candidate_id,other.source_id])).rows[0];assert.equal(two.created,true);assert.equal(two.conflicts,0);
 assert.deepEqual((await c.query('select * from identity_conflicts where id=$1',[first.id])).rows[0],first);
}));
for(const phase of ['before','after'])test(`late ${phase} conflict trigger cannot clear required context`,async()=>{
 await pool.query(`create function person_private.synthetic_conflict_context() returns trigger language plpgsql as $$begin perform set_config('person.work_id','',true);perform set_config('person.work_token','',true);perform set_config('request.headers','{}',true);return new;end$$;create trigger zz_synthetic_conflict_context ${phase} insert on identity_conflicts for each row execute function person_private.synthetic_conflict_context()`);
 try{const id=await app(),out=await processApp(id);assert.equal(out.status,'failed');assert.match(out.error?.message||'',/transition_admission/);assert.equal((await pool.query('select count(*)::int n from person_application_receipts where application_id=$1',[id])).rows[0].n,0);}finally{await pool.query('drop trigger zz_synthetic_conflict_context on identity_conflicts;drop function person_private.synthetic_conflict_context()');}
});
test('private frame cleanup leaves no reusable authority',async()=>{assert.equal((await pool.query('select count(*)::int n from person_private.conflict_frames')).rows[0].n,0);await assert.rejects(pool.query("select * from person_private.conflict_insert('company_identity',array[$1::uuid],'{}',$2,null)",[randomUUID(),randomUUID()]),/conflict_evidence_context/);});
for(const phase of ['before','after'])test(`conflict evidence rolls back when a late ${phase} trigger expires work`,async()=>{
 await pool.query(`create function person_private.synthetic_conflict_expire() returns trigger language plpgsql as $$begin update person_private.transition_work set lease_until=clock_timestamp()-interval '1 second' where id=(select work_id from person_private.conflict_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id());return new;end$$;create trigger zz_synthetic_conflict_expire ${phase} insert on identity_conflicts for each row execute function person_private.synthetic_conflict_expire()`);
 try{const id=await app(),out=await processApp(id);assert.equal(out.status,'failed');assert.match(out.error?.message||'',/transition_expired/);assert.equal((await pool.query('select count(*)::int n from person_application_receipts where application_id=$1',[id])).rows[0].n,0);}finally{await pool.query('drop trigger zz_synthetic_conflict_expire on identity_conflicts;drop function person_private.synthetic_conflict_expire()');}
});
for(const change of ['suppress','alter'])test(`private conflict ${change} cannot authorize changed public evidence`,async()=>{
 await pool.query(`create function person_private.synthetic_conflict_frame() returns trigger language plpgsql as $$begin ${change==='suppress'?'return null;':"new.expected_row:=jsonb_set(new.expected_row,'{incoming}','{}');return new;"}end$$;create trigger synthetic_conflict_frame before insert on person_private.conflict_frames for each row execute function person_private.synthetic_conflict_frame()`);
 try{const out=await processApp(await app());assert.equal(out.status,'failed');assert.match(out.error?.message||'',/conflict_evidence_frame/);}finally{await pool.query('drop trigger synthetic_conflict_frame on person_private.conflict_frames;drop function person_private.synthetic_conflict_frame()');}
});
