#!/usr/bin/env node
// Nightly Harvest refresh worker. Drains refresh_queue (priority asc — 10 =
// matched in a JD search, 50 = engaged backfill) up to REFRESH_DAILY_CAP paid
// Harvest calls per UTC day, counted from the candidate_enrichments ledger so
// website applications share the same budget. Tops the queue up with engaged
// candidates when it has spare capacity.
//
// All shared logic (facts, screening + verdict cache, spine writes) comes from
// the compiled website library — run `node scripts/build-worker-lib.mjs`
// first (the GitHub Action does). This file is orchestration only.
//
// Modes:
//   node scripts/refresh-worker.mjs                      nightly drain
//   PRECOMPUTE_BACKFILL=N node scripts/refresh-worker.mjs  re-screen stored
//     payloads against roles with no Harvest spend.
import fs from "node:fs";

try {
  const envFile = fs.readFileSync(new URL("../.env.scripts", import.meta.url), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const {
  computeFacts,
  formatFacts,
  harvestToExperiences,
  linkedinProfileText,
  recordEnrichment,
  syncExperiences,
  syncCandidateEmbeddings,
  screenRolesWithCache,
  findStretchRoles,
} = await import("./dist/worker-lib.mjs");

// Internal experiment: retrieval by inferred capability. Verdicts land with
// source='stretch' and are never user-facing. Kill switch: STRETCH_CHANNEL=0.
const STRETCH = process.env.STRETCH_CHANNEL !== "0";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HARVEST = process.env.HARVEST_API_KEY;
const CAP = Math.max(0, parseInt(process.env.REFRESH_DAILY_CAP || "50", 10) || 0);
if (!SUPABASE_URL || !KEY) throw new Error("Supabase creds required");
if (!HARVEST && !process.env.PRECOMPUTE_BACKFILL) throw new Error("HARVEST_API_KEY required");

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...headers, ...init.headers } });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path.split("?")[0]} ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const [org] = await rest("organizations?slug=eq.transformer-talent&select=id");
if (!org) throw new Error("organization not found");

// Budget: paid Harvest calls already made today (site + worker share the cap).
const todayStart = new Date().toISOString().slice(0, 10) + "T00:00:00Z";
const spentRes = await fetch(
  `${SUPABASE_URL}/rest/v1/candidate_enrichments?provider=eq.harvest&cache_status=eq.miss&created_at=gte.${todayStart}&select=id`,
  { headers: { ...headers, Prefer: "count=exact", Range: "0-0" } }
);
const spent = parseInt((spentRes.headers.get("content-range") || "/0").split("/")[1], 10) || 0;
const remaining = Math.max(0, CAP - spent);
console.log(`cap ${CAP}, spent today ${spent}, remaining ${remaining}`);
if (!remaining && !process.env.PRECOMPUTE_BACKFILL) process.exit(0);

// ---- Verdict precompute: retrieval is worker-specific, everything after ----
// ---- (facts, evidence, LLM, cache) is the shared library.               ----

