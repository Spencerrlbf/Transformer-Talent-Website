import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executePage } from './engine.mjs';
function fixture(failAt) {
 const state={saved:new Set(),audited:new Set(),checkpoint:[],reads:0};
 const hooks={
  async read(page){state.reads++; if(failAt==='read') throw Error('read failed'); return page;},
  async prepare(page){return page;},
  async save(id){state.saved.add(id);if(failAt==='after_save')throw Error('interrupted after commit');return id;},
  async verify(page){if(failAt==='audit')throw Error('audit failed');return page;},
  async audit(id){state.audited.add(id);},
  async checkpoint(ids){state.checkpoint=[...ids];}
 };
 return {state,hooks};
}
test('a source retrieval failure never saves or advances progress',async()=>{
 const f=fixture('read');await assert.rejects(executePage(['a','b'],f.hooks));
 assert.equal(f.state.saved.size,0);assert.deepEqual(f.state.checkpoint,[]);
});
test('interruption after commit resumes every person before checkpointing',async()=>{
 const f=fixture('after_save');await assert.rejects(executePage(['a','b'],f.hooks));
 assert.deepEqual(f.state.checkpoint,[]);
 f.hooks.save=async id=>{f.state.saved.add(id);return id;};
 await executePage(['a','b'],f.hooks);
 assert.deepEqual([...f.state.saved].sort(),['a','b']);assert.deepEqual([...f.state.audited],['a','b']);assert.deepEqual(f.state.checkpoint,['a','b']);
});
test('failed integrity validation never acknowledges a page',async()=>{
 const f=fixture('audit');await assert.rejects(executePage(['a','b'],f.hooks));
 assert.equal(f.state.audited.size,0);assert.deepEqual(f.state.checkpoint,[]);
});
test('bulk save and audit retain the same all-verified-before-checkpoint boundary',async()=>{
 const f=fixture();let saves=0,audits=0;
 f.hooks.saveMany=async ids=>{saves++;ids.forEach(id=>f.state.saved.add(id));return ids;};
 f.hooks.auditMany=async ids=>{audits++;ids.forEach(id=>f.state.audited.add(id));};
 await executePage(['a','b'],f.hooks,4);
 assert.equal(saves,1);assert.equal(audits,1);assert.deepEqual(f.state.checkpoint,['a','b']);
});
