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
if (!remaining) process.exit(0);

// Top up the queue with engaged candidates (priority 50) if it's running dry.
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

let refreshed = 0, failed = 0, skipped = 0;
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
console.log(`done: ${refreshed} refreshed, ${failed} failed, ${skipped} skipped`);
