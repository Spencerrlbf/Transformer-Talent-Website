import crypto from "node:crypto";
import { sbRest, sbInsert } from "./supabase";

// V2 data spine writers: enrichment ledger, per-position experiences, and
// multi-vector embeddings. All best-effort — a spine failure must never fail
// an application or a JD search.

const ORG_SLUG = "transformer-talent";
let cachedOrgId: string | null = null;

export async function getOrgId(): Promise<string | null> {
  if (cachedOrgId) return cachedOrgId;
  try {
    const res = await sbRest(`organizations?slug=eq.${ORG_SLUG}&select=id`);
    if (!res.ok) return null;
    const [row] = await res.json();
    cachedOrgId = row?.id ?? null;
    return cachedOrgId;
  } catch {
    return null;
  }
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// ---------- Enrichment ledger (the spend meter) ----------

export async function recordEnrichment(args: {
  candidateId: string | null;
  linkedinUsername: string | null;
  provider: string; // 'harvest' | 'llamaparse' | 'openai'
  operation: string; // 'full_profile' | 'resume_parse' | 'jd_parse'
  cacheStatus: "miss" | "hit";
  status?: "ok" | "failed";
  normalized?: unknown;
  raw?: unknown;
  costCredits?: number;
}): Promise<void> {
  try {
    const orgId = await getOrgId();
    if (!orgId) return;
    await sbInsert("candidate_enrichments", {
      organization_id: orgId,
      candidate_id: args.candidateId,
      linkedin_username: args.linkedinUsername,
      provider: args.provider,
      operation: args.operation,
      cache_status: args.cacheStatus,
      status: args.status || "ok",
      normalized_profile: args.normalized ?? null,
      raw_payload: args.raw ?? null,
      cost_credits: args.costCredits ?? 0,
    });
  } catch (err) {
    console.error("enrichment ledger write failed", err);
  }
}

// ---------- Per-position experiences from a Harvest profile ----------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
function monthNum(m: unknown): number | null {
  if (typeof m === "number") return m >= 1 && m <= 12 ? m : null;
  if (typeof m === "string") return MONTHS[m.slice(0, 3).toLowerCase()] ?? null;
  return null;
}

interface HarvestExperience {
  position?: string;
  title?: string;
  companyName?: string;
  company?: string;
  companyId?: string;
  companyLink?: string;
  companyLinkedinUrl?: string;
  employmentType?: string;
  location?: string;
  duration?: string;
  description?: string;
  skills?: { name?: string }[] | string[] | null;
  startDate?: { year?: number; month?: unknown; text?: string };
  endDate?: { year?: number; month?: unknown; text?: string };
}

// Pure converter shared by the DB sync and the in-request fact engine.
export function harvestToExperiences(harvest: Record<string, unknown> | null) {
  const list = (harvest?.experience || harvest?.experiences) as HarvestExperience[] | undefined;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 25).map((e, i) => {
    const title = e.position || e.title || null;
    const company = e.companyName || e.company || null;
    const skills = Array.isArray(e.skills)
      ? e.skills.map((s) => (typeof s === "string" ? s : s?.name || "")).filter(Boolean)
      : [];
    return {
      // Stable per-position key so re-enrichment updates in place.
      provider_experience_key: sha(
        [e.companyId, company, title, e.startDate?.text].filter(Boolean).join("|") || `idx-${i}`
      ).slice(0, 32),
      title,
      company_name: company,
      company_linkedin_url: e.companyLinkedinUrl || e.companyLink || null,
      employment_type: e.employmentType || null,
      location: e.location || null,
      start_month: monthNum(e.startDate?.month),
      start_year: e.startDate?.year ?? null,
      end_month: monthNum(e.endDate?.month),
      end_year: e.endDate?.year ?? null,
      is_current: /present/i.test(e.endDate?.text || "") || (!e.endDate?.year && i === 0),
      duration_text: e.duration || null,
      description: (e.description || "").slice(0, 8000) || null,
      skills,
      raw: e,
      sort_order: i,
    };
  });
}

