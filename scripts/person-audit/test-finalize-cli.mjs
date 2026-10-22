// Offline: the finalize CLI's window mode. No database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SPEC,finalizePoolOverrides} from '../person-postcutover-finalize.mjs';
import {parseOptions} from '../person-publish/lib.mjs';
test('--window is a flag; the pool then carries a client-side query timeout at least the 240-minute window bound',()=>{
 const plain=parseOptions(['--run-id=release-audit-x'],SPEC), windowed=parseOptions(['--run-id=release-audit-x','--window'],SPEC);
 assert.equal(plain.window,false);assert.equal(windowed.window,true);
 assert.deepEqual(finalizePoolOverrides(plain),{});
 assert.ok(finalizePoolOverrides(windowed).query_timeout>=240*60*1000,'client timeout must outlast the window bound');
 assert.throws(()=>parseOptions(['--run-id=release-audit-x','--window=yes'],SPEC),/publish_option/);
});
