// Candidates v2: applicants + sourced people unified into one org-scoped,
// sortable, paginated list, plus a per-person drawer detail and editable
// contact info. Read-time union over website_applications and the sourcing
// tables — no data migration, and the existing modules are called, not
// modified. Everything client-facing goes through client-reason or the
// stored judge reasons; raw verdicts and internal scores never cross here.
import { sbRest } from "./supabase";
import { signResumeUrl } from "./applicants";
import { clientTag, clientReason, TAG_LABEL, type ClientTag } from "./client-reason";
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
  headline: string | null;
  location: string | null;
  source: "applied" | "sourced";
  viaTT: boolean; // future referral badge slot
  alsoSourced: boolean; // applicant who also appears in a sourcing run
  roles: UnifiedRole[];
  bestTag: string | null;
  bestTagLabel: string | null;
  snapshot: string;
  yearsExperience: number | null;
  addedAt: string;
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
  sort?: "fit" | "added" | "name" | "years";
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
};

export type UnifiedList = {
  items: UnifiedRow[];
  total: number; // rows matching filters (after Not-now handling)
  counts: { all: number; applied: number; sourced: number; notNow: number };
  page: number;
  pageSize: number;
};

export type ExperienceGroup = {
  company: string;
  logoUrl: string | null;
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

export type UnifiedContact = { email?: string | null; phone?: string | null; github?: string | null };

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
    via: "applied" | "sourced";
    tag: string | null;
    tagLabel: string | null;
    reason: string | null;
    addedAt: string;
  }[];
  experience: ExperienceGroup[];
  education: { school: string; logoUrl: string | null; degree: string | null; field: string | null; period: string | null }[];
  skills: string[];
  resumeUrl: string | null;
  hasResume: boolean;
  addedAt: string;
};

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

async function orgRoleIndex(orgId: string): Promise<Map<string, { jobId: string; title: string }>> {
  const res = await sbRest(`org_roles?organization_id=eq.${orgId}&select=id,external_id,title`);
  const rows: { id: string; external_id: string; title: string }[] = res.ok ? await res.json() : [];
  return new Map(rows.map((r) => [r.id, { jobId: r.external_id, title: r.title }]));
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
/* Snapshot lines                                                      */
/* ------------------------------------------------------------------ */

type ExpEntry = {
  position?: string;
  companyName?: string;
  companyLogo?: string;
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

function prevCompanies(exp: ExpEntry[]): string[] {
  const names: string[] = [];
  for (const e of exp) {
    const n = str(e.companyName);
    if (n && !names.includes(n)) names.push(n);
  }
  return names.slice(1, 3); // skip current employer
}

function sourcedSnapshot(person: SrcPerson, exp: ExpEntry[] | null): string {
  const parts: string[] = [];
  if (person.years_experience != null) parts.push(`${person.years_experience} yrs`);
  const prev = exp ? prevCompanies(exp) : [];
  if (prev.length) parts.push(`prev: ${prev.join(", ")}`);
  const skills = person.skills || [];
  if (skills.length)
    parts.push(`${skills.slice(0, 2).join(", ")}${skills.length > 2 ? ` +${skills.length - 2}` : ""}`);
  return parts.join(" · ");
}

function applicantSnapshot(a: AppRow): string {
  const parts: string[] = [];
  const loc = str(a.parsed_profile?.location);
  if (loc) parts.push(loc);
  if (a.resume_path) parts.push("resume on file");
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ */
/* The unified list                                                    */
/* ------------------------------------------------------------------ */

export async function listUnifiedCandidates(params: UnifiedListParams): Promise<UnifiedList> {
  const { orgId } = params;
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 25));

  const [apps, pairings, memberships, roleIdx] = await Promise.all([
    fetchApplicants(orgId),
    orgVerdictPairings(orgId),
    fetchMemberships(orgId),
    orgRoleIndex(orgId),
  ]);
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
        roles.push({ ...role, via: "sourced", tag: m.tag, tagLabel: labelOf(m.tag) });
      }
    }
    const best = bestOf(roles);
    rows.push({
      key: `app_${a.id}`,
      name: a.name,
      headline:
        [str(a.parsed_profile?.current_title), str(a.parsed_profile?.current_company)]
          .filter(Boolean)
          .join(" @ ") || null,
      location: str(a.parsed_profile?.location),
      source: "applied",
      viaTT: a.source === "transformer_talent",
      alsoSourced: !!sourcedId,
      roles,
      bestTag: best.tag,
      bestTagLabel: labelOf(best.tag),
      snapshot: applicantSnapshot(a),
      yearsExperience: null,
      addedAt: a.created_at,
    });
  }

  for (const [personId, ms] of byPerson) {
    if (consumedSourced.has(personId)) continue;
    const p = people.get(personId);
    if (!p) continue;
    const roles: UnifiedRole[] = [];
    for (const m of ms) {
      const role = roleIdx.get(m.sourcing_runs!.org_role_id);
      if (role) roles.push({ ...role, via: "sourced", tag: m.tag, tagLabel: labelOf(m.tag) });
    }
    if (!roles.length) continue;
    const best = bestOf(roles);
    rows.push({
      key: `src_${p.id}`,
      name: p.full_name || "Candidate",
      headline:
        [str(p.current_title), str(p.current_company)].filter(Boolean).join(" @ ") ||
        str(p.headline),
      location: p.location,
      source: "sourced",
      viaTT: false,
      alsoSourced: false,
      roles,
      bestTag: best.tag,
      bestTagLabel: labelOf(best.tag),
      snapshot: "", // filled for the returned page only (needs profile JSON)
      yearsExperience: p.years_experience,
      addedAt: ms[ms.length - 1]?.created_at || p.created_at,
    });
  }

  // ---- filters ----
  let visible = rows;
  if (params.jobId) visible = visible.filter((r) => r.roles.some((x) => x.jobId === params.jobId));
  if (params.q) {
    const q = params.q.toLowerCase();
    visible = visible.filter(
      (r) => r.name.toLowerCase().includes(q) || (r.headline || "").toLowerCase().includes(q)
    );
  }

  const notNow = visible.filter((r) => rankOf(r.bestTag) === FIT_RANK.not_now);
  const actionable = visible.filter((r) => rankOf(r.bestTag) !== FIT_RANK.not_now);
  const counts = {
    all: actionable.length,
    applied: actionable.filter((r) => r.source === "applied").length,
    sourced: actionable.filter((r) => r.source === "sourced").length,
    notNow: notNow.length,
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

  // ---- snapshot enrichment for this page's sourced rows only ----
  const srcIds = items.filter((r) => r.key.startsWith("src_")).map((r) => r.key.slice(4));
  if (srcIds.length) {
    const res = await sbRest(
      `sourced_candidates?id=in.(${srcIds.map((i) => `"${i}"`).join(",")})&select=id,experience:profile->experience`
    );
    const exps = new Map<string, ExpEntry[]>(
      (res.ok ? ((await res.json()) as { id: string; experience: ExpEntry[] | null }[]) : []).map(
        (r) => [r.id, Array.isArray(r.experience) ? r.experience : []]
      )
    );
    for (const item of items) {
      if (!item.key.startsWith("src_")) continue;
      const p = people.get(item.key.slice(4));
      if (p) item.snapshot = sourcedSnapshot(p, exps.get(p.id) ?? null);
    }
  }

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
        logoUrl: str(e.companyLogo),
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
  schoolLogo?: string;
  degree?: string;
  fieldOfStudy?: string;
  period?: string;
};

