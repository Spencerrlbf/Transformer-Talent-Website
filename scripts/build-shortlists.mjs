#!/usr/bin/env node
// Phase 2: a shortlist per open role, by code. For each role with a
// scorecard: the people nearest its embeddings (two facets, up to 800 each),
// filtered and scored by the card's rules against their signals, skills
// and profile text. The top SHORTLIST_SIZE are written to role_shortlists.
// No model runs; a full pass over all open roles takes minutes.
//
//   ROLE=100 node scripts/build-shortlists.mjs    one role by its external id
//   LIMIT=3  node scripts/build-shortlists.mjs    the first N roles
//   DRY_RUN=1                                     compute and print, write nothing
//   SHORTLIST_SIZE=300                            how many to keep per role
//
// Shared logic comes from the compiled website library: run
// `node scripts/build-worker-lib.mjs` first (the GitHub Action does).
const { rulesOf, assess, expandLocations } = await import("./dist/worker-lib.mjs");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
const DRY_RUN = !!process.env.DRY_RUN;
const ROLE = (process.env.ROLE || "").trim();
const LIMIT = Math.max(0, parseInt(process.env.LIMIT || "0", 10) || 0);
const SIZE = Math.max(10, parseInt(process.env.SHORTLIST_SIZE || "300", 10) || 300);
const PER_FACET = 800;

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
const inList = (ids) => `(${ids.join(",")})`;

const [org] = await rest("organizations?slug=eq.transformer-talent&select=id");
if (!org) throw new Error("Transformer Talent organisation not found");
let roles = await rest(
  `org_roles?organization_id=eq.${org.id}&status=eq.open&scorecard=not.is.null${ROLE ? `&external_id=eq.${encodeURIComponent(ROLE)}` : ""}` +
    `&select=id,external_id,title,locations,workplace,matching_profile,scorecard&order=external_id.asc${LIMIT ? `&limit=${LIMIT}` : ""}`
);
console.log(`${roles.length} open role(s) with a scorecard${DRY_RUN ? ", dry run" : ""}; keeping ${SIZE} per role`);

const t0 = Date.now();
const tally = { roles: 0, considered: 0, kept: 0, saved: 0, failed: 0 };
for (const role of roles) {
  try {
    const rules = rulesOf(role);
    const remote = /remote/i.test(role.workplace || "");
    const patterns = remote ? null : expandLocations(role.locations || []);
    const facets = await rest(`job_embeddings?org_role_id=eq.${role.id}&select=facet,embedding`);
    if (!facets.length) { console.log(`  #${role.external_id} ${role.title}: no embeddings yet, skipped`); continue; }

    // Nearest people per facet, best similarity kept.
    const near = new Map();
    for (const f of facets) {
      const rows = await rest("rpc/match_candidates_v2", { method: "POST", body: JSON.stringify({ query_embedding: f.embedding, match_count: PER_FACET, min_years: null, location_patterns: patterns }) });
      for (const r of rows) {
        const prev = near.get(r.id);
        if (!prev || r.similarity > prev.similarity) near.set(r.id, { id: r.id, similarity: r.similarity, source: r.source, top_skills: r.top_skills || [], headline: r.headline || "" });
      }
    }
    const ids = [...near.keys()];
    tally.considered += ids.length;

    // Their signals and the text the keywords are looked for in.
    const signals = new Map();
    const texts = new Map();
    for (const part of chunk(ids, 100)) {
      for (const s of await rest(`person_signals?candidate_id=in.${inList(part)}&select=candidate_id,years,engineering_years,title_family,top_university_tier,top_university,top_employer_tier,top_employer`)) signals.set(s.candidate_id, s);
      for (const c of await rest(`candidates?id=in.${inList(part)}&select=id,status,source,top_skills,all_skills_text,headline,profile_summary`)) {
        texts.set(c.id, { status: c.status, source: c.source, text: [(c.top_skills || []).join(", "), c.all_skills_text, c.headline, (c.profile_summary || "").slice(0, 2000)].filter(Boolean).join("\n") });
      }
    }

    const scored = [];
    for (const n of near.values()) {
      const s = signals.get(n.id) || {};
      const t = texts.get(n.id) || { text: n.headline };
      const a = assess(rules, { years: s.years, engineering_years: s.engineering_years, title_family: s.title_family || [], top_university_tier: s.top_university_tier, top_university: s.top_university, top_employer_tier: s.top_employer_tier, top_employer: s.top_employer, status: t.status, source: t.source ?? n.source, text: t.text || "" }, n.similarity);
      if (a.keep) scored.push({ id: n.id, similarity: n.similarity, ...a });
    }
    scored.sort((x, y) => y.score - x.score);
    const top = scored.slice(0, SIZE);
    tally.kept += scored.length;
    const rows = top.map((x, i) => ({ org_role_id: role.id, candidate_id: x.id, rank: i + 1, score: x.score, similarity: Math.round(x.similarity * 10000) / 10000, keyword_hits: x.keyword_hits, checks: x.checks, reasons: x.reasons, built_at: new Date().toISOString() }));
    if (!DRY_RUN) {
      await rest(`role_shortlists?org_role_id=eq.${role.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      for (const part of chunk(rows, 300)) await rest("role_shortlists", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(part) });
      tally.saved += rows.length;
    }
    tally.roles++;
    const yrs = rules.yearsRequired != null ? `${rules.yearsRequired}+ ${rules.engineeringYears ? "engineering " : ""}years` : "no years rule";
    console.log(`  #${role.external_id} ${role.title}: ${ids.length} considered, ${scored.length} kept, ${DRY_RUN ? "would save" : "saved"} ${rows.length} (top score ${top[0]?.score ?? "-"}); ${yrs}, ${rules.families ? rules.families.join("/") + " titles" : "any title"}, ${rules.tech.length} tech row(s)${rules.topRow ? `, top ${rules.topRow.kind}${rules.topRow.required ? " required" : ""}` : ""}${patterns ? `, ${patterns.length} location pattern(s)` : ", remote"}`);
  } catch (err) {
    tally.failed++;
    console.log(`  #${role.external_id} ${role.title}: FAILED ${err instanceof Error ? err.message : err}`);
  }
}
console.log(`${DRY_RUN ? "dry run" : "done"}: ${tally.roles} roles, ${tally.considered} people considered, ${tally.kept} kept, ${tally.saved} saved, ${tally.failed} failed in ${Math.round((Date.now() - t0) / 1000)}s`);
