// Bounded orchestration for the opt-in normalized worker. Persistence and claims
// are in the shared server library; no paid call runs inside a DB transaction.
export async function runNormalizedRefresh({
  lib,
  rest,
  organizationId,
  mode,
  dailyCap,
  allowPaid,
  harvestProfile,
  noTopup,
  concurrency = 1,
  log = console.log,
  warn = console.error,
}) {
  if (organizationId !== lib.TT_ORG_ID || !["shadow", "live"].includes(mode))
    throw Error("person_refresh_scope");
  if (!Number.isInteger(dailyCap) || dailyCap < 0 || dailyCap > 10000)
    throw Error("person_refresh_cap");
  const scoped = `organization_id=eq.${organizationId}`;
  const limit = Math.min(500, Math.max(50, dailyCap));
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const retry = await lib.pickRefreshRows({
    organizationId,
    status: "patch_failed",
    limit: 50,
  });
  const queued = await lib.pickRefreshRows({
    organizationId,
    status: "queued",
    limit,
  });
  if (!noTopup && allowPaid && dailyCap > queued.length) {
    const needed = Math.min(500, dailyCap) - queued.length;
    const top = [];
    // The per-person history lookup is bounded, including large queue histories.
    for (let page = 0; page < 40 && top.length < needed; page++) {
      const rows = await rest(
        `candidates?source=in.(directory,airtable_sync)&linkedin_username=not.is.null&select=id&order=updated_at.desc,id.asc&limit=500&offset=${page * 500}`,
      );
      if (!rows.length) break;
      for (let i = 0; i < rows.length && top.length < needed; i += 100) {
        const ids = rows.slice(i, i + 100).map((c) => c.id);
        const prior = await rest(
          `refresh_queue?${scoped}&candidate_id=in.(${ids.join(",")})&select=candidate_id`,
        );
        const recent = await rest(
          `candidate_enrichments?${scoped}&candidate_id=in.(${ids.join(",")})&provider=eq.harvest&status=eq.ok&cache_status=eq.miss&created_at=gte.${since}&select=candidate_id`,
        );
        const skip = new Set([...prior, ...recent].map((r) => r.candidate_id));
        for (const candidate_id of ids)
          if (!skip.has(candidate_id) && top.length < needed)
            top.push({
              organization_id: organizationId,
              candidate_id,
              status: "queued",
              priority: 50,
              reason: "engaged_backfill",
            });
      }
    }
    if (top.length) {
      await rest("refresh_queue?on_conflict=candidate_id,status", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(top),
      });
      const newer = await lib.pickRefreshRows({
        organizationId,
        status: "queued",
        limit,
      });
      for (const row of newer)
        if (!queued.some((q) => q.id === row.id)) queued.push(row);
    }
  }
  const freePeople = new Set(retry.map((r) => r.candidate_id));
  const work = [
    ...retry,
    ...queued.filter((r) => !freePeople.has(r.candidate_id)).slice(0, limit),
  ];
  const stats = {
    refreshed: 0,
    failed: 0,
    skipped: 0,
    review: 0,
    budget: 0,
    derivativeFailed: 0,
  };
  log(
    JSON.stringify({
      phase: "normalized_refresh",
      mode,
      queued: work.length,
      dailyCap,
    }),
  );
  async function process(row) {
    let claim;
    const key = { organizationId, queueId: row.id };
    try {
      claim = await lib.claimRefresh({ ...key, dailyCap, allowPaid });
      if (claim.status !== "claimed") {
        if (claim.status === "review") stats.review++;
        else if (claim.status === "budget") stats.budget++;
        else stats.skipped++;
        return;
      }
      const owned = { ...key, token: claim.token };
      if (claim.needsHarvest) {
        const raw = await harvestProfile(claim.linkedinUrl);
        await lib.storeRefreshPayload({ ...owned, raw });
      }
      await lib.saveRefresh({ ...owned, mode });
      stats.refreshed++;
    } catch {
      stats.failed++;
      if (claim?.token)
        await lib
          .failRefresh({ ...key, token: claim.token })
          .catch(() => warn("person_refresh_failure_record_unavailable"));
      warn("person_refresh_retry_required");
      return;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(8, Math.max(1, concurrency)) }, async () => {
      while (work.length) await process(work.shift());
    }),
  );
  // Recover pending/expired canonical work even if this invocation had no
  // Harvest rows. The durable queue owns the per-person attempt/lease budget.
  if(mode === 'live'){
    try{const result=await lib.drainPersonDerivatives({organizationId,limit:50});stats.derivativeFailed+=result.retry}
    catch{stats.derivativeFailed++;warn('person_refresh_derivative_failed')}
  }
  log(JSON.stringify({ phase: "normalized_refresh_complete", ...stats }));
  return stats;
}
