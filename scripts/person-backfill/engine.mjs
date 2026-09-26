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
 const saved = await mapBounded(page, concurrency, id => hooks.save(id, prepared));
 const checked = await hooks.verify(page, prepared, saved);
 await mapBounded(page, concurrency, (id,index) => hooks.audit(id, prepared, saved[index], checked));
 return hooks.checkpoint(page);
}
