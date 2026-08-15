#!/usr/bin/env node
// Nightly Harvest refresh worker. Drains refresh_queue (priority asc — 10 =
// matched in a JD search, 50 = engaged backfill) up to REFRESH_DAILY_CAP paid
// Harvest calls per UTC day, counted from the candidate_enrichments ledger so
// website applications share the same budget. Tops the queue up with engaged
// candidates when it has spare capacity. Each refresh writes: ledger row,
// per-position experiences, linkedin_profile embeddings, and a candidates-row
// update (full skills, headline, location, current position).
import fs from "node:fs";
import crypto from "node:crypto";

try {
  const envFile = fs.readFileSync(new URL("../.env.scripts", import.meta.url), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI = process.env.OPENAI_API_KEY;
const HARVEST = process.env.HARVEST_API_KEY;
const CAP = Math.max(0, parseInt(process.env.REFRESH_DAILY_CAP || "50", 10) || 0);
if (!SUPABASE_URL || !KEY) throw new Error("Supabase creds required");
if (!HARVEST) throw new Error("HARVEST_API_KEY required");

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...headers, ...init.headers } });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path.split("?")[0]} ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const clean = (s) => String(s ?? "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ").trim();

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

// Top up the queue with engaged candidates (priority 50) if it's running dry.
const queued = await rest(
  `refresh_queue?status=eq.queued&select=id,candidate_id,linkedin_url,linkedin_username,priority&order=priority.asc,queued_at.asc&limit=${remaining}`
);
if (queued.length < remaining && !process.env.PRECOMPUTE_BACKFILL) {
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
      ...(await rest(
        `refresh_queue?status=eq.queued&select=id,candidate_id,linkedin_url,linkedin_username,priority&order=priority.asc,queued_at.asc&limit=${remaining}`
      )).filter((q) => !queued.some((x) => x.id === q.id))
    );
  }
}
console.log(`processing ${Math.min(queued.length, remaining)} of ${queued.length} queued`);

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const monthNum = (m) =>
  typeof m === "number" ? (m >= 1 && m <= 12 ? m : null) : typeof m === "string" ? MONTHS[m.slice(0, 3).toLowerCase()] ?? null : null;

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

function profileText(h) {
  const parts = [];
  if (h.headline) parts.push(String(h.headline));
  if (h.about) parts.push(String(h.about).slice(0, 3000));
  for (const e of (Array.isArray(h.experience) ? h.experience : []).slice(0, 15)) {
    const skills = Array.isArray(e.skills)
      ? e.skills.map((s) => (typeof s === "string" ? s : s?.name)).filter(Boolean).join(", ")
      : "";
    parts.push(
      [
        e.position || e.title,
        (e.companyName || e.company) && `at ${e.companyName || e.company}`,
        e.duration,
        e.location,
        clean(e.description).slice(0, 600),
        skills && `Skills: ${skills}`,
      ].filter(Boolean).join(". ")
    );
  }
  const skills = (h.skills || []).map((s) => s?.name).filter(Boolean);
  if (skills.length) parts.push(`All skills: ${skills.join(", ")}`);
  for (const ed of (Array.isArray(h.education) ? h.education : []).slice(0, 4)) {
    parts.push([ed.degree, ed.fieldOfStudy, ed.schoolName || ed.school, ed.period].filter(Boolean).join(", "));
  }
  return parts.filter(Boolean).join("\n");
}

function chunkText(text, size = 2800, max = 6) {
  const out = [];
  let rest_ = text.trim();
  while (rest_ && out.length < max) {
    if (rest_.length <= size) { out.push(rest_); break; }
    let cut = rest_.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    out.push(rest_.slice(0, cut));
    rest_ = rest_.slice(cut).trim();
  }
  return out.filter((c) => c.length >= 40);
}

// ---- Precompute helpers: facts + cached question-sheet verdicts ----
// (compact ports of lib/server/facts.ts + screening.ts for the worker)

