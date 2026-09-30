import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const pin='c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc';
test('a historical label cannot turn a different checkout into the pinned runtime or leak a URI',()=>{
 const r=spawnSync(process.execPath,['scripts/person-maintenance/start-catchup.mjs'],{cwd:root,encoding:'utf8',timeout:10000,
  env:{...process.env,PINNED_RUNNER_DIR:root,GITHUB_SHA:pin,LOCAL_DATABASE_URL:'',SUPABASE_URL:'http://local-only.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic',COMMS_DATABASE_URL:'synthetic-secret-sentinel',
   BACKFILL_CONFIG:JSON.stringify({reconcile:true,'run-id':'synthetic-helper','scope':'queue','limit':1,'batch-size':1,'dry-run':false,commit:pin})}});
 assert.equal(r.status,1); assert.equal(r.stdout,'');
 assert.doesNotMatch(r.stderr,/synthetic-secret-sentinel|TypeError|at file:/);
 assert.deepEqual(JSON.parse(r.stderr),{phase:'catchup_start_stopped',reason:'catchup_start:not_pinned'});
});