async function precomputeVerdicts(candidateId, h, vector, username) {
  const skills = (h.skills || []).map((s) => s?.name).filter(Boolean);
  const logErr = (ch) => (e) => {
    console.error(`  precompute ${username} ${ch} channel failed: ${e.message}`);
    return [];
  };
  const [vec, kw] = await Promise.all([
    vector
      ? rest("rpc/match_org_roles", { method: "POST", body: JSON.stringify({ query_embedding: vector, match_count: 5 }) }).catch(logErr("vector"))
      : [],
    skills.length
      ? rest("rpc/match_roles_keyword", { method: "POST", body: JSON.stringify({ skills: skills.slice(0, 40), match_count: 5 }) }).catch(logErr("keyword"))
      : [],
  ]);
  const ids = [...new Set([...vec.map((r) => r.external_id), ...kw.map((r) => r.job_id)])].slice(0, 5);
  if (!ids.length) {
    console.log(`  precompute ${username}: no roles matched (vec ${vec.length}, kw ${kw.length})`);
    return 0;
  }
  const roleRows = await rest(
    `org_roles?external_id=in.(${ids.map((i) => `"${i}"`).join(",")})&select=external_id,tech_stack`
  );
  const stackTerms = [
    ...new Set(
      roleRows.flatMap((t) => (t.tech_stack || "").split(/[,/•]/).map((s) => s.trim()).filter((s) => s.length >= 2))
    ),
  ].slice(0, 20);

  const expRows = harvestToExperiences(h);
  const facts = computeFacts(expRows, stackTerms, skills, h.education);
  const evidence = [
    linkedinProfileText(h).slice(0, 4000),
    `FACTS (computed from dated position history):\n${formatFacts(facts)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const verdicts = await screenRolesWithCache({
    candidateId,
    evidence,
    cacheKeyText: ["", JSON.stringify(h)].join("|"), // same format as the website (no resume)
    jobIds: ids,
    facts,
    source: "precompute",
  });
  const fresh = verdicts.filter((v) => !v.cached).length;
  console.log(`  precompute ${username}: ${verdicts.length} verdicts (${fresh} fresh, ${verdicts.length - fresh} cached)`);

  // Stretch channel: signals from the evidence verdicts become search
  // queries; only NEW roles count, capped, same strict screener.
  if (STRETCH) {
    try {
      const signals = [];
      const seenSignal = new Set();
      for (const v of verdicts) {
        for (const s of v.inferred_signals || []) {
          if (!seenSignal.has(s.signal)) {
            seenSignal.add(s.signal);
            signals.push(s);
          }
        }
      }
      if (signals.length) {
        const stretchRoles = await findStretchRoles(signals, ids, 2);
        if (stretchRoles.length) {
          const stretchVerdicts = await screenRolesWithCache({
            candidateId,
            evidence,
            cacheKeyText: ["", JSON.stringify(h)].join("|"),
            jobIds: stretchRoles.map((r) => r.jobId),
            facts,
            source: "stretch",
            originByJobId: Object.fromEntries(stretchRoles.map((r) => [r.jobId, r.fromSignal])),
          });
          const q = stretchVerdicts.filter((v) => v.qualified).length;
          console.log(
            `  stretch ${username}: ${stretchRoles.map((r) => "#" + r.jobId).join(",")} via signals -> ${q}/${stretchVerdicts.length} qualified`
          );
        }
      }
    } catch (err) {
      console.error(`  stretch channel failed for ${username}: ${err.message}`);
    }
  }
  return fresh;
}

async function chunk0Vector(candidateId) {
  const [ex] = await rest(
    `candidate_embeddings?candidate_id=eq.${candidateId}&source_type=eq.linkedin_profile&chunk_index=eq.0&select=embedding&limit=1`
  );
  return ex?.embedding ? JSON.parse(ex.embedding) : null;
}

// PRECOMPUTE_BACKFILL=N: no Harvest spend — precompute verdicts for the N
// most recently enriched candidates from their stored payloads, then exit.
if (process.env.PRECOMPUTE_BACKFILL) {
  const n = parseInt(process.env.PRECOMPUTE_BACKFILL, 10) || 5;
  const enr = await rest(
    `candidate_enrichments?provider=eq.harvest&status=eq.ok&raw_payload=not.is.null&candidate_id=not.is.null&select=candidate_id,linkedin_username,raw_payload&order=created_at.desc&limit=${n * 3}`
  );
  const seen = new Set();
  let stored = 0, processed = 0;
  for (const e of enr) {
    if (seen.has(e.candidate_id) || processed >= n) continue;
    seen.add(e.candidate_id);
    processed++;
    stored += await precomputeVerdicts(e.candidate_id, e.raw_payload, await chunk0Vector(e.candidate_id), e.linkedin_username);
  }
  console.log(`backfill done: ${stored} fresh verdicts across ${processed} candidates`);
  process.exit(0);
}

// ---- Nightly drain ----

const queued = await rest(
  `refresh_queue?status=eq.queued&select=id,candidate_id,linkedin_url,linkedin_username,priority&order=priority.asc,queued_at.asc&limit=${remaining}`
);
if (queued.length < remaining) {
  const everQueued = new Set((await rest("refresh_queue?select=candidate_id")).map((r) => r.candidate_id));
  const engaged = await rest(
    `candidates?source=eq.airtable_sync&linkedin_username=not.is.null&select=id,linkedin_url,linkedin_username&order=updated_at.desc&limit=${(remaining - queued.length) * 3}`
  );
  const topUp = engaged.filter((c) => !everQueued.has(c.id)).slice(0, remaining - queued.length);
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
console.log(`processing ${Math.min(queued.length, remaining)} of ${queued.length} queued`);

async function finishQueueRow(row, status) {
  // unique(candidate_id, status): clear any previous terminal row first.
  await rest(`refresh_queue?candidate_id=eq.${row.candidate_id}&status=eq.${status}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  }).catch(() => {});
  await rest(`refresh_queue?id=eq.${row.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status, processed_at: new Date().toISOString() }),
  });
}

let refreshed = 0, failed = 0, skipped = 0, verdictsStored = 0;
for (const row of queued.slice(0, remaining)) {
  try {
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
      continue;
    }

    const res = await fetch(`https://api.harvestapi.io/linkedin/profile?url=${encodeURIComponent(url)}`, {
      headers: { "X-API-Key": HARVEST },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new Error(`harvest ${res.status}`);
    const data = await res.json();
    const h = data.element; // Harvest wraps errors in 200s — element only
    if (!h || typeof h !== "object" || (!h.experience && !h.headline)) throw new Error("harvest empty profile");

    // Shared spine writes: ledger, per-position experiences, embeddings.
    await recordEnrichment({
      candidateId: row.candidate_id,
      linkedinUsername: username,
      provider: "harvest",
      operation: "full_profile",
      cacheStatus: "miss",
      raw: h,
      costCredits: 1,
    });
    await syncExperiences(row.candidate_id, h);
    await syncCandidateEmbeddings(row.candidate_id, { linkedin_profile: linkedinProfileText(h) });

    // Candidates-row freshness: full skills + headline + current position.
    const allSkills = (h.skills || []).map((s) => s?.name).filter(Boolean);
    const expList = Array.isArray(h.experience) ? h.experience : [];
    const current = expList.find((e) => /present/i.test(e.endDate?.text || "")) || expList[0];
    const locationText =
      typeof h.location === "string" ? h.location : h.location?.linkedinText || h.location?.parsed?.text || null;
    const clean = (s) => String(s ?? "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ").trim();
    const patch = {
      ...(allSkills.length ? { top_skills: allSkills } : {}),
      ...(h.headline ? { headline: clean(h.headline).slice(0, 500) } : {}),
      ...(locationText ? { location: clean(locationText).slice(0, 200) } : {}),
      ...(current?.position || current?.title ? { current_title: current.position || current.title } : {}),
      ...(current?.companyName || current?.company ? { current_company: current.companyName || current.company } : {}),
    };
    if (Object.keys(patch).length) {
      await rest(`candidates?id=eq.${row.candidate_id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(patch),
      }).catch((e) => console.error(`candidate patch failed for ${row.candidate_id}:`, e.message));
    }

    // Precompute cached verdicts against their closest roles — JD searches
    // then return pre-screened, evidence-backed candidates instantly.
    try {
      verdictsStored += await precomputeVerdicts(row.candidate_id, h, await chunk0Vector(row.candidate_id), username);
    } catch (err) {
      console.error(`precompute failed for ${row.candidate_id}:`, err.message);
    }

    await finishQueueRow(row, "done");
    refreshed++;
    console.log(`refreshed ${username || row.candidate_id} (priority ${row.priority})`);
  } catch (err) {
    failed++;
    console.error(`refresh failed for ${row.candidate_id}:`, err.message);
    await recordEnrichment({
      candidateId: row.candidate_id,
      linkedinUsername: row.linkedin_username,
      provider: "harvest",
      operation: "full_profile",
      cacheStatus: "miss",
      status: "failed",
      costCredits: 0,
    }).catch(() => {});
    await finishQueueRow(row, "failed").catch(() => {});
  }
}
console.log(`done: ${refreshed} refreshed, ${failed} failed, ${skipped} skipped, ${verdictsStored} verdicts precomputed`);
