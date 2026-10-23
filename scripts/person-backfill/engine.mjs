// One limiter spans all REST reads/writes for a site, including response bodies.
export function createLimiter(limit) {
 let active=0;const waiting=[];
 return async fn=>{
  await new Promise(resolve=>{if(active<limit){active++;resolve();}else waiting.push(resolve);});
  try{return await fn();}finally{if(waiting.length)waiting.shift()();else active--;}
 };
}
const TRANSIENT=new Set(['40001','40P01','55P03','08000','08003','08006','57P01','HTTP_429','HTTP_502','HTTP_503','HTTP_504','ETIMEDOUT','ECONNRESET','ECONNREFUSED','EPIPE','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','TimeoutError']);
export function safeErrorCode(error) {
 const code=String(error?.code??'');
 return /^[A-Z0-9]{5}$/.test(code)||TRANSIENT.has(code)?code:'UNKNOWN';
}
// Use only around a read or an operation whose committed replay is a no-op.
export async function retryTransient(fn,{sleep=n=>new Promise(resolve=>setTimeout(resolve,n))}={}) {
 for(let attempt=0;;attempt++){
  try{return await fn();}
  catch(error){if(attempt>=2||!TRANSIENT.has(safeErrorCode(error)))throw error;await sleep(250*2**attempt);}
 }
}
// Every page completes all reads, saves and audits before its durable checkpoint.
// A crash at any boundary replays the same page through the idempotent writer.
export async function mapBounded(items, concurrency, fn) {
 const results = new Array(items.length);
 let next = 0;
 let failure;
 const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
  while (!failure) {
   const index = next++;
   if (index >= items.length) break;
   try { results[index] = await fn(items[index], index); }
   catch (error) { failure ??= error; }
  }
 });
 await Promise.all(workers);
 if (failure) throw failure;
 return results;
}
export async function executePage(page, hooks, concurrency = 1) {
 const input = await hooks.read(page);
 const prepared = await hooks.prepare(input, page);
 const saved = hooks.saveMany ? await hooks.saveMany(page,prepared) : await mapBounded(page, concurrency, id => hooks.save(id, prepared));
 const checked = await hooks.verify(page, prepared, saved);
 if(hooks.auditMany)await hooks.auditMany(page,prepared,saved,checked);
 else await mapBounded(page, concurrency, (id,index) => hooks.audit(id, prepared, saved[index], checked));
 return hooks.checkpoint(page);
}
