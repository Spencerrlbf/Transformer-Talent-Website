// Tenant board data: org lookup by slug, that org's open roles shaped like
// the site's Role type (so the apply pipeline treats both sources
// identically), and org-scoped role suggestions for applicants.
import { sbRest, sbRpc } from "./supabase";
import type { Role } from "@/lib/roles";
import type { MatchingProfile } from "./roles-pipeline";

export type BoardOrg = { id: string; slug: string; name: string };

// Tenant roles carry their matching profile along for gating.
export type BoardRole = Role & { matchingProfile: MatchingProfile | null };

export async function loadOrgBySlug(slug: string): Promise<BoardOrg | null> {
  if (!/^[a-z0-9-]{2,60}$/.test(slug)) return null;
  const res = await sbRest(`organizations?slug=eq.${slug}&select=id,slug,name`);
  if (!res.ok) return null;
  const [org] = await res.json();
  return org ?? null;
}

export async function loadOrgRoles(organizationId: string): Promise<BoardRole[]> {
  const res = await sbRest(
    `org_roles?organization_id=eq.${organizationId}&status=eq.open` +
      `&select=external_id,title,description,salary,locations,workplace,visa,yoe,role_type,tech_stack,industry,jd,matching_profile&order=title.asc`
  );
  if (!res.ok) return [];
  const rows = (await res.json()) as Record<string, unknown>[];
  return rows.map((r) => ({
    jobId: String(r.external_id),
    title: String(r.title || ""),
    description: String(r.description || ""),
    salary: String(r.salary || ""),
    locations: (r.locations as string[]) || [],
    techStack: String(r.tech_stack || ""),
    industry: String(r.industry || ""),
    workplace: String(r.workplace || ""),
    roleType: String(r.role_type || ""),
    equity: "",
    funding: "",
    teamSize: "",
    visa: String(r.visa || ""),
    yoe: String(r.yoe || ""),
    jd: (r.jd as Role["jd"]) || undefined,
    matchingProfile: (r.matching_profile as MatchingProfile) || null,
  }));
}

// Org-scoped vector suggestions (same result shape as matchRolesForApplicant;
// keyword channel is site-only for now — vector + screening carries tenants).
export async function matchOrgRolesForApplicant(
  vector: number[],
  organizationId: string
): Promise<{ job_id: string; title: string; similarity: number; keyword_hits: number }[]> {
  const rows = await sbRpc<
    { org_role_id: string; external_id: string; title: string; similarity: number }[]
  >("match_org_roles", {
    query_embedding: vector,
    match_count: 5,
    org_filter: organizationId,
  }).catch(() => []);
  return rows.map((r) => ({
    job_id: r.external_id,
    title: r.title,
    similarity: r.similarity,
    keyword_hits: 0,
  }));
}
