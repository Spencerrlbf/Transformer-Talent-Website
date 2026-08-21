// Candidates v2: applicants + sourced people unified into one org-scoped,
// sortable, paginated list, plus a per-person drawer detail and editable
// contact info. Read-time union over website_applications and the sourcing
// tables — no data migration, and the existing modules are called, not
// modified. Everything client-facing goes through client-reason or the
// stored judge reasons; raw verdicts and internal scores never cross here.
import { sbRest } from "./supabase";
import { signResumeUrl } from "./applicants";
import { clientTag, clientReason, TAG_LABEL, type ClientTag } from "./client-reason";
import { poolEmails } from "./network";
import type { Scorecard } from "./scorecard";

/* ------------------------------------------------------------------ */
/* Fit vocabulary: both engines' tags share one display + sort order.  */
/* ------------------------------------------------------------------ */

export const FIT_LABEL: Record<string, string> = {
  strong_yes: "Strong yes",
  strong: "Strong fit",
  yes: "Yes",
  possible: "Worth a look",
  worth_message: "Worth a message",
  stretch: "Likely a stretch",
  not_now: "Not now",
};

const FIT_RANK: Record<string, number> = {
  strong_yes: 0,
  strong: 0,
  yes: 1,
  possible: 2,
  worth_message: 3,
  stretch: 4,
  not_now: 5,
};

const PENDING_RANK = 6;
const rankOf = (tag: string | null | undefined): number =>
  tag ? (FIT_RANK[tag] ?? PENDING_RANK) : PENDING_RANK;
const labelOf = (tag: string | null | undefined): string | null =>
  tag ? (FIT_LABEL[tag] ?? null) : null;

// Fit-filter groups the UI can ask for.
const FIT_GROUPS: Record<string, string[]> = {
  strong: ["strong_yes", "strong"],
  yes: ["yes"],
  look: ["possible"],
  message: ["worth_message"],
  stretch: ["stretch"],
  not_now: ["not_now"],
};

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

export type UnifiedRole = {
  jobId: string;
  title: string;
  via: "applied" | "sourced";
  tag: string | null;
  tagLabel: string | null;
};

export type UnifiedRow = {
  key: string; // "app_<id>" | "src_<id>"
  name: string;
  photoUrl: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  location: string | null;
  linkedinUrl: string | null;
  contact: { email: string | null; phone: string | null };
  source: "applied" | "sourced";
  viaTT: boolean; // future referral badge slot
  alsoSourced: boolean; // applicant who also appears in a sourcing run
  roles: UnifiedRole[]; // drives job filtering; rendered in the drawer's Pipeline tab
  bestTag: string | null;
  bestTagLabel: string | null;
  yearsExperience: number | null;
  addedAt: string;
  /** Human pipeline status for params.jobId ("new" default); null in pool view. */
  stage: string | null;
};

// Human pipeline statuses — distinct from the AI fit tag. "rejected" moves a
// candidate from the job's Pipeline list to its Past tab.
export const STAGES = ["new", "contacted", "replied", "interviewing", "offer", "hired", "rejected"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABEL: Record<Stage, string> = {
  new: "New",
  contacted: "Contacted",
  replied: "Replied",
  interviewing: "Interviewing",
  offer: "Offer",
  hired: "Hired",
  rejected: "Rejected",
};

export type UnifiedListParams = {
  orgId: string;
  source?: "applied" | "sourced";
  jobId?: string; // org_roles.external_id
  fit?: string; // key of FIT_GROUPS, or "pending"
  q?: string;
  // "Not now" is a per-role judgment, not a judgment on the person: the
  // role-scoped job view hides them by default; the pool view shows everyone.
  hideNotNow?: boolean;
  /** With jobId: return ONLY rejected candidates (the Past tab). */
  past?: boolean;
  sort?: "fit" | "added" | "name" | "years";
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
};

export type UnifiedList = {
  items: UnifiedRow[];
  total: number; // rows matching filters (after Not-now handling)
  counts: { all: number; applied: number; sourced: number; notNow: number; rejected: number };
  page: number;
  pageSize: number;
};

export type ExperienceGroup = {
  company: string;
  logoUrl: string | null; // LinkedIn CDN logo (may expire; UI falls back to a letter tile)
  companyLinkedinUrl: string | null;
  span: string | null;
  roles: {
    title: string;
    dates: string | null;
    duration: string | null;
    location: string | null;
    employmentType: string | null;
    description: string | null;
  }[];
};

export type UnifiedContact = {
  email?: string | null; // primary — what sends and list rows use
  phone?: string | null;
  github?: string | null;
  otherEmails?: string[] | null; // additional addresses, user-manageable
};

export type UnifiedDetail = {
  key: string;
  name: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  photoUrl: string | null;
  about: string | null;
  source: "applied" | "sourced";
  viaTT: boolean;
  alsoSourced: boolean;
  provenance: string;
  contact: UnifiedContact;
  bestTag: string | null;
  bestTagLabel: string | null;
  pipeline: {
    jobId: string;
    title: string;
    company: string | null;
    salary: string | null;
    location: string | null;
    via: "applied" | "sourced";
    tag: string | null;
    tagLabel: string | null;
    reason: string | null;
    addedAt: string;
    stage: string;
  }[];
  experience: ExperienceGroup[];
  education: {
    school: string;
    logoUrl: string | null;
    linkedinUrl: string | null;
    degree: string | null;
    field: string | null;
    period: string | null;
  }[];
  skills: string[];
  resumeUrl: string | null;
  resumeName: string | null;
  hasResume: boolean;
  addedAt: string;
};

// "2026-08-20/<uuid>-Peter-Wang-Resume.pdf" -> "Peter-Wang-Resume.pdf"
export function resumeNameFromPath(path: string | null): string | null {
  if (!path) return null;
  const base = path.split("/").pop() || path;
  return base.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "") || base;
}

