#!/usr/bin/env node
// Phase 3: the light judge over every role's shortlist. For each open role
// with a scorecard, each shortlisted person without a verdict for the
// current profile and card is judged (rows only, no quotes, no review) and
// the verdict is written to match_verdicts as {v2}, where the report card
// and the Network tab read it. Rows are remembered by hash, so an unchanged
// person costs nothing on a later night.
//
//   MAX_JUDGINGS=3000     stop after this many paid judgings (the nightly cap; ~$0.45)
//   ROLE=100 / LIMIT=5    one role, or the first N roles
//   DRY_RUN=1             count what would be judged, call nothing
//   CONCURRENCY=4         judgings in flight
//
// Shared logic comes from the compiled website library: run
// `node scripts/build-worker-lib.mjs` first (the GitHub Action does).
const { shortlistRoleContext, judgePoolCandidate, JEV_MODEL, SHORTLIST_ROLE_COLS } = await import("./dist/worker-lib.mjs");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
const DRY_RUN = !!process.env.DRY_RUN;
if (!DRY_RUN && !process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY required (the judge of scorecard rows)");
const ROLE = (process.env.ROLE || "").trim();
const LIMIT = Math.max(0, parseInt(process.env.LIMIT || "0", 10) || 0);
const MAX_JUDGINGS = Math.max(1, parseInt(process.env.MAX_JUDGINGS || "3000", 10) || 3000);
const CONCURRENCY = Math.min(8, Math.max(1, parseInt(process.env.CONCURRENCY || "4", 10) || 4));
const USD_PER_JUDGING = 0.00015;
const POOL_COLS = "id,full_name,headline,current_title,current_company,profile_summary,location,work_experience,education,education_schools,top_skills,all_skills_text,calculated_experience_years,total_experience_years,updated_at";

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  if (!res.ok) {
    const raw = await res.text();
    let why = raw.slice(0, 200);
    try { const j = JSON.parse(raw); why = [j.code, j.message, j.hint].filter(Boolean).join(" | ").slice(0, 300); } catch {}
    throw new Error(`${init.method || "GET"} ${path.split("?")[0]} ${res.status}: ${why}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

const [org] = await rest("organizations?slug=eq.transformer-talent&select=id");
if (!org) throw new Error("Transformer Talent organisation not found");
const roles = await rest(
  `org_roles?organization_id=eq.${org.id}&status=eq.open&scorecard=not.is.null${ROLE ? `&external_id=eq.${encodeURIComponent(ROLE)}` : ""}` +
    `&select=${SHORTLIST_ROLE_COLS}&order=external_id.asc${LIMIT ? `&limit=${LIMIT}` : ""}`
);
console.log(`${roles.length} open role(s) with a scorecard${DRY_RUN ? ", dry run" : ""}; at most ${MAX_JUDGINGS} paid judgings`);

const t0 = Date.now();
const tally = { roles: 0, shortlisted: 0, alreadyJudged: 0, judged: 0, fromMemory: 0, written: 0, failed: 0, labels: {} };
let stopped = false;
for (const role of roles) {
  if (stopped) break;
  const ctx = shortlistRoleContext(role);
  if (!ctx.criteria.length) continue;
  const list = await rest(`role_shortlists?org_role_id=eq.${role.id}&select=candidate_id,rank&order=rank.asc`);
  tally.roles++;
  tally.shortlisted += list.length;
  if (!list.length) { console.log(`  #${role.external_id} ${role.title}: no shortlist yet`); continue; }

  // Who already has a verdict for this card: any row with this role hash.
  const ids = list.map((r) => r.candidate_id);
  const have = new Map(); // candidate_id -> candidate_hash
  for (const part of chunk(ids, 100)) {
    for (const v of await rest(`match_verdicts?org_role_id=eq.${role.id}&role_hash=eq.${ctx.roleHash}&candidate_id=in.(${part.join(",")})&select=candidate_id,candidate_hash`)) have.set(v.candidate_id, v.candidate_hash);
  }
  const people = [];
  for (const part of chunk(ids, 50)) for (const c of await rest(`candidates?id=in.(${part.join(",")})&select=${POOL_COLS}`)) people.push(c);
  const byId = new Map(people.map((c) => [c.id, c]));
  const todo = list.map((r) => byId.get(r.candidate_id)).filter(Boolean);

  let roleJudged = 0, roleMemory = 0, roleSkipped = 0, roleFailed = 0;
  const roleLabels = {};
  const queue = [...todo];
  const worker = async () => {
    while (queue.length && !stopped) {
      const c = queue.shift();
      const { poolSourceHash } = await import("./dist/worker-lib.mjs");
      const hash = poolSourceHash(c);
      if (have.get(c.id) === hash) { roleSkipped++; continue; }
      if (DRY_RUN) { roleJudged++; continue; }
      if (tally.judged >= MAX_JUDGINGS) { stopped = true; break; }
      try {
        const r = await judgePoolCandidate(ctx, c);
        if (!r.view) {
          roleFailed++;
          if (r.error && (r.error.status === 401 || r.error.status === 403)) throw new Error(`judge key rejected (${r.error.status} ${r.error.code || ""})`);
          continue;
        }
        if (r.saved) roleMemory++; else { roleJudged++; tally.judged++; }
        roleLabels[r.view.label] = (roleLabels[r.view.label] || 0) + 1;
        await rest("match_verdicts?on_conflict=candidate_id,org_role_id,candidate_hash,role_hash", {
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
          body: JSON.stringify([{ organization_id: role.organization_id, candidate_id: c.id, org_role_id: role.id, candidate_hash: hash, role_hash: ctx.roleHash, verdict: { v2: r.view }, model: JEV_MODEL, source: "shortlist" }]),
        });
        tally.written++;
      } catch (err) {
        roleFailed++;
        if (/key rejected/.test(String(err))) throw err;
        if (roleFailed <= 3) console.log(`    ${c.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  tally.alreadyJudged += roleSkipped; tally.fromMemory += roleMemory; tally.failed += roleFailed;
  for (const [k, v] of Object.entries(roleLabels)) tally.labels[k] = (tally.labels[k] || 0) + v;
  console.log(`  #${role.external_id} ${role.title}: ${list.length} shortlisted, ${roleSkipped} already judged, ${DRY_RUN ? "would judge" : "judged"} ${roleJudged}${roleMemory ? ` (+${roleMemory} from memory)` : ""}${roleFailed ? `, ${roleFailed} failed` : ""}${Object.keys(roleLabels).length ? `; ${Object.entries(roleLabels).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}`);
}
const cost = (tally.judged * USD_PER_JUDGING).toFixed(2);
console.log(`${DRY_RUN ? "dry run" : "done"}: ${tally.roles} roles, ${tally.shortlisted} shortlisted, ${tally.alreadyJudged} already judged, ${tally.judged} ${DRY_RUN ? "would be judged" : "judged"} (~$${cost}), ${tally.fromMemory} from memory, ${tally.written} written, ${tally.failed} failed${stopped ? `; STOPPED at the cap of ${MAX_JUDGINGS}` : ""}; labels ${JSON.stringify(tally.labels)}; ${Math.round((Date.now() - t0) / 1000)}s`);