export async function syncExperiences(
  candidateId: string,
  harvest: Record<string, unknown> | null
): Promise<void> {
  try {
    const orgId = await getOrgId();
    const mapped = harvestToExperiences(harvest);
    if (!orgId || !mapped.length) return;

    const rows = mapped.map((m) => ({
      organization_id: orgId,
      candidate_id: candidateId,
      source: "harvest",
      ...m,
      updated_at: new Date().toISOString(),
    }));

    const res = await sbRest("candidate_experiences?on_conflict=candidate_id,source,provider_experience_key", {
      method: "POST",
      body: JSON.stringify(rows),
      prefer: "resolution=merge-duplicates,return=minimal",
    });
    if (!res.ok) console.error("experiences upsert failed", res.status, await res.text());
  } catch (err) {
    console.error("experiences sync failed", err);
  }
}

// ---------- Multi-vector candidate embeddings ----------

export type EmbeddingSource = "linkedin_profile" | "resume" | "summary";

// Flatten a Harvest profile into embeddable text — positions, skills,
// education — without logos/URNs noise.
export function linkedinProfileText(harvest: Record<string, unknown> | null): string {
  if (!harvest) return "";
  const parts: string[] = [];
  const h = harvest as Record<string, any>;
  if (h.headline) parts.push(String(h.headline));
  if (h.about) parts.push(String(h.about).slice(0, 3000));
  const exp = (h.experience || []) as HarvestExperience[];
  for (const e of (Array.isArray(exp) ? exp : []).slice(0, 15)) {
    const skills = Array.isArray(e.skills)
      ? e.skills.map((s: any) => (typeof s === "string" ? s : s?.name)).filter(Boolean).join(", ")
      : "";
    parts.push(
      [
        e.position || e.title,
        e.companyName || e.company ? `at ${e.companyName || e.company}` : "",
        e.duration,
        e.location,
        (e.description || "").slice(0, 600),
        skills && `Skills: ${skills}`,
      ]
        .filter(Boolean)
        .join(". ")
    );
  }
  const skills = (h.skills || []) as { name?: string }[];
  if (Array.isArray(skills) && skills.length) {
    parts.push(`All skills: ${skills.map((s) => s?.name).filter(Boolean).join(", ")}`);
  }
  const edu = (h.education || []) as Record<string, any>[];
  for (const ed of (Array.isArray(edu) ? edu : []).slice(0, 4)) {
    parts.push(
      [ed.degree, ed.fieldOfStudy, ed.schoolName || ed.school, ed.period].filter(Boolean).join(", ")
    );
  }
  return parts.filter(Boolean).join("\n");
}

function chunk(text: string, size = 2800, max = 6): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest && out.length < max) {
    if (rest.length <= size) {
      out.push(rest);
      break;
    }
    // Prefer to break on a newline near the boundary.
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  return out.filter((c) => c.length >= 40);
}