type HarvestProfile = {
  photo?: string;
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
    photoUrl: str(p.photo),
    about: str(p.about),
    experience: groupExperience(Array.isArray(p.experience) ? p.experience : []),
    education: (Array.isArray(p.education) ? p.education : []).map((e) => ({
      school: str(e.schoolName) || "—",
      logoUrl: str(e.schoolLogo),
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
  roleIdx: Map<string, { jobId: string; title: string }>
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
      ...role,
      via: "sourced",
      tag: m.tag,
      tagLabel: labelOf(m.tag),
      reason: m.reason,
      addedAt: m.created_at,
    });
  }
  return out;
}

function applicantPipeline(a: AppRow, pairings: Map<string, VerdictRow>): UnifiedDetail["pipeline"] {
  return (a.role_ids || []).map((jobId, i) => {
    const sc = a.candidate_id ? pairings.get(`${a.candidate_id}|${jobId}`)?.verdict?.scorecard : undefined;
    const tag: ClientTag | null = sc ? clientTag(sc) : null;
    return {
      jobId,
      title: appRoleTitle(a, jobId, i),
      via: "applied" as const,
      tag,
      tagLabel: tag ? TAG_LABEL[tag] : null,
      reason: sc ? clientReason(sc) : null,
      addedAt: a.created_at,
    };
  });
}

const fmtDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export async function unifiedCandidateDetail(orgId: string, key: string): Promise<UnifiedDetail | null> {
  const roleIdx = await orgRoleIndex(orgId);

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
      for (const entry of applicantPipeline(app, pairings))
        if (!covered.has(entry.jobId)) pipeline.unshift(entry);
    }

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
    const pipeline = applicantPipeline(a, pairings);

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
  return out;
};

export async function saveUnifiedContact(
  orgId: string,
  key: string,
  contact: UnifiedContact
): Promise<{ contact?: UnifiedContact; error?: string }> {
  const cleaned = cleanContact(contact);
  if ("error" in cleaned) return { error: cleaned.error };

  const target = key.startsWith("src_")
    ? `sourced_candidates?id=eq.${key.slice(4)}&organization_id=eq.${orgId}`
    : key.startsWith("app_")
      ? `website_applications?id=eq.${key.slice(4)}&organization_id=eq.${orgId}`
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
