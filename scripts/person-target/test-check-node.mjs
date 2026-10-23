// The declared runtime (package.json#engines, .nvmrc, the workflows' setup-node) and
// the check every harness runs through scripts/build-worker-lib.mjs agree on one
// Node major; an unsupported interpreter is refused before any suite runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {checkNode,SUPPORTED_MAJOR} from '../check-node.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
test('declared runtime is one major everywhere',()=>{
 assert.equal(SUPPORTED_MAJOR,24);
 assert.equal(JSON.parse(fs.readFileSync(`${root}package.json`,'utf8')).engines.node,'24.x');
 assert.equal(fs.readFileSync(`${root}.nvmrc`,'utf8').trim(),'24');
 assert.match(fs.readFileSync(`${root}.npmrc`,'utf8'),/engine-strict=true/);
 for(const f of fs.readdirSync(`${root}.github/workflows`).filter(f=>f.endsWith('.yml'))){
  const y=fs.readFileSync(`${root}.github/workflows/${f}`,'utf8');
  for(const m of y.matchAll(/node-version:\s*(\S+)/g))assert.equal(m[1],'24',f);
 }
 assert.match(fs.readFileSync(`${root}scripts/build-worker-lib.mjs`,'utf8'),/checkNode\(\)/);
 // operator entry points call the guard first; harness scripts before any fixture DDL
 for(const f of ['scripts/person-maintenance/run-catchup.mjs','scripts/person-maintenance/start-catchup.mjs','scripts/person-reconcile-finalize.mjs','scripts/person-publish.mjs','scripts/person-transition.mjs','scripts/person-audit-anchors.mjs','scripts/test-tenancy.mjs'])
  assert.match(fs.readFileSync(`${root}${f}`,'utf8'),/checkNode\(\)/,f);
 for(const f of ['scripts/person-target/run-offline-tests.sh','scripts/person-application-edits/run-local-tests.sh','scripts/person-release-upgrade/run-upgrade-tests.sh','scripts/person-transition-cli/run-local-tests.sh','scripts/tenancy/run-armed-local-tests.sh','scripts/person-publish/run-local-tests.sh','scripts/person-maintenance/run-local-tests.sh','scripts/person-audit/run-postcutover-audit-tests.sh','scripts/person-directory-outcomes/run-local-tests.sh','scripts/person-recruiter/run-local-tests.sh','scripts/person-recruiter-admission/run-local-tests.sh','scripts/person-audit/run-local-tests.sh','scripts/person-maintenance/run-catchup-local-tests.sh','scripts/person-internal-resume/run-offline-tests.sh']){
  const sh=fs.readFileSync(`${root}${f}`,'utf8').split('\n').filter(l=>!l.trim().startsWith('#')).join('\n');
  const guard=sh.indexOf('check-node.mjs'),ddl=sh.search(/\b(psql|q -d|create database|node --test)/);
  assert.ok(guard>0&&(ddl<0||guard<ddl),`${f}: the runtime guard precedes fixture DDL and tests`);
 }
});
test('the check refuses other majors and a drifted engines field',()=>{
 assert.equal(checkNode('v24.1.0').major,24);
 assert.throws(()=>checkNode('v20.19.2'),/^Error: node_runtime:unsupported:v20\.19\.2$/);
 assert.throws(()=>checkNode('v22.12.0'),/node_runtime:unsupported/);
 assert.throws(()=>checkNode('v24.1.0',{engines:'20.x'}),/node_runtime:engines_mismatch/);
 assert.equal(process.version.split('.')[0],'v24','this suite itself runs on the supported major');
});