// Replace-style sync: per source_type, unchanged chunks (same hash) are kept,
// superseded ones deleted, new ones embedded — re-applications cost nothing
// when content hasn't changed.
export async function syncCandidateEmbeddings(
  candidateId: string,
  sources: Partial<Record<EmbeddingSource, string>>
): Promise<void> {
  try {
    const orgId = await getOrgId();
    const key = process.env.OPENAI_API_KEY;
    if (!orgId || !key) return;

    const wanted: { source_type: string; chunk_index: number; content: string; content_hash: string }[] = [];
    for (const [sourceType, text] of Object.entries(sources)) {
      if (!text) continue;
      chunk(text).forEach((content, i) =>
        wanted.push({ source_type: sourceType, chunk_index: i, content, content_hash: sha(content) })
      );
    }
    if (!wanted.length) return;

    const touched = [...new Set(wanted.map((w) => w.source_type))];
    const existingRes = await sbRest(
      `candidate_embeddings?candidate_id=eq.${candidateId}&source_type=in.(${touched.join(",")})&select=id,source_type,chunk_index,content_hash`
    );
    const existing: { id: string; source_type: string; chunk_index: number; content_hash: string }[] =
      existingRes.ok ? await existingRes.json() : [];
    const keyOf = (r: { source_type: string; chunk_index: number; content_hash: string }) =>
      `${r.source_type}|${r.chunk_index}|${r.content_hash}`;
    const wantKeys = new Set(wanted.map(keyOf));
    const haveKeys = new Set(existing.map(keyOf));

    const stale = existing.filter((e) => !wantKeys.has(keyOf(e)));
    if (stale.length) {
      await sbRest(`candidate_embeddings?id=in.(${stale.map((s) => s.id).join(",")})`, {
        method: "DELETE",
        prefer: "return=minimal",
      });
    }

    const todo = wanted.filter((w) => !haveKeys.has(keyOf(w)));
    if (!todo.length) return;

    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: todo.map((t) => t.content.slice(0, 8000)),
      }),
    });
    if (!res.ok) {
      console.error("candidate embedding failed", res.status, await res.text());
      return;
    }
    const vectors = (await res.json()).data as { embedding: number[] }[];
    const insert = await sbRest("candidate_embeddings?on_conflict=candidate_id,source_type,chunk_index,content_hash", {
      method: "POST",
      body: JSON.stringify(
        todo.map((t, i) => ({
          organization_id: orgId,
          candidate_id: candidateId,
          ...t,
          model: "text-embedding-3-small",
          dimensions: 1536,
          embedding: JSON.stringify(vectors[i].embedding),
        }))
      ),
      prefer: "resolution=merge-duplicates,return=minimal",
    });
    if (!insert.ok) console.error("candidate embeddings insert failed", insert.status, await insert.text());
  } catch (err) {
    console.error("candidate embeddings sync failed", err);
  }
}

// ---------- Refresh queue ----------

// Candidates surfaced by a JD search are the ones worth refreshing first
// (priority 10). Skips anyone Harvest-enriched in the last 30 days.
export async function enqueueMatchedCandidates(candidateIds: string[]): Promise<void> {
  try {
    const ids = [...new Set(candidateIds)].slice(0, 20);
    if (!ids.length) return;
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    const res = await sbRest(
      `candidate_enrichments?candidate_id=in.(${ids.join(",")})&provider=eq.harvest&created_at=gte.${since}&select=candidate_id`
    );
    const recent = new Set(
      res.ok ? ((await res.json()) as { candidate_id: string }[]).map((r) => r.candidate_id) : []
    );
    await enqueueRefresh(
      ids
        .filter((id) => !recent.has(id))
        .map((id) => ({ candidateId: id, priority: 10, reason: "jd_match" }))
    );
  } catch (err) {
    console.error("matched-candidate enqueue failed", err);
  }
}

export async function enqueueRefresh(
  items: {
    candidateId: string;
    linkedinUrl?: string | null;
    linkedinUsername?: string | null;
    priority: number; // 10 = matched in a JD search, 50 = engaged backfill
    reason: string;
  }[]
): Promise<void> {
  try {
    const orgId = await getOrgId();
    if (!orgId || !items.length) return;
    // unique(candidate_id, status) — already-queued candidates are skipped.
    await sbRest("refresh_queue?on_conflict=candidate_id,status", {
      method: "POST",
      body: JSON.stringify(
        items.map((i) => ({
          organization_id: orgId,
          candidate_id: i.candidateId,
          linkedin_url: i.linkedinUrl ?? null,
          linkedin_username: i.linkedinUsername ?? null,
          priority: i.priority,
          reason: i.reason,
          status: "queued",
        }))
      ),
      prefer: "resolution=ignore-duplicates,return=minimal",
    });
  } catch (err) {
    console.error("refresh enqueue failed", err);
  }
}
