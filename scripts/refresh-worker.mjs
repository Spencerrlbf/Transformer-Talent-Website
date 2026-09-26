#!/usr/bin/env node
// Nightly Harvest refresh worker. Drains refresh_queue (priority asc — 10 =
// matched in a JD search, 50 = engaged backfill) up to REFRESH_DAILY_CAP paid
// Harvest calls per UTC day, counted from the candidate_enrichments ledger so
// website applications share the same budget. Tops the queue up with engaged
// candidates when it has spare capacity.
//
// All shared logic (facts, spine writes) comes from
// the compiled website library — run `node scripts/build-worker-lib.mjs`
// first (the GitHub Action does). This file is orchestration only.
//
// Modes:
//   node scripts/refresh-worker.mjs                      nightly drain
//   PRECOMPUTE_BACKFILL=N node scripts/refresh-worker.mjs  re-screen stored
//     payloads against roles with no Harvest spend.
//   NO_TOPUP=1            drain only what is queued (a one-off batch)
//   CONCURRENCY=4         profiles in flight (default 1, the nightly pace)
//
// A refresh rewrites the person's whole record from the profile (jobs,
// education, summary, skills, years), so the judge, the signals and the
// Profile tab read the fresh history; before 2026-09-25 it wrote only the
// headline, title, company, location and skills.
import fs from "node:fs";

try {
  const envFile = fs.readFileSync(new URL("../.env.scripts", import.meta.url), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const workerLib = await import("./dist/worker-lib.mjs");
const {
  computeFacts,
  formatFacts,
  harvestToPoolRecord,
  linkedinProfileText,
  poolSignals,
  recordEnrichment,
  syncExperiences,
  syncCandidateEmbeddings,
} = workerLib;
const PERSON_MODE = workerLib.personWriteMode();

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HARVEST = process.env.HARVEST_API_KEY;
const CAP = Math.max(0, parseInt(process.env.REFRESH_DAILY_CAP || "50", 10) || 0);
const CONCURRENCY = Math.min(8, Math.max(1, parseInt(process.env.CONCURRENCY || "1", 10) || 1));
if (!SUPABASE_URL || !KEY) throw new Error("Supabase creds required");
if (!HARVEST && PERSON_MODE === "legacy" && !process.env.PRECOMPUTE_BACKFILL) throw new Error("HARVEST_API_KEY required");

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { signal: AbortSignal.timeout(60_000), ...init, headers: { ...headers, ...init.headers } });
  if (!res.ok) {
    // Database errors may quote a person's full record. Log only status/code.
    const error = await res.json().catch(() => ({}));
    const code = typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? ` (${error.code})` : "";
    throw new Error(`${init.method || "GET"} ${path.split("?")[0]} ${res.status}${code}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const [org] = await rest("organizations?slug=eq.transformer-talent&select=id");
if (!org) throw new Error("organization not found");

if (PERSON_MODE !== "legacy") {
  const { runNormalizedRefresh } = await import("./person-refresh/worker.mjs");
  const stats = await runNormalizedRefresh({
    lib: workerLib, rest, organizationId: org.id, mode: PERSON_MODE,
    dailyCap: CAP, allowPaid: !!HARVEST && !process.env.PRECOMPUTE_BACKFILL,
    noTopup: !!process.env.NO_TOPUP || !!process.env.PRECOMPUTE_BACKFILL,
    concurrency: CONCURRENCY,
    harvestProfile: async (url) => {
      const res = await fetch(`https://api.harvestapi.io/linkedin/profile?url=${encodeURIComponent(url)}`, {
        headers: { "X-API-Key": HARVEST }, signal: AbortSignal.timeout(25000),
      });
      // The durable reservation fences an uncertain response. A later worker
      // must not repeat a potentially paid call without a recorded payload.
      if (!res.ok) throw Error(`harvest_${res.status}`);
      return (await res.json()).element;
    },
  });
  if (stats.failed || stats.review) process.exitCode = 1;
} else {
// Budget: paid Harvest calls already made today (site + worker share the cap).
const todayStart = new Date().toISOString().slice(0, 10) + "T00:00:00Z";
const spentRes = await fetch(
  `${SUPABASE_URL}/rest/v1/candidate_enrichments?provider=eq.harvest&cache_status=eq.miss&created_at=gte.${todayStart}&select=id`,
  { headers: { ...headers, Prefer: "count=exact", Range: "0-0" } }
);
const spent = parseInt((spentRes.headers.get("content-range") || "/0").split("/")[1], 10) || 0;
const remaining = Math.max(0, CAP - spent);
console.log(`cap ${CAP}, spent today ${spent}, remaining ${remaining}`);
// A paid-budget stop must not stop the free recovery of a saved payload.
const retrySince = new Date(Date.now() - 30 * 86400_000).toISOString();
const patchRetries = await rest(
  `refresh_queue?status=eq.patch_failed&or=(reason.is.null,reason.neq.patch_retry)&processed_at=gte.${retrySince}&select=id,candidate_id,linkedin_url,linkedin_username,priority,reason&order=processed_at.asc&limit=50`
);
const retryIds = new Set(patchRetries.map((r) => r.candidate_id));

// ---- Verdict precompute: retrieval is worker-specific, everything after ----
// ---- (facts, evidence, LLM, cache) is the shared library.               ----

// Verdicts are no longer computed here: the nightly shortlist judge
// (scripts/judge-shortlists.mjs) reads every open role's shortlist against
// its scorecard, and the report card fills in quotes and review on open.

// ---- Nightly drain ----

const queued = remaining ? await rest(
  `refresh_queue?status=eq.queued&select=id,candidate_id,linkedin_url,linkedin_username,priority&order=priority.asc,queued_at.asc&limit=${remaining}`
) : [];
if (queued.length < remaining && !process.env.NO_TOPUP) {
  const needed = remaining - queued.length;
  const everQueued = new Set((await rest("refresh_queue?select=candidate_id")).map((r) => r.candidate_id));
  // Queue slots go to people who actually need refreshing — recently
  // enriched candidates (e.g. fresh website applicants) are excluded.
  const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
  // Page through the engaged pool, most recently updated first, until enough
  // people who were never queued and were not refreshed in the last 30 days
  // are found. The first version looked only at the first 150 rows; those
  // were all queued within three nights, and the queue then starved for a
  // week ("processing 0 of 0 queued").
  const PAGE = 500;
  const MAX_PAGES = 40;
  const topUp = [];
  for (let page = 0; page < MAX_PAGES && topUp.length < needed; page++) {
    const batch = await rest(
      `candidates?source=in.(directory,airtable_sync)&linkedin_username=not.is.null&select=id,linkedin_url,linkedin_username&order=updated_at.desc,id.asc&limit=${PAGE}&offset=${page * PAGE}`
    );
    if (!batch.length) break;
    const fresh = batch.filter((c) => !everQueued.has(c.id));
    if (!fresh.length) continue;
    const recentIds = new Set();
    for (let i = 0; i < fresh.length; i += 100) {
      const chunk = fresh.slice(i, i + 100).map((c) => c.id);
      for (const r of await rest(
        `candidate_enrichments?candidate_id=in.(${chunk.join(",")})&provider=eq.harvest&status=eq.ok&created_at=gte.${since30}&select=candidate_id`
      ))
        recentIds.add(r.candidate_id);
    }
    for (const c of fresh) if (!recentIds.has(c.id) && topUp.length < needed) topUp.push(c);
  }
  console.log(`engaged backfill: ${topUp.length} to queue (needed ${needed})`);
  if (topUp.length) {
    await rest("refresh_queue?on_conflict=candidate_id,status", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(
        topUp.map((c) => ({
          organization_id: org.id,
          candidate_id: c.id,
          linkedin_url: c.linkedin_url,
          linkedin_username: c.linkedin_username,
          priority: 50,
          reason: "engaged_backfill",
          status: "queued",
        }))
      ),
    });
    console.log(`topped up queue with ${topUp.length} engaged candidates`);
    queued.push(
      ...(
        await rest(
          `refresh_queue?status=eq.queued&select=id,candidate_id,linkedin_url,linkedin_username,priority&order=priority.asc,queued_at.asc&limit=${remaining}`
        )
      ).filter((q) => !queued.some((x) => x.id === q.id))
    );
  }
}
console.log(`processing ${Math.min(queued.length, remaining)} of ${queued.length} queued; ${patchRetries.length} free save retries`);

