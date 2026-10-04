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
});
test('the check refuses other majors and a drifted engines field',()=>{
 assert.equal(checkNode('v24.1.0').major,24);
 assert.throws(()=>checkNode('v20.19.2'),/node_runtime:unsupported:v20\.19\.2/);
 assert.throws(()=>checkNode('v22.12.0'),/node_runtime:unsupported/);
 assert.throws(()=>checkNode('v24.1.0',{engines:'20.x'}),/node_runtime:engines_mismatch/);
 assert.equal(process.version.split('.')[0],'v24','this suite itself runs on the supported major');
});