/* ------------------------------------------------------------------ */
/* Raw-row helpers                                                     */
/* ------------------------------------------------------------------ */

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function usernameFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = String(url).match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase().replace(/\/$/, "") : null;
}

type AppRow = {
  id: string;
  name: string;
  email: string | null;
  linkedin_url: string | null;
  linkedin_username: string | null;
  role_ids: string[] | null;
  role_titles: string[] | null;
  candidate_id: string | null;
  parsed_profile: { location?: string | null; current_title?: string | null; current_company?: string | null } | null;
  harvest_profile: Record<string, unknown> | null;
  resume_path: string | null;
  contact: UnifiedContact | null;
  source: string | null;
  created_at: string;
};

const APP_COLS =
  "id,name,email,linkedin_url,linkedin_username,role_ids,role_titles,candidate_id,parsed_profile,resume_path,contact,source,created_at";

type VerdictRow = {
  candidate_id: string;
  source: string;
  created_at: string;
  verdict: { qualified?: boolean; scorecard?: Scorecard } | null;
  org_roles: { external_id: string; title: string } | null;
};

async function orgVerdictPairings(orgId: string): Promise<Map<string, VerdictRow>> {
  const res = await sbRest(
    `match_verdicts?select=candidate_id,source,created_at,verdict,org_roles!inner(external_id,title,organization_id)` +
      `&org_roles.organization_id=eq.${orgId}&order=created_at.desc`
  );
  const rows: VerdictRow[] = res.ok ? await res.json() : [];
  const map = new Map<string, VerdictRow>();
  for (const v of rows) {
    const id = v.org_roles?.external_id;
    if (!id || !v.candidate_id) continue;
    const key = `${v.candidate_id}|${id}`;
    if (!map.has(key)) map.set(key, v); // newest first
  }
  return map;
}

function appRoleTitle(a: AppRow, jobId: string, i: number): string {
  return (
    (a.role_titles || []).find((t) => t.includes(`#${jobId}`))?.replace(` (#${jobId})`, "") ||
    (a.role_titles || [])[i] ||
    `Role #${jobId}`
  );
}

function appRoles(a: AppRow, pairings: Map<string, VerdictRow>): UnifiedRole[] {
  return (a.role_ids || []).map((jobId, i) => {
    const sc = a.candidate_id ? pairings.get(`${a.candidate_id}|${jobId}`)?.verdict?.scorecard : undefined;
    const tag: ClientTag | null = sc ? clientTag(sc) : null;
    return {
      jobId,
      title: appRoleTitle(a, jobId, i),
      via: "applied" as const,
      tag,
      tagLabel: tag ? TAG_LABEL[tag] : null,
    };
  });
}

async function fetchApplicants(orgId: string): Promise<AppRow[]> {
  const res = await sbRest(
    `website_applications?organization_id=eq.${orgId}&select=${APP_COLS}&order=created_at.desc&limit=500`
  );
  return res.ok ? await res.json() : [];
}

type SrcMembership = {
  tag: string | null;
  reason: string | null;
  created_at: string;
  sourced_candidate_id: string;
  sourcing_runs: { org_role_id: string } | null;
};

type SrcPerson = {
  id: string;
  full_name: string | null;
  headline: string | null;
  location: string | null;
  current_title: string | null;
  current_company: string | null;
  skills: string[] | null;
  years_experience: number | null;
  linkedin_username: string;
  linkedin_url: string | null;
  contact: UnifiedContact | null;
  resume_path: string | null;
  created_at: string;
};

const SRC_COLS =
  "id,full_name,headline,location,current_title,current_company,skills,years_experience,linkedin_username,linkedin_url,contact,resume_path,created_at";

