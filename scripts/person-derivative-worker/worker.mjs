// Certified embedding worker (PERSON_TRANSITION_SUPPORT=on). Finishes retained work
// first, then claims pending jobs, pays only for missing chunks under a per-run cap,
// stores the vectors and publishes them. No legacy derivative writes.
import { randomUUID } from 'node:crypto';

export async function runCertifiedDerivatives({ lib, apiKey, maxPaid, limit = 200, embed = lib.embedPersonDerivativeChunks, log = console.log, warn = console.error }) {
  if (process.env.PERSON_TRANSITION_SUPPORT !== 'on') throw Error('derivative_worker_requires_support');
  if (!Number.isInteger(maxPaid) || maxPaid < 0 || maxPaid > 10000) throw Error('derivative_worker_cap');
  const org = lib.TT_ORG_ID, stats = { resumed: 0, published: 0, paid_people: 0, paid_chunks: 0, failed: 0, unknown: 0, skipped: 0, errors: 0 };
  const bump = (k) => { stats[k] = (stats[k] ?? 0) + 1; };
  // 1. Retained work: publish a stored result; recover anything else (its lease is gone or it never paid).
  for (const r of await lib.resumableCertifiedDerivatives(limit)) {
    const a = { organizationId: org, candidateId: r.candidateId, requestId: r.requestId, token: r.token };
    try {
      if (r.live && (r.phase === 'stored')) { const p = await lib.publishCertifiedDerivatives(a); bump(p.status === 'published' ? 'published' : `resumed_${p.status}`); }
      else if (!r.live) { const x = await lib.recoverCertifiedDerivatives(a); bump(`recovered_${x.status}`); }
      stats.resumed++;
    } catch (e) { stats.errors++; warn(JSON.stringify({ phase: 'derivative_resume_error', reason: String(e.message).slice(0, 80) })); }
  }
  // 2. New claims, within the paid cap.
  for (const candidateId of await lib.pendingCertifiedDerivatives(limit)) {
    if (stats.paid_people >= maxPaid) break;
    const a = { organizationId: org, candidateId, requestId: randomUUID(), token: randomUUID() };
    try {
      const claim = await lib.claimCertifiedDerivatives({ ...a, allowPaid: true });
      if (claim.status !== 'claimed') { bump(`claim_${claim.status}`); continue; }
      if (claim.missing.length) {
        const start = await lib.startCertifiedDerivativesProvider(a);
        if (start.status === 'reprepare') { await lib.recoverCertifiedDerivatives(a); stats.skipped++; continue; }
        if (start.status !== 'start') { bump(`start_${start.status}`); continue; }
        stats.paid_people++; stats.paid_chunks += start.missing.length;
        let vectors;
        try { vectors = await embed(start.missing, apiKey); }
        catch (e) {
          const http = /^person_derivative_http_(\d{3})$/.exec(e.message ?? '');
          // An HTTP error response is definite (no result); a lost response stays unknown for review.
          if (http) { await lib.failCertifiedDerivativesProvider({ ...a, httpStatus: Number(http[1]) }); stats.failed++; }
          else stats.unknown++;
          continue;
        }
        const stored = await lib.storeCertifiedDerivativeVectors({ ...a, vectors });
        if (stored.status !== 'stored') { bump(`store_${stored.status}`); continue; }
      }
      const p = await lib.publishCertifiedDerivatives(a);
      bump(p.status === 'published' ? 'published' : `publish_${p.status}`);
    } catch (e) { stats.errors++; warn(JSON.stringify({ phase: 'derivative_error', reason: String(e.message).slice(0, 80) })); }
  }
  log(JSON.stringify({ phase: 'certified_derivatives', ...stats }));
  return stats;
}
