// Employer-dashboard candidate assembly: applicants (their inbound pipeline)
// and sourced candidates (endorsed pairings we bring them). Read-only over
// website_applications + match_verdicts, always org-scoped, and everything
// crossing to the client goes through client-reason — never raw verdicts.
import { sbRest } from "./supabase";
import { signResumeUrl } from "./applicants";
import { clientTag, clientReason, TAG_LABEL, type ClientTag } from "./client-reason";
import type { Scorecard } from "./scorecard";

export type DashCandidate = {
  applicationId: string;
  name: string;
  location: string | null;
  linkedinUrl: string | null;
  resumeUrl: string | null;
  preferredLocations: string[];
  appliedAt: string;
  roles: {
    jobId: string;
    title: string;
    tag: ClientTag | null;
    tagLabel: string | null;
    reason: string | null;
  }[];
};

export type SourcedCandidate = {
  name: string;
  title: string | null;
  company: string | null;
  location: string | null;
  linkedinUrl: string | null;
  jobId: string;
  jobTitle: string;
  note: string;
};

const TAG_RANK: Record<ClientTag, number> = { strong: 0, possible: 1, stretch: 2 };

type VerdictRow = {
  candidate_id: string;
  source: string;
  created_at: string;
  verdict: { qualified?: boolean; scorecard?: Scorecard } | null;
  org_roles: { external_id: string; title: string } | null;
};

async function orgVerdicts(orgId: string): Promise<VerdictRow[]> {
  // Verdicts join org_roles; inner join keeps only this org's roles.
  const res = await sbRest(
    `match_verdicts?select=candidate_id,source,created_at,verdict,org_roles!inner(external_id,title,organization_id)` +
      `&org_roles.organization_id=eq.${orgId}&order=created_at.desc`
  );
  return res.ok ? ((await res.json()) as VerdictRow[]) : [];
}

// Newest verdict per candidate x role — older generations are history.
function newestPerPairing(rows: VerdictRow[]): Map<string, VerdictRow> {
  const map = new Map<string, VerdictRow>();
  for (const v of rows) {
    const id = v.org_roles?.external_id;
    if (!id || !v.candidate_id) continue;
    const key = `${v.candidate_id}|${id}`;
    if (!map.has(key)) map.set(key, v);
  }
  return map;
}

export async function applicantsForOrg(
  orgId: string,
  jobId?: string
): Promise<DashCandidate[]> {
  const filter = jobId ? `&role_ids=cs.{"${jobId}"}` : "";
  const res = await sbRest(
    `website_applications?organization_id=eq.${orgId}${filter}` +
      `&select=id,name,linkedin_url,resume_path,preferred_locations,role_ids,role_titles,candidate_id,parsed_profile,created_at` +
      `&order=created_at.desc&limit=200`
  );
  if (!res.ok) return [];
  const apps = (await res.json()) as {
    id: string;
    name: string;
    linkedin_url: string | null;
    resume_path: string | null;
    preferred_locations: string[] | null;
    role_ids: string[] | null;
    role_titles: string[] | null;
    candidate_id: string | null;
    parsed_profile: { location?: string | null } | null;
    created_at: string;
  }[];
  if (!apps.length) return [];

  const pairings = newestPerPairing(await orgVerdicts(orgId));

  const out: DashCandidate[] = [];
  for (const a of apps) {
    const roleIds = (a.role_ids || []).filter((id) => !jobId || id === jobId);
    const roles = roleIds.map((id, i) => {
      const v = a.candidate_id ? pairings.get(`${a.candidate_id}|${id}`) : undefined;
      const sc = v?.verdict?.scorecard;
      const title =
        (a.role_titles || [])
          .find((t) => t.includes(`#${id}`))
          ?.replace(` (#${id})`, "") ||
        (a.role_titles || [])[i] ||
        `Role #${id}`;
      return {
        jobId: id,
        title,
        tag: sc ? clientTag(sc) : null,
        tagLabel: sc ? TAG_LABEL[clientTag(sc)] : null,
        reason: sc ? clientReason(sc) : null,
      };
    });
    out.push({
      applicationId: a.id,
      name: a.name,
      location: a.parsed_profile?.location || null,
      linkedinUrl: a.linkedin_url,
      resumeUrl: a.resume_path ? await signResumeUrl(a.resume_path) : null,
      preferredLocations: a.preferred_locations || [],
      appliedAt: a.created_at,
      roles,
    });
  }

  // Best tag first; unscored last; newest breaks ties.
  const bestRank = (c: DashCandidate) =>
    Math.min(...c.roles.map((r) => (r.tag ? TAG_RANK[r.tag] : 3)), 3);
  return out.sort(
    (a, b) =>
      bestRank(a) - bestRank(b) ||
      +new Date(b.appliedAt) - +new Date(a.appliedAt)
  );
}

// Endorsement-only candidates we bring: qualified precompute/stretch verdicts
// on this org's roles, excluding people already in their applicant pipeline.
export async function sourcedForOrg(
  orgId: string,
  jobId?: string
): Promise<SourcedCandidate[]> {
  const pairings = newestPerPairing(await orgVerdicts(orgId));

  const appsRes = await sbRest(
    `website_applications?organization_id=eq.${orgId}&select=candidate_id`
  );
  const applicantIds = new Set(
    appsRes.ok
      ? ((await appsRes.json()) as { candidate_id: string | null }[])
          .map((a) => a.candidate_id)
          .filter(Boolean)
      : []
  );

  const endorsed = [...pairings.values()].filter(
    (v) =>
      v.verdict?.qualified &&
      (v.source === "precompute" || v.source === "stretch") &&
      !applicantIds.has(v.candidate_id) &&
      (!jobId || v.org_roles?.external_id === jobId)
  );
  if (!endorsed.length) return [];

  const ids = [...new Set(endorsed.map((v) => v.candidate_id))];
  const candRes = await sbRest(
    `candidates?id=in.(${ids.map((i) => `"${i}"`).join(",")})` +
      `&select=id,full_name,current_title,current_company,location,linkedin_url`
  );
  const cands = new Map(
    (candRes.ok ? ((await candRes.json()) as Record<string, string | null>[]) : []).map((c) => [
      c.id,
      c,
    ])
  );

  return endorsed
    .map((v) => {
      const c = cands.get(v.candidate_id);
      if (!c) return null;
      return {
        name: (c.full_name as string) || "Candidate",
        title: (c.current_title as string) || null,
        company: (c.current_company as string) || null,
        location: (c.location as string) || null,
        linkedinUrl: (c.linkedin_url as string) || null,
        jobId: v.org_roles!.external_id,
        jobTitle: v.org_roles!.title,
        note: "Hand-picked from the Transformer Talent network and screened against this role.",
      };
    })
    .filter((x): x is SourcedCandidate => x !== null)
    .slice(0, 50);
}