function mergedYears(intervals) {
  if (!intervals.length) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let months = 0, [curS, curE] = sorted[0];
  for (const [s, e] of sorted.slice(1)) {
    if (s <= curE) curE = Math.max(curE, e);
    else { months += curE - curS; [curS, curE] = [s, e]; }
  }
  return Math.round(((months + curE - curS) / 12) * 10) / 10;
}
const normSkill = (s) => String(s).toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9+#. ]/g, " ").replace(/\s+/g, " ").trim();
function skillMatch(a, b) {
  const x = normSkill(a), y = normSkill(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 3 && y.includes(x)) || (y.length >= 3 && x.includes(y));
}
// Career rules (v2, mirrors lib/server/facts.ts): titles trump employment
// type, undergrad graduation anchors the career clock, internships are
// reported separately — never blended into career years.
const NON_CAREER_TITLE = /\bintern(ship)?\b|co-?op\b|\bclinic\b|\bfellow(ship)?\b|research assistant|teaching assistant|\bapprentice\b/i;
const NON_CAREER_TYPE = /intern|part-?time|apprentice/i;
function undergradEndYear(education) {
  if (!Array.isArray(education)) return null;
  let latest = null;
  for (const ed of education) {
    if (!/\bbachelor|\bb\.?\s?s\b|\bb\.?\s?a\b|\bb\.?\s?eng\b|\bbsc\b|undergrad/i.test(String(ed?.degree || ""))) continue;
    let year = ed?.endDate?.year ?? null;
    if (!year && typeof ed?.period === "string") { const m = ed.period.match(/(\d{4})\s*$/); if (m) year = parseInt(m[1], 10); }
    if (year && (!latest || year > latest)) latest = year;
  }
  return latest;
}
function computeWorkerFacts(expList, skillTerms, profileSkills, education) {
  const now = new Date(); const nowN = now.getUTCFullYear() * 12 + now.getUTCMonth() + 1;
  const gradYear = undergradEndYear(education);
  const gradM = gradYear ? gradYear * 12 + 6 : null;
  const iv = (e) => {
    if (!e.startDate?.year) return null;
    const s = e.startDate.year * 12 + (monthNum(e.startDate.month) ?? 6);
    const cur = /present/i.test(e.endDate?.text || "") || !e.endDate?.year;
    const en = cur ? nowN : e.endDate.year * 12 + (monthNum(e.endDate.month) ?? 6);
    return en > s ? [s, en] : null;
  };
  const classified = expList.map((e) => {
    const i = iv(e);
    let career = !NON_CAREER_TITLE.test(e.position || e.title || "") && !NON_CAREER_TYPE.test(e.employmentType || "");
    let clamped = i;
    if (career && gradM && i) {
      if (i[1] <= gradM) career = false;
      else if (i[0] < gradM) clamped = [gradM, i[1]];
    }
    return { e, career, iv: career ? clamped : i };
  });
  const careerRows = classified.filter((c) => c.career);
  const excludedRows = classified.filter((c) => !c.career);
  const uses = (e, skill) => {
    const sk = Array.isArray(e.skills) ? e.skills.map((s) => (typeof s === "string" ? s : s?.name || "")) : [];
    if (sk.some((s) => skillMatch(skill, s))) return true;
    return e.description ? new RegExp("\\b" + normSkill(skill).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(e.description) : false;
  };
  const lines = [];
  const careerYears = mergedYears(careerRows.map((c) => c.iv).filter(Boolean));
  const excludedYears = mergedYears(excludedRows.map((c) => c.iv).filter(Boolean));
  if (careerYears === 0 && excludedYears > 0) {
    lines.push(`Career experience: 0 years — new grad with ${excludedYears}y of internships`);
  } else if (careerYears) {
    const excl = excludedRows.length ? `; excludes ${excludedRows.length} internship/clinic positions totaling ${excludedYears}y` : "";
    lines.push(`Career experience: ${careerYears} years${excl}`);
  }
  for (const skill of [...new Set(skillTerms)].slice(0, 20)) {
    const usingCareer = careerRows.filter((c) => uses(c.e, skill));
    const usingExcl = excludedRows.filter((c) => uses(c.e, skill));
    if (usingCareer.length) {
      const yrs = mergedYears(usingCareer.map((c) => c.iv).filter(Boolean));
      const first = usingCareer[0].e;
      const where = first.position || first.title || "prior role";
      lines.push(`${skill}: ${yrs}y career (${where}${first.companyName ? " at " + first.companyName : ""})${usingExcl.length ? "; also used in internships" : ""}`);
    } else if (usingExcl.length) {
      lines.push(`${skill}: used during internships only`);
    } else if ((profileSkills || []).some((s) => skillMatch(skill, s))) {
      lines.push(`${skill}: listed on profile, no dated position evidence`);
    }
  }
  return { lines, careerYears: careerYears || null };
}

async function precomputeVerdicts(row, h, vector, username) {
  if (!OPENAI || !vector) {
    console.log(`  precompute skip ${username || row.candidate_id}: ${!OPENAI ? "no OPENAI key" : "no profile vector"}`);
    return 0;
  }
  // Retrieval: vector + keyword channels over org roles.
  const skills = (h.skills || []).map((s) => s?.name).filter(Boolean);
  const logErr = (ch) => (e) => { console.error(`  precompute ${username} ${ch} channel failed: ${e.message}`); return []; };
  const [vec, kw] = await Promise.all([
    rest("rpc/match_org_roles", { method: "POST", body: JSON.stringify({ query_embedding: vector, match_count: 5 }) }).catch(logErr("vector")),
    skills.length
      ? rest("rpc/match_roles_keyword", { method: "POST", body: JSON.stringify({ skills: skills.slice(0, 40), match_count: 5 }) }).catch(logErr("keyword"))
      : [],
  ]);
  const ids = [...new Set([...vec.map((r) => r.external_id), ...kw.map((r) => r.job_id)])].slice(0, 5);
  if (!ids.length) {
    console.log(`  precompute ${username}: no roles matched (vec ${vec.length}, kw ${kw.length})`);
    return 0;
  }
  const roleRows = await rest(`org_roles?external_id=in.(${ids.map((i) => `"${i}"`).join(",")})&select=id,external_id,title,tech_stack,matching_profile`);
  const expList = Array.isArray(h.experience) ? h.experience : [];

  const cacheKeyText = ["", JSON.stringify(h)].join("|"); // same format as the website (no resume)
  const candidateHash = sha("factsv2|" + cacheKeyText); // version prefix matches lib/server/screening.ts
  const targets = [];
  for (const r of roleRows) {
    const p = r.matching_profile;
    if (!p?.screening_questions?.length) continue;
    // min-years gate from dated history (visa unknown for pool candidates).
    const roleHash = sha(JSON.stringify({ m: p.must_haves, q: p.screening_questions }));
    const cached = await rest(
      `match_verdicts?candidate_id=eq.${row.candidate_id}&org_role_id=eq.${r.id}&candidate_hash=eq.${candidateHash}&role_hash=eq.${roleHash}&select=id&limit=1`
    );
    if (cached.length) continue;
    targets.push({ ...r, roleHash, profile: p });
  }
  if (!targets.length) {
    console.log(`  precompute ${username}: no fresh targets (matched ${ids.length} roles, all cached or unprofiled)`);
    return 0;
  }

  const stackTerms = [...new Set(targets.flatMap((t) => (t.tech_stack || "").split(/[,/•]/).map((s) => s.trim()).filter((s) => s.length >= 2)))].slice(0, 20);
  const facts = computeWorkerFacts(expList, stackTerms, skills, h.education);
  const evidence = [profileText(h).slice(0, 4000), facts.lines.length ? `FACTS (computed from dated position history):\n${facts.lines.join("\n")}` : ""].filter(Boolean).join("\n\n");

  const rolesBlock = targets
    .map((t) => `ROLE ${t.external_id}:\nMUST-HAVES: ${t.profile.must_haves.join("; ")}\nQUESTIONS:\n${t.profile.screening_questions.slice(0, 8).map((q, i) => `${i + 1}. ${q}`).join("\n")}`)
    .join("\n\n");
  const llm = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "verdicts", strict: true, schema: {
        type: "object", additionalProperties: false, required: ["results"],
        properties: { results: { type: "array", items: {
          type: "object", additionalProperties: false, required: ["job_id", "qualified", "fit_score", "answers"],
          properties: {
            job_id: { type: "string" }, qualified: { type: "boolean" }, fit_score: { type: "number" },
            answers: { type: "array", items: { type: "object", additionalProperties: false, required: ["question", "answer", "evidence"],
              properties: { question: { type: "string" }, answer: { type: "string", enum: ["yes", "no", "unclear"] }, evidence: { type: "string" } } } },
          } } } } } } },
      messages: [
        { role: "system", content:
          "You screen one candidate against several roles. Answer EVERY question for every role with yes/no/unclear plus a short evidence citation (max 12 words). The FACTS block is computed from dated position history — treat it as ground truth. No evidence = 'unclear'. qualified = no must-have clearly failed and most questions yes. fit_score = 0-1." },
        { role: "user", content: `CANDIDATE:\n${evidence.slice(0, 7000)}\n\n${rolesBlock}` },
      ],
    }),
  });
  if (!llm.ok) {
    console.error(`  precompute LLM failed ${llm.status}: ${(await llm.text()).slice(0, 200)}`);
    return 0;
  }
  let results;
  try { results = JSON.parse((await llm.json()).choices[0].message.content).results; } catch (e) {
    console.error(`  precompute parse failed: ${e.message}`);
    return 0;
  }
  // The model sometimes echoes "ROLE 76" instead of "76".
  results = results.map((v) => ({ ...v, job_id: String(v.job_id).replace(/^role\s*/i, "").trim() }));
  if (results.length !== targets.length) {
    console.log(`  precompute ${username}: LLM returned ${results.length}/${targets.length} roles [${results.map((r) => r.job_id).join(",")}]`);
  }
  const inserts = results
    .map((v) => {
      const t = targets.find((x) => x.external_id === v.job_id);
      if (!t) return null;
      return {
        organization_id: org.id, candidate_id: row.candidate_id, org_role_id: t.id,
        candidate_hash: candidateHash, role_hash: t.roleHash,
        verdict: { ...v, facts: { careerYears: facts.careerYears, lines: facts.lines } },
        model: "gpt-4o-mini", source: "precompute",
      };
    })
    .filter(Boolean);
  console.log(`  precompute ${username}: ${targets.length} targets -> ${results.length} results [${results.map((r) => r.job_id).join(",")}] -> ${inserts.length} inserts`);
  if (inserts.length) {
    await rest("match_verdicts?on_conflict=candidate_id,org_role_id,candidate_hash,role_hash", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(inserts),
    });
  }
  return inserts.length;
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
    let vec = null;
    const [ex] = await rest(
      `candidate_embeddings?candidate_id=eq.${e.candidate_id}&source_type=eq.linkedin_profile&chunk_index=eq.0&select=embedding&limit=1`
    );
    if (ex?.embedding) vec = JSON.parse(ex.embedding);
    const cnt = await precomputeVerdicts({ candidate_id: e.candidate_id }, e.raw_payload, vec, e.linkedin_username);
    console.log(`backfill ${e.linkedin_username}: ${cnt} verdicts`);
    stored += cnt;
  }
  console.log(`backfill done: ${stored} verdicts across ${processed} candidates`);
  process.exit(0);
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
    const h = data.element || data;
    if (!h || typeof h !== "object" || (!h.experience && !h.headline)) throw new Error("harvest empty profile");

    // Ledger (the paid call).
    await rest("candidate_enrichments", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        organization_id: org.id,
        candidate_id: row.candidate_id,
        linkedin_username: username,
        provider: "harvest",
        operation: "full_profile",
        cache_status: "miss",
        status: "ok",
        raw_payload: h,
        cost_credits: 1,
      }),
    });

    // Experiences.
    const expList = Array.isArray(h.experience) ? h.experience : [];
    if (expList.length) {
      await rest("candidate_experiences?on_conflict=candidate_id,source,provider_experience_key", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(
          expList.slice(0, 25).map((e, i) => ({
            organization_id: org.id,
            candidate_id: row.candidate_id,
            source: "harvest",
            provider_experience_key: sha(
              [e.companyId, e.companyName || e.company, e.position || e.title, e.startDate?.text].filter(Boolean).join("|") || `idx-${i}`
            ).slice(0, 32),
            title: e.position || e.title || null,
            company_name: e.companyName || e.company || null,
            company_linkedin_url: e.companyLinkedinUrl || e.companyLink || null,
            employment_type: e.employmentType || null,
            location: e.location || null,
            start_month: monthNum(e.startDate?.month),
            start_year: e.startDate?.year ?? null,
            end_month: monthNum(e.endDate?.month),
            end_year: e.endDate?.year ?? null,
            is_current: /present/i.test(e.endDate?.text || "") || (!e.endDate?.year && i === 0),
            duration_text: e.duration || null,
            description: clean(e.description).slice(0, 8000) || null,
            skills: Array.isArray(e.skills)
              ? e.skills.map((s) => (typeof s === "string" ? s : s?.name || "")).filter(Boolean)
              : [],
            raw: e,
            sort_order: i,
            updated_at: new Date().toISOString(),
          }))
        ),
      });
    }

    // linkedin_profile embeddings (hash-deduped replace).
    let profileVector = null; // chunk-0 vector, reused for role precompute
    if (OPENAI) {
      const text = clean(profileText(h));
      const chunks = chunkText(text).map((content, i) => ({
        source_type: "linkedin_profile",
        chunk_index: i,
        content,
        content_hash: sha(content),
      }));
      if (chunks.length) {
        const existing = await rest(
          `candidate_embeddings?candidate_id=eq.${row.candidate_id}&source_type=eq.linkedin_profile&select=id,chunk_index,content_hash`
        );
        const wantKeys = new Set(chunks.map((c) => `${c.chunk_index}|${c.content_hash}`));
        const stale = existing.filter((e) => !wantKeys.has(`${e.chunk_index}|${e.content_hash}`));
        if (stale.length) {
          await rest(`candidate_embeddings?id=in.(${stale.map((s) => s.id).join(",")})`, {
            method: "DELETE",
            headers: { Prefer: "return=minimal" },
          });
        }
        const haveKeys = new Set(existing.map((e) => `${e.chunk_index}|${e.content_hash}`));
        const todo = chunks.filter((c) => !haveKeys.has(`${c.chunk_index}|${c.content_hash}`));
        if (todo.length) {
          const embRes = await fetch("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: { Authorization: `Bearer ${OPENAI}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "text-embedding-3-small", input: todo.map((t) => t.content.slice(0, 8000)) }),
          });
          if (embRes.ok) {
            const vectors = (await embRes.json()).data;
            if (todo[0]?.chunk_index === 0) profileVector = vectors[0].embedding;
            await rest("candidate_embeddings?on_conflict=candidate_id,source_type,chunk_index,content_hash", {
              method: "POST",
              headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
              body: JSON.stringify(
                todo.map((t, i) => ({
                  organization_id: org.id,
                  candidate_id: row.candidate_id,
                  ...t,
                  model: "text-embedding-3-small",
                  dimensions: 1536,
                  embedding: JSON.stringify(vectors[i].embedding),
                }))
              ),
            });
          }
        }
      }
    }

    // Candidates-row freshness: full skills + headline + current position.
    const allSkills = (h.skills || []).map((s) => s?.name).filter(Boolean);
    const current = expList.find((e) => /present/i.test(e.endDate?.text || "")) || expList[0];
    const locationText =
      typeof h.location === "string" ? h.location : h.location?.linkedinText || h.location?.parsed?.text || null;
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
      if (!profileVector) {
        const [ex] = await rest(
          `candidate_embeddings?candidate_id=eq.${row.candidate_id}&source_type=eq.linkedin_profile&chunk_index=eq.0&select=embedding&limit=1`
        );
        if (ex?.embedding) profileVector = JSON.parse(ex.embedding);
      }
      const stored = await precomputeVerdicts(row, h, profileVector, username);
      verdictsStored += stored;
    } catch (err) {
      console.error(`precompute failed for ${row.candidate_id}:`, err.message);
    }

    await finishQueueRow(row, "done");
    refreshed++;
    console.log(`refreshed ${username || row.candidate_id} (priority ${row.priority})`);
  } catch (err) {
    failed++;
    console.error(`refresh failed for ${row.candidate_id}:`, err.message);
    await rest("candidate_enrichments", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        organization_id: org.id,
        candidate_id: row.candidate_id,
        linkedin_username: row.linkedin_username,
        provider: "harvest",
        operation: "full_profile",
        cache_status: "miss",
        status: "failed",
        cost_credits: 0,
      }),
    }).catch(() => {});
    await finishQueueRow(row, "failed").catch(() => {});
  }
}
console.log(`done: ${refreshed} refreshed, ${failed} failed, ${skipped} skipped, ${verdictsStored} verdicts precomputed`);
