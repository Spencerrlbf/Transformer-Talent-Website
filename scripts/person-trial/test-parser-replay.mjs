import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as trial from '../person-trial.mjs';
const old={source:'directory',source_ref:'input-1',fetched_at:'2026-01-01T00:00:00Z',payload_hash:'old',parser_version:'person-v2'};
const doc={source:{...old,payload_hash:'new',parser_version:'person-v3'}};
test('explicit replay permits only the reviewed v2 to v3 correction of the same snapshot',()=>{
 assert.equal(trial.allowedParserReplay(old,doc,true),true);
 assert.equal(trial.allowedParserReplay(old,doc,false),false);
 assert.equal(trial.allowedParserReplay({...old,parser_version:'person-v3'},doc,true),false);
 assert.equal(trial.allowedParserReplay({...old,source_ref:'other-input'},doc,true),false);
 assert.equal(trial.allowedParserReplay({...old,fetched_at:'2026-02-01T00:00:00Z'},doc,true),false);
});
