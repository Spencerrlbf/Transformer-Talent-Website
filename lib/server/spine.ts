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
  /** Whose spend this is; default the site's own organization. A client
   *  company's applicant records spend only (no candidate, no payload). */
  orgId?: string;
}): Promise<void> {
  try {
    const orgId = args.orgId ?? (await getOrgId());
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

// ---------- The candidates row from a Harvest profile ----------

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const cleanText = (s: unknown): string | null =>
  typeof s === "string" ? s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ").replace(/\s+/g, " ").trim() || null : null;

/** A "position" that is a membership or side role, not the job: a council
 *  membership, an advisory seat, a board, mentoring, volunteering, angel
 *  investing. "Member of Technical Staff", "Member Software Engineer" and
 *  "Founding Member" are jobs, not memberships. */
export const SIDE_ROLE = /\b((?<!founding\s)member(?!\s+(of\s+(the\s+)?(technical|engineering|research|professional)\s+staff|software|technical|engineering))|membership|advisor|advisory|board|mentor|mentoring|volunteer|ambassador|investor|council)\b/i;

interface HarvestEducation {
  schoolName?: string;
  title?: string;
  degree?: string;
  fieldOfStudy?: string;
}

/** The candidates columns a refreshed LinkedIn profile replaces, in the
 *  shapes the pool already stores (the same as scripts/sync-directory.mjs
 *  writes for directory people): positions newest first with month-name
 *  dates, "School - Degree in Field" education lines, the summary and every
 *  skill. The judge, the signals and the Profile tab all read these, so a
 *  refresh that wrote only the title and company left them judging the old
 *  history (2026-09-25: 5,310 Network people on history up to a year old).
 *  Columns the profile has nothing for are left out, never blanked. */
export function harvestToPoolRecord(harvest: Record<string, unknown> | null): Record<string, unknown> {
  if (!harvest) return {};
  const out: Record<string, unknown> = {};
  const positions = harvestToExperiences(harvest).map((e) => ({
    title: cleanText(e.title),
    company: cleanText(e.company_name),
    duration: cleanText(e.duration_text),
    location: cleanText(e.location),
    is_current: e.is_current === true,
    start_date: e.start_year ? { year: e.start_year, month: e.start_month ? MONTH_NAMES[e.start_month - 1] : null } : null,
    end_date: e.end_year && !e.is_current ? { year: e.end_year, month: e.end_month ? MONTH_NAMES[e.end_month - 1] : null } : null,
    description: cleanText(e.description),
    company_linkedin_url: cleanText(e.company_linkedin_url),
  })).filter((p) => p.title || p.company);
  // LinkedIn can list side roles above the job ("Official Member, Forbes
  // Technology Council" above "Principal Engineer, CrowdStrike"). Everything
  // that reads the first position as the person's job (the current title,
  // the role type, the level) should see the job, so it goes first: the
  // current one, else the latest (someone between jobs keeps their last
  // real title, never a membership). Its dates still say when it ended.
  const side = (p: { title: string | null; company: string | null }) => SIDE_ROLE.test(`${p.title ?? ""} ${p.company ?? ""}`);
  let job = positions.findIndex((p) => p.is_current && !side(p));
  if (job < 0) job = positions.findIndex((p) => !side(p));
  if (job > 0) positions.unshift(...positions.splice(job, 1));
  if (positions.length) out.work_experience = positions;

  const edus = (Array.isArray(harvest.education) ? (harvest.education as HarvestEducation[]) : [])
    .map((e) => ({ school: cleanText(e?.schoolName ?? e?.title), degree: cleanText(e?.degree), field: cleanText(e?.fieldOfStudy) }))
    .filter((e) => e.school);
  if (edus.length) {
    out.education = edus
      .map((e) => (e.degree && e.field ? `${e.school} - ${e.degree} in ${e.field}` : e.degree ? `${e.school} - ${e.degree}` : e.field ? `${e.school} - ${e.field}` : e.school))
      .join("\n");
    out.education_schools = edus.map((e) => e.school);
    out.education_degrees = edus.map((e) => e.degree).filter(Boolean);
    out.education_fields = edus.map((e) => e.field).filter(Boolean);
  }

  const about = cleanText(harvest.about);
  if (about) out.profile_summary = about.slice(0, 5000);
  const headline = cleanText(harvest.headline);
  if (headline) out.headline = headline.slice(0, 500);
  const loc = harvest.location as { linkedinText?: string; parsed?: { text?: string } } | string | null | undefined;
  const locationText = cleanText(typeof loc === "string" ? loc : loc?.linkedinText || loc?.parsed?.text);
  if (locationText) out.location = locationText.slice(0, 200);
  const skills = (Array.isArray(harvest.skills) ? (harvest.skills as ({ name?: string } | string)[]) : [])
    .map((s) => cleanText(typeof s === "string" ? s : s?.name))
    .filter((s): s is string => !!s);
  if (skills.length) {
    out.top_skills = skills;
    out.all_skills_text = skills.join(", ");
  }
  const current = positions.find((p) => p.is_current && !side(p)) ?? positions[0];
  if (current?.title) out.current_title = current.title;
  if (current?.company) out.current_company = current.company;
  return out;
}

export async function syncExperiences(
  candidateId: string,
  harvest: Record<string, unknown> | null
): Promise<void> {
  try {
    const orgId = await getOrgId();
    const mapped = harvestToExperiences(harvest);
    if (!orgId || !mapped.length) return;

    // A profile can list the same position twice (same company, title and
    // start); one upsert may not touch a key twice, so keep the first.
    const seen = new Set<string>();
    const unique = mapped.filter((m) => !seen.has(m.provider_experience_key) && !!seen.add(m.provider_experience_key));
    const rows = unique.map((m) => ({
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
// education — without logos/URNs noise. `whole` lifts the caps on the About
// text, each description and the number of positions: the judge reads the
// whole profile (a 16th position or the tail of a description is where the
// evidence sat, more than once); embeddings and other callers keep the caps.
export function linkedinProfileText(harvest: Record<string, unknown> | null, opts: { whole?: boolean } = {}): string {
  if (!harvest) return "";
  const whole = !!opts.whole;
  const parts: string[] = [];
  const h = harvest as Record<string, any>;
  if (h.headline) parts.push(String(h.headline));
  if (h.about) parts.push(whole ? String(h.about) : String(h.about).slice(0, 3000));
  const exp = (h.experience || []) as HarvestExperience[];
  const positions = Array.isArray(exp) ? exp : [];
  for (const e of whole ? positions : positions.slice(0, 15)) {
    const skills = Array.isArray(e.skills)
      ? e.skills.map((s: any) => (typeof s === "string" ? s : s?.name)).filter(Boolean).join(", ")
      : "";
    parts.push(
      [
        e.position || e.title,
        e.companyName || e.company ? `at ${e.companyName || e.company}` : "",
        e.duration,
        e.location,
        whole ? e.description || "" : (e.description || "").slice(0, 600),
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