// PostgREST caps result pages; loop until a short batch.
async function fetchAllPages<T>(pathFor: (limit: number, offset: number) => string): Promise<T[]> {
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

async function fetchMemberships(orgId: string, withReason = false): Promise<SrcMembership[]> {
  const cols = `tag,${withReason ? "reason," : ""}created_at,sourced_candidate_id,sourcing_runs!inner(org_role_id)`;
  return fetchAllPages<SrcMembership>(
    (limit, offset) =>
      `sourcing_run_candidates?organization_id=eq.${orgId}&hidden=is.false&select=${cols}` +
      `&order=created_at.desc&limit=${limit}&offset=${offset}`
  );
}

async function fetchSourcedPeople(orgId: string, ids?: string[]): Promise<Map<string, SrcPerson>> {
  const filter = ids
    ? `&id=in.(${ids.map((i) => `"${i}"`).join(",")})`
    : "";
  const rows = await fetchAllPages<SrcPerson>(
    (limit, offset) =>
      `sourced_candidates?organization_id=eq.${orgId}${filter}&select=${SRC_COLS}&limit=${limit}&offset=${offset}`
  );
  return new Map(rows.map((r) => [r.id, r]));
}

type RoleInfo = { jobId: string; title: string; company: string | null; salary: string | null; location: string | null };

async function orgRoleIndex(orgId: string): Promise<{
  byId: Map<string, RoleInfo>;
  byExternal: Map<string, RoleInfo>;
}> {
  const res = await sbRest(
    `org_roles?organization_id=eq.${orgId}&select=id,external_id,title,company_name,salary,locations,workplace`
  );
  const rows: {
    id: string;
    external_id: string;
    title: string;
    company_name: string | null;
    salary: string | null;
    locations: string[] | null;
    workplace: string | null;
  }[] = res.ok ? await res.json() : [];
  const byId = new Map<string, RoleInfo>();
  const byExternal = new Map<string, RoleInfo>();
  for (const r of rows) {
    const info: RoleInfo = {
      jobId: r.external_id,
      title: r.title,
      company: str(r.company_name),
      salary: str(r.salary),
      location:
        [(r.locations || []).join(", ") || null, str(r.workplace)].filter(Boolean).join(" · ") || null,
    };
    byId.set(r.id, info);
    byExternal.set(r.external_id, info);
  }
  return { byId, byExternal };
}

// Newest membership per (person, role) — older runs' verdicts are history.
function newestPerPersonRole(memberships: SrcMembership[]): Map<string, SrcMembership[]> {
  const seen = new Set<string>();
  const byPerson = new Map<string, SrcMembership[]>();
  for (const m of memberships) {
    const roleId = m.sourcing_runs?.org_role_id;
    if (!roleId) continue;
    const key = `${m.sourced_candidate_id}|${roleId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = byPerson.get(m.sourced_candidate_id) || [];
    list.push(m);
    byPerson.set(m.sourced_candidate_id, list);
  }
  return byPerson;
}

const bestOf = (roles: UnifiedRole[]): { tag: string | null; rank: number } => {
  let best: string | null = null;
  let bestRank = PENDING_RANK;
  for (const r of roles) {
    const rk = rankOf(r.tag);
    if (rk < bestRank) {
      bestRank = rk;
      best = r.tag;
    }
  }
  return { tag: best, rank: bestRank };
};

/* ------------------------------------------------------------------ */
/* Harvest profile fragments                                           */
/* ------------------------------------------------------------------ */

// LinkedIn media fields arrive either as a bare URL string or as an object
// {url, sizes:[{url,width,...}]}. Prefer a small variant for 40px tiles.
type LinkedinImage = string | { url?: string; sizes?: { url?: string; width?: number }[] } | null;

function logoFrom(v: LinkedinImage | undefined): string | null {
  if (!v) return null;
  if (typeof v === "string") return str(v);
  const small = (v.sizes || [])
    .filter((s) => s.url && (s.width ?? 0) >= 100)
    .sort((a, b) => (a.width ?? 0) - (b.width ?? 0))[0];
  return str(small?.url) || str(v.url);
}

type ExpEntry = {
  position?: string;
  companyName?: string;
  companyLogo?: LinkedinImage;
  companyLinkedinUrl?: string;
  startDate?: { text?: string } | string;
  endDate?: { text?: string } | string;
  duration?: string;
  location?: string;
  employmentType?: string;
  description?: string;
};

const dateText = (v: ExpEntry["startDate"]): string | null =>
  typeof v === "string" ? str(v) : str(v?.text);

/* ------------------------------------------------------------------ */
/* The unified list                                                    */
/* ------------------------------------------------------------------ */

/** candidate_key -> status for one job (only keys with an explicit row). */
async function jobStageMap(orgId: string, jobId: string): Promise<Map<string, string>> {
  const res = await sbRest(
    `candidate_role_statuses?organization_id=eq.${orgId}&job_id=eq.${encodeURIComponent(jobId)}` +
      `&select=candidate_key,status`
  );
  const rows: { candidate_key: string; status: string }[] = res.ok ? await res.json() : [];
  return new Map(rows.map((r) => [r.candidate_key, r.status]));
}

/** Overwrite pipeline entries' stages with this candidate's stored statuses. */
async function attachStages(
  orgId: string,
  key: string,
  pipeline: UnifiedDetail["pipeline"]
): Promise<void> {
  if (!pipeline.length) return;
  const res = await sbRest(
    `candidate_role_statuses?organization_id=eq.${orgId}&candidate_key=eq.${encodeURIComponent(key)}` +
      `&select=job_id,status`
  );
  const rows: { job_id: string; status: string }[] = res.ok ? await res.json() : [];
  const byJob = new Map(rows.map((r) => [r.job_id, r.status]));
  for (const entry of pipeline) entry.stage = byJob.get(entry.jobId) || "new";
}

export async function saveUnifiedStatus(
  orgId: string,
  key: string,
  jobId: string,
  status: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(STAGES as readonly string[]).includes(status)) return { ok: false, error: "bad_status" };
  const roleRes = await sbRest(
    `org_roles?organization_id=eq.${orgId}&external_id=eq.${encodeURIComponent(jobId)}&select=id&limit=1`
  );
  if (!roleRes.ok || ((await roleRes.json()) as unknown[]).length === 0)
    return { ok: false, error: "job_not_found" };
  const res = await sbRest(
    `candidate_role_statuses?on_conflict=organization_id,candidate_key,job_id`,
    {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: JSON.stringify({
        organization_id: orgId,
        candidate_key: key,
        job_id: jobId,
        status,
        updated_at: new Date().toISOString(),
      }),
    }
  );
  return res.ok ? { ok: true } : { ok: false, error: "save_failed" };
}

export async function listUnifiedCandidates(params: UnifiedListParams): Promise<UnifiedList> {
  const { orgId } = params;
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 25));

  const [apps, pairings, memberships, roleIndex] = await Promise.all([
    fetchApplicants(orgId),
    orgVerdictPairings(orgId),
    fetchMemberships(orgId),
    orgRoleIndex(orgId),
  ]);
  const roleIdx = roleIndex.byId;
  const byPerson = newestPerPersonRole(memberships);
  const people = await fetchSourcedPeople(orgId, [...byPerson.keys()]);

  // Applicants first; a sourced person who also applied collapses into the
  // applicant row (they raised their hand — the stronger signal).
  const consumedSourced = new Set<string>();
  const usernameToSourced = new Map<string, string>();
  for (const [id, p] of people) usernameToSourced.set(p.linkedin_username.toLowerCase(), id);

  const rows: UnifiedRow[] = [];

  for (const a of apps) {
    const roles = appRoles(a, pairings);
    const username = (a.linkedin_username || usernameFromUrl(a.linkedin_url) || "").toLowerCase();
    const sourcedId = username ? usernameToSourced.get(username) : undefined;
    if (sourcedId) {
      consumedSourced.add(sourcedId);
      const covered = new Set(roles.map((r) => r.jobId));
      for (const m of byPerson.get(sourcedId) || []) {
        const role = roleIdx.get(m.sourcing_runs!.org_role_id);
        if (!role || covered.has(role.jobId)) continue;
        roles.push({ jobId: role.jobId, title: role.title, via: "sourced", tag: m.tag, tagLabel: labelOf(m.tag) });
      }
    }
    const best = bestOf(roles);
    rows.push({
      key: `app_${a.id}`,
      name: a.name,
      photoUrl: null,
      currentTitle: str(a.parsed_profile?.current_title),
      currentCompany: str(a.parsed_profile?.current_company),
      location: str(a.parsed_profile?.location),
      linkedinUrl: a.linkedin_url,
      contact: {
        email: str(a.contact?.email) ?? str(a.email),
        phone: str(a.contact?.phone),
      },
      source: "applied",
      viaTT: a.source === "transformer_talent",
      alsoSourced: !!sourcedId,
      roles,
      bestTag: best.tag,
      bestTagLabel: labelOf(best.tag),
      yearsExperience: null,
      addedAt: a.created_at,
      stage: null,
    });
  }

  for (const [personId, ms] of byPerson) {
    if (consumedSourced.has(personId)) continue;
    const p = people.get(personId);
    if (!p) continue;
    const roles: UnifiedRole[] = [];
    for (const m of ms) {
      const role = roleIdx.get(m.sourcing_runs!.org_role_id);
      if (role)
        roles.push({ jobId: role.jobId, title: role.title, via: "sourced", tag: m.tag, tagLabel: labelOf(m.tag) });
    }
    if (!roles.length) continue;
    const best = bestOf(roles);
    rows.push({
      key: `src_${p.id}`,
      name: p.full_name || "Candidate",
      photoUrl: null,
      currentTitle: str(p.current_title) || str(p.headline),
      currentCompany: str(p.current_company),
      location: p.location,
      linkedinUrl: p.linkedin_url,
      contact: { email: str(p.contact?.email), phone: str(p.contact?.phone) },
      source: "sourced",
      viaTT: false,
      alsoSourced: false,
      roles,
      bestTag: best.tag,
      bestTagLabel: labelOf(best.tag),
      yearsExperience: p.years_experience,
      addedAt: ms[ms.length - 1]?.created_at || p.created_at,
      stage: null,
    });
  }

  // ---- filters ----
  let visible = rows;
  let rejectedCount = 0;
  if (params.jobId) {
    visible = visible.filter((r) => r.roles.some((x) => x.jobId === params.jobId));
    // Human statuses: attach this job's stage; "rejected" leaves the active
    // Pipeline list for the Past tab (params.past flips the split).
    const stages = await jobStageMap(orgId, params.jobId);
    for (const r of visible) r.stage = stages.get(r.key) || "new";
    const rejected = visible.filter((r) => r.stage === "rejected");
    rejectedCount = rejected.length;
    visible = params.past ? rejected : visible.filter((r) => r.stage !== "rejected");
  }
  if (params.q) {
    const q = params.q.toLowerCase();
    visible = visible.filter((r) =>
      [r.name, r.currentTitle, r.currentCompany]
        .some((v) => (v || "").toLowerCase().includes(q))
    );
  }

  const notNow = visible.filter((r) => rankOf(r.bestTag) === FIT_RANK.not_now);
  const actionable = visible.filter((r) => rankOf(r.bestTag) !== FIT_RANK.not_now);
  const counts = {
    all: actionable.length,
    applied: actionable.filter((r) => r.source === "applied").length,
    sourced: actionable.filter((r) => r.source === "sourced").length,
    notNow: notNow.length,
    rejected: rejectedCount,
  };

  let filtered = params.hideNotNow ? actionable : visible;
  if (params.source) filtered = filtered.filter((r) => r.source === params.source);
  if (params.fit) {
    if (params.fit === "pending") filtered = filtered.filter((r) => r.bestTag == null);
    else {
      const group = FIT_GROUPS[params.fit] || [params.fit];
      filtered = filtered.filter((r) => r.bestTag != null && group.includes(r.bestTag));
    }
  }

  // ---- sort ----
  const dir = params.dir === "asc" ? 1 : -1;
  const sort = params.sort || "fit";
  filtered.sort((a, b) => {
    if (sort === "name") return dir * a.name.localeCompare(b.name);
    if (sort === "added") return dir * a.addedAt.localeCompare(b.addedAt);
    if (sort === "years") {
      const ay = a.yearsExperience ?? -1;
      const by = b.yearsExperience ?? -1;
      return dir * (ay - by) || a.name.localeCompare(b.name);
    }
    // fit: best first regardless of dir, newest breaks ties
    return (
      rankOf(a.bestTag) - rankOf(b.bestTag) || b.addedAt.localeCompare(a.addedAt)
    );
  });

  const items = filtered.slice((page - 1) * pageSize, page * pageSize);

  // ---- photo enrichment for this page only (profile JSON is heavy) ----
  const srcIds = items.filter((r) => r.key.startsWith("src_")).map((r) => r.key.slice(4));
  const appIds = items.filter((r) => r.key.startsWith("app_")).map((r) => r.key.slice(4));
  const photos = new Map<string, string | null>();
  await Promise.all([
    (async () => {
      if (!srcIds.length) return;
      const res = await sbRest(
        `sourced_candidates?id=in.(${srcIds.map((i) => `"${i}"`).join(",")})&select=id,photo:profile->photo`
      );
      for (const r of (res.ok ? await res.json() : []) as { id: string; photo: LinkedinImage }[])
        photos.set(`src_${r.id}`, logoFrom(r.photo));
    })(),
    (async () => {
      if (!appIds.length) return;
      const res = await sbRest(
        `website_applications?id=in.(${appIds.map((i) => `"${i}"`).join(",")})&select=id,photo:harvest_profile->photo`
      );
      for (const r of (res.ok ? await res.json() : []) as { id: string; photo: LinkedinImage }[])
        photos.set(`app_${r.id}`, logoFrom(r.photo));
    })(),
  ]);
  for (const item of items) item.photoUrl = photos.get(item.key) ?? null;

  return { items, total: filtered.length, counts, page, pageSize };
}

/* ------------------------------------------------------------------ */
/* Drawer detail                                                       */
/* ------------------------------------------------------------------ */

function groupExperience(exp: ExpEntry[]): ExperienceGroup[] {
  const groups: ExperienceGroup[] = [];
  for (const e of exp) {
    const company = str(e.companyName) || "—";
    const last = groups[groups.length - 1];
    const role = {
      title: str(e.position) || "—",
      dates:
        [dateText(e.startDate), dateText(e.endDate) || "Present"].filter(Boolean).join(" – ") ||
        null,
      duration: str(e.duration),
      location: str(e.location),
      employmentType: str(e.employmentType),
      description: str(e.description),
    };
    if (last && last.company === company) {
      last.roles.push(role);
    } else {
      groups.push({
        company,
        logoUrl: logoFrom(e.companyLogo),
        companyLinkedinUrl: str(e.companyLinkedinUrl),
        span: null,
        roles: [role],
      });
    }
  }
  for (const g of groups) {
    if (g.roles.length > 1) {
      const newest = g.roles[0]?.dates?.split(" – ")[1] || null;
      const oldest = g.roles[g.roles.length - 1]?.dates?.split(" – ")[0] || null;
      g.span = oldest && newest ? `${oldest} – ${newest}` : null;
    } else {
      g.span = g.roles[0]?.dates || null;
    }
  }
  return groups;
}

type EduEntry = {
  schoolName?: string;
  schoolLogo?: LinkedinImage;
  schoolLinkedinUrl?: string;
  degree?: string;
  fieldOfStudy?: string;
  period?: string;
};

type HarvestProfile = {
  photo?: LinkedinImage;
  about?: string;
  linkedinUrl?: string;
  experience?: ExpEntry[];
  education?: EduEntry[];
  skills?: ({ name?: string } | string)[];
};

function profileBits(profile: HarvestProfile | null | undefined) {
  const p = profile || {};
  const skills = (Array.isArray(p.skills) ? p.skills : [])
    .map((s) => (typeof s === "string" ? s : str(s?.name)))
    .filter((s): s is string => !!s);
  return {
    photoUrl: logoFrom(p.photo),
    about: str(p.about),
    experience: groupExperience(Array.isArray(p.experience) ? p.experience : []),
    education: (Array.isArray(p.education) ? p.education : []).map((e) => ({
      school: str(e.schoolName) || "—",
      logoUrl: logoFrom(e.schoolLogo),
      linkedinUrl: str(e.schoolLinkedinUrl),
      degree: str(e.degree),
      field: str(e.fieldOfStudy),
      period: str(e.period),
    })),
    skills,
  };
}

async function sourcedPipeline(
  orgId: string,
  personId: string,
  roleIdx: Map<string, RoleInfo>
): Promise<UnifiedDetail["pipeline"]> {
  const memberships = await fetchAllPages<SrcMembership>(
    (limit, offset) =>
      `sourcing_run_candidates?organization_id=eq.${orgId}&sourced_candidate_id=eq.${personId}&hidden=is.false` +
      `&select=tag,reason,created_at,sourced_candidate_id,sourcing_runs!inner(org_role_id)` +
      `&order=created_at.desc&limit=${limit}&offset=${offset}`
  );
  const seen = new Set<string>();
  const out: UnifiedDetail["pipeline"] = [];
  for (const m of memberships) {
    const role = m.sourcing_runs?.org_role_id ? roleIdx.get(m.sourcing_runs.org_role_id) : undefined;
    if (!role || seen.has(role.jobId)) continue;
    seen.add(role.jobId);
    out.push({
      jobId: role.jobId,
      title: role.title,
      company: role.company,
      salary: role.salary,
      location: role.location,
      via: "sourced",
      tag: m.tag,
      tagLabel: labelOf(m.tag),
      reason: m.reason,
      addedAt: m.created_at,
      stage: "new",
    });
  }
  return out;
}

function applicantPipeline(
  a: AppRow,
  pairings: Map<string, VerdictRow>,
  byExternal?: Map<string, RoleInfo>
): UnifiedDetail["pipeline"] {
  return (a.role_ids || []).map((jobId, i) => {
    const sc = a.candidate_id ? pairings.get(`${a.candidate_id}|${jobId}`)?.verdict?.scorecard : undefined;
    const tag: ClientTag | null = sc ? clientTag(sc) : null;
    const info = byExternal?.get(jobId);
    return {
      jobId,
      title: appRoleTitle(a, jobId, i),
      company: info?.company ?? null,
      salary: info?.salary ?? null,
      location: info?.location ?? null,
      via: "applied" as const,
      tag,
      tagLabel: tag ? TAG_LABEL[tag] : null,
      reason: sc ? clientReason(sc) : null,
      addedAt: a.created_at,
      stage: "new",
    };
  });
}

const fmtDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export async function unifiedCandidateDetail(orgId: string, key: string): Promise<UnifiedDetail | null> {
  const { byId: roleIdx, byExternal } = await orgRoleIndex(orgId);

  // Pool person from the internal Network page. Profile comes from the
  // newest raw Harvest full_profile in the enrichment ledger; the pipeline
  // section shows their nightly network matches (display-only — no stages).
  if (key.startsWith("net_")) {
    const id = key.slice(4);
    const res = await sbRest(
      `candidates?id=eq.${id}&select=id,full_name,headline,location,linkedin_url,linkedin_username,` +
        `email,phone,contact,profile_picture_url,current_title,current_company,created_at&limit=1`
    );
    const [p] = (res.ok ? await res.json() : []) as {
      id: string; full_name: string | null; headline: string | null; location: string | null;
      linkedin_url: string | null; linkedin_username: string | null; email: string | null;
      phone: string | null; contact: UnifiedContact | null; profile_picture_url: string | null;
      current_title: string | null; current_company: string | null; created_at: string;
    }[];
    if (!p) return null;

    const [enrRes, vRes, emailMap] = await Promise.all([
      sbRest(
        `candidate_enrichments?candidate_id=eq.${id}&operation=eq.full_profile` +
          `&raw_payload=not.is.null&select=raw_payload&order=created_at.desc&limit=1`
      ),
      sbRest(
        `match_verdicts?organization_id=eq.${orgId}&candidate_id=eq.${id}` +
          `&select=org_role_id,created_at,verdict&order=created_at.desc`
      ),
      poolEmails([id], new Map([[id, p.contact?.email ?? p.email]])),
    ]);
    const [enr] = (enrRes.ok ? await enrRes.json() : []) as { raw_payload: HarvestProfile | null }[];
    const verdicts = (vRes.ok ? await vRes.json() : []) as {
      org_role_id: string; created_at: string;
      verdict: { scorecard?: Scorecard } | null;
    }[];

    const seenJobs = new Set<string>();
    const pipeline: UnifiedDetail["pipeline"] = [];
    for (const v of verdicts) {
      const role = roleIdx.get(v.org_role_id);
      const sc = v.verdict?.scorecard;
      if (!role || !sc || seenJobs.has(role.jobId)) continue;
      seenJobs.add(role.jobId);
      const tag = clientTag(sc);
      pipeline.push({
        jobId: role.jobId,
        title: role.title,
        company: role.company,
        salary: role.salary,
        location: role.location,
        via: "sourced",
        tag,
        tagLabel: TAG_LABEL[tag],
        reason: clientReason(sc),
        addedAt: v.created_at,
        stage: "new",
      });
    }

    const bits = profileBits(enr?.raw_payload ?? null);
    const best = bestOf(pipeline.map((x) => ({ ...x, via: x.via })));
    return {
      key,
      name: p.full_name || "Candidate",
      headline:
        str(p.headline) ||
        [str(p.current_title), str(p.current_company)].filter(Boolean).join(" @ ") ||
        null,
      location: str(p.location),
      linkedinUrl: str(p.linkedin_url) || (enr?.raw_payload?.linkedinUrl as string | undefined) || null,
      photoUrl: bits.photoUrl || str(p.profile_picture_url),
      about: bits.about,
      source: "sourced",
      viaTT: false,
      alsoSourced: false,
      provenance: `Matched from your talent pool by the nightly runs`,
      // Same contact shape as every other candidate (edit writes the pool's
      // contact overlay). otherEmails: user-curated list once saved; until
      // then, the verification tables' addresses minus the primary.
      contact: (() => {
        const primary = str(p.contact?.email) ?? (emailMap.get(id) || [])[0]?.email ?? null;
        const curated = Array.isArray(p.contact?.otherEmails) ? p.contact!.otherEmails! : null;
        const fallback = (emailMap.get(id) || [])
          .map((e) => e.email)
          .filter((e) => e.toLowerCase() !== (primary || "").toLowerCase());
        return {
          email: primary,
          phone: str(p.contact?.phone) ?? str(p.phone),
          github: str(p.contact?.github),
          otherEmails: curated ?? fallback,
        };
      })(),
      bestTag: best.tag,
      bestTagLabel: labelOf(best.tag),
      pipeline,
      experience: bits.experience,
      education: bits.education,
      skills: bits.skills,
      resumeUrl: null,
      resumeName: null,
      hasResume: false,
      addedAt: p.created_at,
    };
  }

  if (key.startsWith("src_")) {
    const id = key.slice(4);
    const res = await sbRest(
      `sourced_candidates?id=eq.${id}&organization_id=eq.${orgId}&select=${SRC_COLS},profile`
    );
    const [p] = (res.ok ? await res.json() : []) as (SrcPerson & { profile: HarvestProfile | null })[];
    if (!p) return null;

    const pipeline = await sourcedPipeline(orgId, id, roleIdx);

    // A sourced person who also applied: fold the application in.
    const appRes = await sbRest(
      `website_applications?organization_id=eq.${orgId}&linkedin_username=eq.${encodeURIComponent(
        p.linkedin_username
      )}&select=${APP_COLS}&order=created_at.desc&limit=1`
    );
    const [app] = (appRes.ok ? await appRes.json() : []) as AppRow[];
    if (app) {
      const pairings = await orgVerdictPairings(orgId);
      const covered = new Set(pipeline.map((x) => x.jobId));
      for (const entry of applicantPipeline(app, pairings, byExternal))
        if (!covered.has(entry.jobId)) pipeline.unshift(entry);
    }

    await attachStages(orgId, key, pipeline);
    const bits = profileBits(p.profile);
    const best = bestOf(pipeline.map((x) => ({ ...x, via: x.via })));
    const resumePath = app?.resume_path || p.resume_path;
    const firstRun = pipeline.filter((x) => x.via === "sourced").at(-1);
    return {
      key,
      name: p.full_name || "Candidate",
      headline: str(p.headline),
      location: p.location,
      linkedinUrl: p.linkedin_url || (p.profile?.linkedinUrl ?? null),
      photoUrl: bits.photoUrl,
      about: bits.about,
      source: app ? "applied" : "sourced",
      viaTT: app?.source === "transformer_talent",
      alsoSourced: !!app,
      provenance: firstRun
        ? `Imported from your "${firstRun.title}" sourcing run · ${fmtDate(firstRun.addedAt)}`
        : `Imported by a sourcing run · ${fmtDate(p.created_at)}`,
      contact: { ...(p.contact || {}), ...(app?.contact || {}), email: app?.contact?.email ?? p.contact?.email ?? app?.email ?? null },
      bestTag: best.tag,
      bestTagLabel: labelOf(best.tag),
      pipeline,
      experience: bits.experience,
      education: bits.education,
      skills: bits.skills.length ? bits.skills : p.skills || [],
      resumeUrl: resumePath ? await signResumeUrl(resumePath) : null,
      resumeName: resumeNameFromPath(resumePath ?? null),
      hasResume: !!resumePath,
      addedAt: p.created_at,
    };
  }

  if (key.startsWith("app_")) {
    const id = key.slice(4);
    const res = await sbRest(
      `website_applications?id=eq.${id}&organization_id=eq.${orgId}&select=${APP_COLS},harvest_profile`
    );
    const [a] = (res.ok ? await res.json() : []) as AppRow[];
    if (!a) return null;

    const pairings = await orgVerdictPairings(orgId);
    const pipeline = applicantPipeline(a, pairings, byExternal);

    // Fold in sourcing-run appearances (and the richer profile) if we also
    // imported this person through a run.
    const username = (a.linkedin_username || usernameFromUrl(a.linkedin_url) || "").toLowerCase();
    let sourced: (SrcPerson & { profile: HarvestProfile | null }) | undefined;
    if (username) {
      const sres = await sbRest(
        `sourced_candidates?organization_id=eq.${orgId}&linkedin_username=eq.${encodeURIComponent(
          username
        )}&select=${SRC_COLS},profile&limit=1`
      );
      [sourced] = (sres.ok ? await sres.json() : []) as (SrcPerson & { profile: HarvestProfile | null })[];
    }
    if (sourced) {
      const covered = new Set(pipeline.map((x) => x.jobId));
      for (const entry of await sourcedPipeline(orgId, sourced.id, roleIdx))
        if (!covered.has(entry.jobId)) pipeline.push(entry);
    }

    await attachStages(orgId, key, pipeline);
    const bits = profileBits(sourced?.profile || (a.harvest_profile as HarvestProfile | null));
    const best = bestOf(pipeline.map((x) => ({ ...x, via: x.via })));
    const resumePath = a.resume_path || sourced?.resume_path || null;
    return {
      key,
      name: a.name,
      headline:
        [str(a.parsed_profile?.current_title), str(a.parsed_profile?.current_company)]
          .filter(Boolean)
          .join(" @ ") || null,
      location: str(a.parsed_profile?.location),
      linkedinUrl: a.linkedin_url,
      photoUrl: bits.photoUrl,
      about: bits.about,
      source: "applied",
      viaTT: a.source === "transformer_talent",
      alsoSourced: !!sourced,
      provenance: `Applied via your board · ${fmtDate(a.created_at)}`,
      contact: { ...(sourced?.contact || {}), ...(a.contact || {}), email: a.contact?.email ?? sourced?.contact?.email ?? a.email ?? null },
      bestTag: best.tag,
      bestTagLabel: labelOf(best.tag),
      pipeline,
      experience: bits.experience,
      education: bits.education,
      skills: bits.skills,
      resumeUrl: resumePath ? await signResumeUrl(resumePath) : null,
      resumeName: resumeNameFromPath(resumePath ?? null),
      hasResume: !!resumePath,
      addedAt: a.created_at,
    };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Contact save                                                        */
/* ------------------------------------------------------------------ */

const cleanContact = (c: UnifiedContact): UnifiedContact | { error: string } => {
  const out: UnifiedContact = {};
  const email = str(c.email);
  const phone = str(c.phone);
  const github = str(c.github);
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160))
    return { error: "invalid_email" };
  if (phone && (phone.length > 40 || !/^[\d\s()+.\-#ext]*$/i.test(phone)))
    return { error: "invalid_phone" };
  if (github && github.length > 160) return { error: "invalid_github" };
  out.email = email || null;
  out.phone = phone || null;
  out.github = github || null;
  const seen = new Set<string>([(email || "").toLowerCase()]);
  const others: string[] = [];
  for (const raw of c.otherEmails || []) {
    const e = str(raw);
    if (!e) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 160) return { error: "invalid_email" };
    if (seen.has(e.toLowerCase())) continue;
    seen.add(e.toLowerCase());
    others.push(e);
    if (others.length >= 8) break;
  }
  out.otherEmails = others; // always an array on save — the list becomes curated
  return out;
};

export async function saveUnifiedContact(
  orgId: string,
  key: string,
  contact: UnifiedContact
): Promise<{ contact?: UnifiedContact; error?: string }> {
  const cleaned = cleanContact(contact);
  if ("error" in cleaned) return { error: cleaned.error };

  // net_ = pool candidate (TT-internal; the API route gates org access).
  const target = key.startsWith("src_")
    ? `sourced_candidates?id=eq.${key.slice(4)}&organization_id=eq.${orgId}`
    : key.startsWith("app_")
      ? `website_applications?id=eq.${key.slice(4)}&organization_id=eq.${orgId}`
      : key.startsWith("net_")
        ? `candidates?id=eq.${key.slice(4)}`
        : null;
  if (!target) return { error: "bad_key" };

  const res = await sbRest(target, {
    method: "PATCH",
    body: JSON.stringify({ contact: cleaned }),
    prefer: "return=representation",
  });
  if (!res.ok) return { error: "save_failed" };
  const rows = (await res.json()) as { contact: UnifiedContact }[];
  if (!rows.length) return { error: "not_found" };
  return { contact: rows[0].contact };
}

/* ------------------------------------------------------------------ */
/* Resume pointer save (upload itself lives in the route)              */
/* ------------------------------------------------------------------ */

export async function saveUnifiedResumePath(
  orgId: string,
  key: string,
  path: string
): Promise<boolean> {
  const target = key.startsWith("src_")
    ? `sourced_candidates?id=eq.${key.slice(4)}&organization_id=eq.${orgId}`
    : key.startsWith("app_")
      ? `website_applications?id=eq.${key.slice(4)}&organization_id=eq.${orgId}`
      : null;
  if (!target) return false;
  const res = await sbRest(target, {
    method: "PATCH",
    body: JSON.stringify({ resume_path: path }),
    prefer: "return=representation",
  });
  if (!res.ok) return false;
  return ((await res.json()) as unknown[]).length > 0;
}