async function finishQueueRow(row, status) {
  // unique(candidate_id, status): clear any previous terminal row first.
  await rest(`refresh_queue?candidate_id=eq.${row.candidate_id}&status=eq.${status}&id=neq.${row.id}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  }).catch(() => {});
  await rest(`refresh_queue?id=eq.${row.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status, processed_at: new Date().toISOString() }),
  });
}

// Harvest answers a burst with 429 and has the odd 5xx: wait and ask again
// (at most three tries) rather than failing the person for the night.
async function harvestProfile(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.harvestapi.io/linkedin/profile?url=${encodeURIComponent(url)}`, {
      headers: { "X-API-Key": HARVEST },
      signal: AbortSignal.timeout(25000),
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, attempt * 10_000));
      continue;
    }
    throw new Error(`harvest ${res.status}`);
  }
}

let refreshed = 0, failed = 0, skipped = 0, reused = 0, patchFailed = 0;
const work = [...patchRetries.map((r) => ({ ...r, patchRetry: true })),
  ...queued.filter((r) => !retryIds.has(r.candidate_id)).slice(0, remaining)];
async function refreshOne(row) {
  let ledgerWritten = false;
  let savingProfile = !!row.patchRetry;
  try {
    if (row.patchRetry) {
      // Claim this one free retry before doing work, including when two runs overlap.
      // Keep patch_failed until the save succeeds, so interruption cannot report done.
      const claimed = await rest(`refresh_queue?id=eq.${row.id}&status=eq.patch_failed&or=(reason.is.null,reason.neq.patch_retry)&select=id`, {
        method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ reason: "patch_retry" }),
      });
      if (!claimed?.length) { skipped++; return; }
    }
    let { linkedin_url: url, linkedin_username: username } = row;
    if (!url || !username) {
      const [cand] = await rest(`candidates?id=eq.${row.candidate_id}&select=linkedin_url,linkedin_username`);
      url = url || cand?.linkedin_url;
      username = username || cand?.linkedin_username;
    }
    if (!url && username) url = `https://www.linkedin.com/in/${username}/`;
    if (!url) {
      await finishQueueRow(row, "skipped");
      skipped++;
      return;
    }

    // NEVER pay twice within 30 days: if the ledger has a recent successful
    // pull (e.g. they applied through the site), reuse its stored payload —
    // spine writes and verdict precompute still run, the credit doesn't.
    const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
    const [recent] = await rest(
      `candidate_enrichments?candidate_id=eq.${row.candidate_id}&provider=eq.harvest&status=eq.ok&raw_payload=not.is.null&created_at=gte.${since30}&select=raw_payload,created_at&order=created_at.desc&limit=1`
    );

    let h;
    if (recent) {
      h = recent.raw_payload;
      reused++;
      console.log(`  reusing ledgered profile for ${row.candidate_id} (no Harvest spend)`);
    } else {
      if (row.patchRetry) throw new Error("save retry has no cached profile from the last 30 days");
      const data = await harvestProfile(url);
      h = data.element; // Harvest wraps errors in 200s — element only
    }
    if (!h || typeof h !== "object" || (!h.experience && !h.headline)) throw new Error("harvest empty profile");

    // Shared spine writes: ledger, per-position experiences, embeddings.
    if (!row.patchRetry) {
      await recordEnrichment({
        candidateId: row.candidate_id,
        linkedinUsername: username,
        provider: "harvest",
        operation: "full_profile",
        cacheStatus: recent ? "hit" : "miss",
        raw: recent ? null : h, // don't re-store a payload the ledger already holds
        costCredits: recent ? 0 : 1,
      });
      ledgerWritten = true;
      await syncExperiences(row.candidate_id, h);
      await syncCandidateEmbeddings(row.candidate_id, { linkedin_profile: linkedinProfileText(h) });
    }
    savingProfile = true;

    // The whole candidates row from the profile: jobs, education, summary,
    // skills, headline, place, current job, and the years the Network tab
    // shows, worked out from the new history the way the signals do.
    const patch = harvestToPoolRecord(h);
    if (patch.work_experience) {
      const years = poolSignals({ ...patch, calculated_experience_years: null, total_experience_years: null }).years;
      if (Number.isFinite(years)) patch.calculated_experience_years = Math.round(years);
    }
    if (!Object.keys(patch).length) throw new Error("profile produced no candidate fields");
    patch.linkedin_enrichment_date = recent?.created_at || new Date().toISOString();
    patch.updated_at = new Date().toISOString();
    // Recovery may run a day later, after a newer directory copy was saved.
    const freshnessGuard = row.patchRetry
      ? `&or=(linkedin_enrichment_date.is.null,linkedin_enrichment_date.lte.${encodeURIComponent(patch.linkedin_enrichment_date)})`
      : "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const saved = await rest(`candidates?id=eq.${row.candidate_id}${freshnessGuard}&select=id`, {
          method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch),
        });
        if (!saved?.length) {
          if (row.patchRetry) {
            const [current] = await rest(`candidates?id=eq.${row.candidate_id}&select=linkedin_enrichment_date`);
            if (Date.parse(current?.linkedin_enrichment_date) > Date.parse(patch.linkedin_enrichment_date)) {
              await finishQueueRow(row, "done");
              skipped++;
              console.log(`save retry superseded by newer profile for ${row.candidate_id}`);
              return;
            }
          }
          throw new Error("candidate save matched no row");
        }
        break;
      } catch (err) {
        if (attempt === 1) throw err;
      }
    }

    await finishQueueRow(row, "done");
    refreshed++;
    if (refreshed % 100 === 0 || CONCURRENCY === 1) console.log(`refreshed ${row.candidate_id} (priority ${row.priority}); ${refreshed} done, ${failed} failed`);
  } catch (err) {
    failed++;
    const status = savingProfile ? "patch_failed" : "failed";
    if (savingProfile) patchFailed++;
    console.error(`${status} for ${row.candidate_id}:`, err.message);
    if (!ledgerWritten && !row.patchRetry) await recordEnrichment({
      candidateId: row.candidate_id,
      linkedinUsername: row.linkedin_username,
      provider: "harvest",
      operation: "full_profile",
      cacheStatus: "miss",
      status: "failed",
      costCredits: 0,
    }).catch(() => {});
    await finishQueueRow(row, status);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (work.length) await refreshOne(work.shift());
}));
console.log(`done: ${refreshed} refreshed (${reused} via ledger reuse, no spend), ${failed} failed (${patchFailed} patch_failed), ${skipped} skipped`);
}
