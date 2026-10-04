// R2-04, sealed: the documented deny list must stop the requests the REAL provider
// clients build. The underlying transport is a recorder; synthetic credentials make
// each client take its live path; the documented OUTBOUND_DENY_HOSTS value is
// installed; every provider call must be refused by the guard with the recorder
// untouched, and an explicitly allowed control request must still reach it.
// Code-level evidence only: the deployed variable is not read here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const reached=[];
globalThis.fetch=async(input,init={})=>{reached.push(`${init.method??'GET'} ${new URL(typeof input==='string'?input:input.url).hostname}`);return new Response('{}',{status:200,headers:{'content-type':'application/json'}});};
const lib=await import('./dist/server.mjs');

// The documented value (scripts/person-target/README.md, scripts/tenancy/DISPOSABLE.md).
const readme=fs.readFileSync(`${root}scripts/person-target/README.md`,'utf8');
const documented=/OUTBOUND_DENY_HOSTS=([a-z0-9.,-]+)/.exec(readme)?.[1];
assert.ok(documented,'README documents the deny list');
Object.assign(process.env,{HARVEST_API_KEY:'synthetic-harvest',SOURCING_PROVIDER_MODE:'live',RESEND_API_KEY:'synthetic-resend',NYLAS_API_KEY:'synthetic-nylas',NYLAS_CLIENT_ID:'synthetic-client',AIRTABLE_API_TOKEN:'synthetic-airtable',AIRTABLE_BASE_ID:'appSynthetic'});

test('control: with the guard uninstalled every real client reaches the transport (the test can see the calls)',async()=>{
 assert.deepEqual(lib.installOutboundGuard({}),[]);
 await lib.harvestProfile('https://www.linkedin.com/in/synthetic');
 await lib.getFullProfile('https://www.linkedin.com/in/synthetic');
 await lib.searchCompanies('synthetic');
 await lib.sendEmail({to:'synthetic@example.test',subject:'synthetic',html:'<p>synthetic</p>'});
 await lib.deleteGrant('synthetic-grant');
 await lib.sendAsGrant({grantId:'synthetic-grant',to:{email:'synthetic@example.test'},subject:'s',html:'<p>s</p>'});
 await lib.mirrorToAirtable({name:'Synthetic',email:'synthetic@example.test',linkedinUrl:null,currentTitle:null,currentCompany:null,roleTitles:[]});
 assert.deepEqual([...new Set(reached.map(r=>r.split(' ')[1]))].sort(),['api.airtable.com','api.harvestapi.io','api.resend.com','api.us.nylas.com']);
 assert.ok(reached.includes('GET api.harvestapi.io'),'the real Harvest endpoint is api.harvestapi.io');
 assert.ok(!reached.some(r=>r.includes('harvest-api.com')),'nothing calls the hostname the old documentation named');
});
test('with the documented deny list installed no real provider request reaches the transport; each is counted',async()=>{
 const hosts=lib.installOutboundGuard({OUTBOUND_DENY_HOSTS:documented});
 reached.length=0;
 // Clients that swallow transport errors return their failure value; clients that
 // surface them reject with the guard's code. Either way nothing left the process.
 assert.equal(await lib.harvestProfile('https://www.linkedin.com/in/synthetic'),null);
 assert.deepEqual(reached,[],`the real Harvest request must not reach the transport under the documented list (${documented})`);
 assert.ok(hosts.includes('api.harvestapi.io'));
 await assert.rejects(lib.getFullProfile('https://www.linkedin.com/in/synthetic'),e=>lib.isOutboundDenied(e)&&e.message==='outbound_denied:api.harvestapi.io');
 await assert.rejects(lib.searchCompanies('synthetic'),/outbound_denied:api.harvestapi.io/);
 const errors=[];const original=console.error;console.error=(...a)=>errors.push(a.map(String).join(' '));
 try{
  assert.equal(await lib.sendEmail({to:'synthetic@example.test',subject:'synthetic',html:'<p>synthetic</p>'}),false);
  await lib.deleteGrant('synthetic-grant');
  await assert.rejects(lib.sendAsGrant({grantId:'synthetic-grant',to:{email:'synthetic@example.test'},subject:'s',html:'<p>s</p>'}),/outbound_denied:api.us.nylas.com/);
  await lib.mirrorToAirtable({name:'Synthetic',email:'synthetic@example.test',linkedinUrl:null,currentTitle:null,currentCompany:null,roleTitles:[]});
 }finally{console.error=original;}
 assert.deepEqual(reached,[],'no provider request reached the transport');
 assert.deepEqual(lib.deniedRequests(),{'api.harvestapi.io':3,'api.resend.com':1,'api.us.nylas.com':2,'api.airtable.com':1});
 assert.ok(errors.every(e=>!/synthetic-(harvest|resend|nylas|airtable)/.test(e)),'logged failures carry no credential');
 // An explicitly allowed synthetic control still passes.
 await fetch('https://control.example.test/ok');
 assert.deepEqual(reached,['GET control.example.test']);
});
test('the worker scripts build the same Harvest URL the guard denies (source-derived, not a fixture)',async()=>{
 const src=fs.readFileSync(`${root}scripts/refresh-worker.mjs`,'utf8');
 const urls=[...src.matchAll(/https:\/\/api\.[a-z.-]+\/linkedin\/profile/g)].map(m=>m[0]);
 assert.ok(urls.length>=2,'the refresh worker calls Harvest');
 for(const u of urls)assert.match(u,/^https:\/\/api\.harvestapi\.io\//);
 lib.installOutboundGuard({OUTBOUND_DENY_HOSTS:documented});
 reached.length=0;
 for(const u of urls)await assert.rejects(fetch(`${u}?url=x`,{headers:{'X-API-Key':'synthetic'}}),/outbound_denied:api.harvestapi.io/);
 assert.deepEqual(reached,[]);
});
