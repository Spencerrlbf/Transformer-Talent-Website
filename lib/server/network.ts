// Network matches: the internal-only surface over the nightly pool matcher.
// match_verdicts (pool candidate × org role, scorecard-shaped verdicts) is
// aggregated person-first: one entry per pool person with all their matched
// roles. STRICTLY Transformer Talent's own view — the API layer refuses any
// other org, and nothing here is ever exposed on client dashboards. The
// "send" path is the only bridge to a client-visible surface: it creates a
// normal website_applications row marked source=transformer_talent, which
// renders in the job's pipeline as an applicant with the Via-TT badge.
import { sbRest, sbInsert } from "./supabase";
import { clientTag, clientReason, TAG_LABEL, type ClientTag } from "./client-reason";
import type { Scorecard } from "./scorecard";

export const TT_ORG_SLUG = "transformer-talent";

export type NetworkMatch = {
  jobId: string;
  title: string;
  company: string | null;
  salary: string | null;
  location: string | null;
  tag: ClientTag;
  tagLabel: string;
  reason: string;
  addedAt: string;
  sentAt: string | null; // already sent to this job via the send button
};

export type NetworkPerson = {
  candidateId: string;
  name: string;
  photoUrl: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  location: string | null;
  linkedinUrl: string | null;
  email: string | null;
  phone: string | null;
  years: number | null;
  latestMatchAt: string; // newest verdict — drives the "new" markers
  matches: NetworkMatch[]; // best fit first
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

const TAG_RANK: Record<ClientTag, number> = { strong: 0, possible: 1, stretch: 2 };

type VerdictRow = {
  candidate_id: string;
  org_role_id: string;
  source: string;
  created_at: string;
  verdict: { qualified?: boolean; scorecard?: Scorecard } | null;
};

type PoolRow = {
  id: string;
  full_name: string | null;
  current_title: string | null;
  current_company: string | null;
  headline: string | null;
  location: string | null;
  linkedin_url: string | null;
  linkedin_username: string | null;
  email: string | null;
  phone: string | null;
  profile_picture_url: string | null;
  calculated_experience_years: number | null;
  total_experience_years: number | null;
};

const POOL_COLS =
  "id,full_name,current_title,current_company,headline,location,linkedin_url," +
  "linkedin_username,email,phone,profile_picture_url,calculated_experience_years,total_experience_years";

async function fetchAll<T>(pathFor: (limit: number, offset: number) => string): Promise<T[]> {
  const LIMIT = 1000;
  const out: T[] = [];
  for (let offset = 0; ; offset += LIMIT) {
    const res = await sbRest(pathFor(LIMIT, offset));
    if (!res.ok) break;
    const batch = (await res.json()) as T[];
    out.push(...batch);
    if (batch.length < LIMIT) break;
  }
  return out;
}

type RoleInfo = { jobId: string; title: string; company: string | null; salary: string | null; location: string | null };

async function roleIndex(orgId: string): Promise<Map<string, RoleInfo>> {
  const res = await sbRest(
    `org_roles?organization_id=eq.${orgId}&select=id,external_id,title,company_name,salary,locations,workplace`
  );
  const rows: {
    id: string; external_id: string; title: string; company_name: string | null;
    salary: string | null; locations: string[] | null; workplace: string | null;
  }[] = res.ok ? await res.json() : [];
  const byId = new Map<string, RoleInfo>();
  for (const r of rows)
    byId.set(r.id, {
      jobId: r.external_id,
      title: r.title,
      company: str(r.company_name),
      salary: str(r.salary),
      location: [(r.locations || []).join(", ") || null, str(r.workplace)].filter(Boolean).join(" · ") || null,
    });
  return byId;
}

/** (candidateId|jobId) -> sent date, from via-TT applications. */
async function sentIndex(orgId: string): Promise<Map<string, string>> {
  const rows = await fetchAll<{ candidate_id: string | null; role_ids: string[] | null; created_at: string }>(
    (limit, offset) =>
      `website_applications?organization_id=eq.${orgId}&source=eq.transformer_talent` +
      `&select=candidate_id,role_ids,created_at&limit=${limit}&offset=${offset}`
  );
  const map = new Map<string, string>();
  for (const r of rows)
    for (const jobId of r.role_ids || [])
      if (r.candidate_id && !map.has(`${r.candidate_id}|${jobId}`))
        map.set(`${r.candidate_id}|${jobId}`, r.created_at);
  return map;
}

export async function listNetworkMatches(
  orgId: string,
  jobId?: string
): Promise<{ people: NetworkPerson[]; total: number }> {
  const [verdicts, roles, sent] = await Promise.all([
    fetchAll<VerdictRow>(
      (limit, offset) =>
        `match_verdicts?organization_id=eq.${orgId}` +
        `&select=candidate_id,org_role_id,source,created_at,verdict` +
        `&order=created_at.desc&limit=${limit}&offset=${offset}`
    ),
    roleIndex(orgId),
    sentIndex(orgId),
  ]);

  // Newest verdict per (person, role); only scorecard-bearing rows render.
  const seen = new Set<string>();
  const byPerson = new Map<string, NetworkMatch[]>();
  const latest = new Map<string, string>();
  for (const v of verdicts) {
    const role = roles.get(v.org_role_id);
    const sc = v.verdict?.scorecard;
    if (!role || !v.candidate_id || !sc) continue;
    const key = `${v.candidate_id}|${role.jobId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tag = clientTag(sc);
    const list = byPerson.get(v.candidate_id) || [];
    list.push({
      jobId: role.jobId,
      title: role.title,
      company: role.company,
      salary: role.salary,
      location: role.location,
      tag,
      tagLabel: TAG_LABEL[tag],
      reason: clientReason(sc),
      addedAt: v.created_at,
      sentAt: sent.get(key) ?? null,
    });
    byPerson.set(v.candidate_id, list);
    if (!latest.has(v.candidate_id) || v.created_at > latest.get(v.candidate_id)!)
      latest.set(v.candidate_id, v.created_at);
  }

  // Pool details, chunked (PostgREST in-list limits).
  const ids = [...byPerson.keys()];
  const pool = new Map<string, PoolRow>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const res = await sbRest(
      `candidates?id=in.(${chunk.map((x) => `"${x}"`).join(",")})&select=${POOL_COLS}`
    );
    for (const r of (res.ok ? await res.json() : []) as PoolRow[]) pool.set(r.id, r);
  }

  let people: NetworkPerson[] = [];
  for (const [candidateId, matches] of byPerson) {
    const p = pool.get(candidateId);
    if (!p) continue;
    matches.sort(
      (a, b) => TAG_RANK[a.tag] - TAG_RANK[b.tag] || b.addedAt.localeCompare(a.addedAt)
    );
    people.push({
      candidateId,
      name: p.full_name || "Candidate",
      photoUrl: str(p.profile_picture_url),
      currentTitle: str(p.current_title) || str(p.headline),
      currentCompany: str(p.current_company),
      location: str(p.location),
      linkedinUrl: str(p.linkedin_url),
      email: str(p.email),
      phone: str(p.phone),
      years: p.calculated_experience_years ?? p.total_experience_years ?? null,
      latestMatchAt: latest.get(candidateId) || matches[0].addedAt,
      matches,
    });
  }

  if (jobId) people = people.filter((p) => p.matches.some((m) => m.jobId === jobId));

  people.sort(
    (a, b) =>
      TAG_RANK[a.matches[0].tag] - TAG_RANK[b.matches[0].tag] ||
      b.latestMatchAt.localeCompare(a.latestMatchAt)
  );
  return { people, total: people.length };
}

export async function sendNetworkCandidate(
  orgId: string,
  candidateId: string,
  jobId: string
): Promise<{ ok: true; applicationId: string } | { ok: false; error: string }> {
  const roleRes = await sbRest(
    `org_roles?organization_id=eq.${orgId}&external_id=eq.${encodeURIComponent(jobId)}&select=id,title&limit=1`
  );
  const [role] = (roleRes.ok ? await roleRes.json() : []) as { id: string; title: string }[];
  if (!role) return { ok: false, error: "job_not_found" };

  const candRes = await sbRest(`candidates?id=eq.${candidateId}&select=${POOL_COLS}&limit=1`);
  const [cand] = (candRes.ok ? await candRes.json() : []) as PoolRow[];
  if (!cand) return { ok: false, error: "candidate_not_found" };

  // One send per (person, job) — the pipeline should never grow duplicates.
  const dupRes = await sbRest(
    `website_applications?organization_id=eq.${orgId}&candidate_id=eq.${candidateId}` +
      `&role_ids=cs.{"${jobId}"}&select=id&limit=1`
  );
  if (dupRes.ok && ((await dupRes.json()) as unknown[]).length > 0)
    return { ok: false, error: "already_sent" };

  // Richest stored profile: the newest raw Harvest full_profile from the
  // enrichment ledger — powers the drawer (photo, experience, education).
  const enrRes = await sbRest(
    `candidate_enrichments?candidate_id=eq.${candidateId}&operation=eq.full_profile` +
      `&raw_payload=not.is.null&select=raw_payload&order=created_at.desc&limit=1`
  );
  const [enr] = (enrRes.ok ? await enrRes.json() : []) as { raw_payload: Record<string, unknown> | null }[];

  // Their verdict for THIS role rides along in the apply-flow screening shape,
  // so the pipeline's fit tag + review render exactly like an applicant's.
  const vRes = await sbRest(
    `match_verdicts?organization_id=eq.${orgId}&candidate_id=eq.${candidateId}` +
      `&org_role_id=eq.${role.id}&select=verdict&order=created_at.desc&limit=1`
  );
  const [v] = (vRes.ok ? await vRes.json() : []) as { verdict: Record<string, unknown> | null }[];

  const inserted = await sbInsert<{ id: string }>(
    "website_applications",
    {
      organization_id: orgId,
      name: cand.full_name || "Candidate",
      email: cand.email || "",
      linkedin_url: cand.linkedin_url,
      linkedin_username: cand.linkedin_username,
      role_ids: [jobId],
      role_titles: [`${role.title} (#${jobId})`],
      status: "processed",
      source: "transformer_talent",
      candidate_id: candidateId,
      parsed_profile: {
        current_title: str(cand.current_title),
        current_company: str(cand.current_company),
        location: str(cand.location),
      },
      harvest_profile: enr?.raw_payload ?? null,
      screening: v?.verdict ? [{ ...v.verdict, job_id: jobId }] : null,
      contact: str(cand.email) || str(cand.phone) ? { email: str(cand.email), phone: str(cand.phone) } : null,
    },
    true
  ).catch((e) => {
    console.error("network send insert failed", e);
    return null;
  });
  if (!inserted?.id) return { ok: false, error: "insert_failed" };
  return { ok: true, applicationId: inserted.id };
}
