import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";

// Client companies + their jobs, for the link-picker on TT job pages.
// TT-only — 404 for everyone else, like the Network routes. Only jobs whose
// company asked TT for help (open, "ask for help" on) are listed, plus the
// jobs TT has already linked, so an existing link still shows its title.
// Companies with neither are not listed at all.
export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  if (member.org.slug !== "transformer-talent")
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [orgsRes, rolesRes, linksRes] = await Promise.all([
    sbRest(`organizations?id=neq.${member.org.id}&select=id,slug,name&order=name.asc`),
    sbRest(
      `org_roles?organization_id=neq.${member.org.id}&status=eq.open&sourcing_requested=is.true` +
        `&select=organization_id,external_id,title&order=title.asc`
    ),
    sbRest(`org_roles?organization_id=eq.${member.org.id}&linked_org_role=not.is.null&select=linked_org_role`),
  ]);
  const orgs = orgsRes.ok
    ? ((await orgsRes.json()) as { id: string; slug: string; name: string }[])
    : [];
  const roles = rolesRes.ok
    ? ((await rolesRes.json()) as { organization_id: string; external_id: string; title: string }[])
    : [];

  // Titles of the jobs TT is already linked to, asked-for or not.
  const links = linksRes.ok
    ? ((await linksRes.json()) as { linked_org_role: { orgId?: string; jobId?: string } | null }[])
    : [];
  for (const l of links) {
    const orgId = l.linked_org_role?.orgId;
    const jobId = l.linked_org_role?.jobId;
    if (!orgId || !jobId || !/^[0-9a-f-]{36}$/.test(orgId) || orgId === member.org.id) continue;
    if (roles.some((r) => r.organization_id === orgId && r.external_id === jobId)) continue;
    const r = await sbRest(
      `org_roles?organization_id=eq.${orgId}&external_id=eq.${encodeURIComponent(jobId)}&select=organization_id,external_id,title&limit=1`
    );
    const [row] = r.ok ? ((await r.json()) as { organization_id: string; external_id: string; title: string }[]) : [];
    if (row) roles.push(row);
  }

  return NextResponse.json({
    orgs: orgs
      .map((o) => ({
        id: o.id,
        slug: o.slug,
        name: o.name,
        jobs: roles
          .filter((r) => r.organization_id === o.id)
          .map((r) => ({ id: r.external_id, title: r.title })),
      }))
      .filter((o) => o.jobs.length > 0),
  });
}
