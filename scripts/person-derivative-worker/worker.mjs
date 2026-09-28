// Certified embedding worker (PERSON_TRANSITION_SUPPORT=on). Finishes retained work
// first, then claims pending jobs and pays only for missing chunks, within a daily
// cap counted from the database across runs. Stops at the first provider-wide
// failure so one outage cannot spend everyone's attempts. No legacy writes.
import { randomUUID } from 'node:crypto';

const PROVIDER_WIDE = new Set([401, 403, 429]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runCertifiedDerivatives({ lib, apiKey, dailyCap, limit = 200, embed = lib.embedPersonDerivativeChunks, log = console.log, warn = console.error, retryDelay = 500 }) {
  if (process.env.PERSON_TRANSITION_SUPPORT !== 'on') throw Error('derivative_worker_requires_support');
  if (!Number.isInteger(dailyCap) || dailyCap < 0 || dailyCap > 10000) throw Error('derivative_worker_cap');
  const org = lib.TT_ORG_ID;
  const stats = { resumed: 0, published: 0, paid_people: 0, paid_chunks: 0, failed: 0, unknown: 0, errors: 0, stopped: null, attempt_limited: 0 };
  const bump = (k) => { stats[k] = (stats[k] ?? 0) + 1; };
  const quietReason = (e) => String(e?.message ?? '').slice(0, 80);
  // 1. Retained work: publish a stored result (repeat-safe); recover anything whose lease has gone.
  for (const r of await lib.resumableCertifiedDerivatives(limit)) {
    const a = { organizationId: org, candidateId: r.candidateId, requestId: r.requestId, token: r.token };
    try {
      if (r.live && r.phase === 'stored') { const p = await lib.publishCertifiedDerivatives(a); bump(p.status === 'published' ? 'published' : `resumed_${p.status}`); }
      else if (!r.live) { const x = await lib.recoverCertifiedDerivatives(a); bump(`recovered_${x.status}`); }
      stats.resumed++;
    } catch (e) { stats.errors++; warn(JSON.stringify({ phase: 'derivative_resume_error', reason: quietReason(e) })); }
  }
  // 2. New claims: only while the controller admits them, within today's remaining cap.
  if (!(await lib.certifiedDerivativesAdmitting())) stats.stopped = 'controller_not_open';
  let remaining = Math.max(0, dailyCap - (await lib.paidCertifiedDerivativesToday()));
  if (!stats.stopped && remaining === 0) stats.stopped = 'daily_cap';
  if (!stats.stopped) for (const candidateId of await lib.pendingCertifiedDerivatives(limit)) {
    if (remaining <= 0) { stats.stopped = 'daily_cap'; break; }
    const a = { organizationId: org, candidateId, requestId: randomUUID(), token: randomUUID() };
    try {
      const claim = await lib.claimCertifiedDerivatives({ ...a, allowPaid: true });
      if (claim.status !== 'claimed') { bump(`claim_${claim.status}`); continue; }
      if (claim.missing.length) {
        const start = await lib.startCertifiedDerivativesProvider(a);
        if (start.status === 'reprepare') { await lib.recoverCertifiedDerivatives(a); bump('reprepared'); continue; }
        if (start.status !== 'start') { bump(`start_${start.status}`); continue; }
        remaining--; stats.paid_people++; stats.paid_chunks += start.missing.length;
        let vectors;
        try { vectors = await embed(start.missing, apiKey); }
        catch (e) {
          const message = e?.message ?? '', http = /^person_derivative_http_(\d{3})$/.exec(message);
          const status = http ? Number(http[1]) : message === 'person_derivative_input' ? 400 : null;
          if (status !== null && lib.DEFINITE_PROVIDER_FAILURES.has(status)) {
            await lib.failCertifiedDerivativesProvider({ ...a, httpStatus: status }); stats.failed++;
            if (PROVIDER_WIDE.has(status)) { stats.stopped = `provider_${status}`; break; }
            continue;
          }
          // 5xx, other statuses, transport or unreadable bodies may have been processed: unknown, never paid again.
          stats.unknown++; stats.stopped = `provider_unknown_${http ? http[1] : 'response'}`; break;
        }
        // Storing is idempotent: retry a lost connection so a paid result is not thrown away.
        let stored, lastError;
        for (let i = 0; i < 3 && !stored; i++) {
          try { stored = await lib.storeCertifiedDerivativeVectors({ ...a, vectors }); }
          catch (e) { lastError = e; if (/^derivative_/.test(e?.message ?? '')) break; await sleep(retryDelay * (i + 1)); }
        }
        if (!stored) throw lastError;
        if (stored.status !== 'stored') { bump(`store_${stored.status}`); continue; }
      }
      const p = await lib.publishCertifiedDerivatives(a);
      bump(p.status === 'published' ? 'published' : `publish_${p.status}`);
    } catch (e) { stats.errors++; warn(JSON.stringify({ phase: 'derivative_error', reason: quietReason(e) })); }
  }
  stats.attempt_limited = await lib.attemptLimitedCertifiedDerivatives();
  log(JSON.stringify({ phase: 'certified_derivatives', ...stats }));
  return stats;
}
