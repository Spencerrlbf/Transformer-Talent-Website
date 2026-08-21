import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";

// Client companies + their open jobs, for the link-picker on TT job pages.
// TT-only — 404 for everyone else, like the Network routes.
export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  if (member.org.slug !== "transformer-talent")
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [orgsRes, rolesRes] = await Promise.all([
    sbRest(`organizations?id=neq.${member.org.id}&select=id,slug,name&order=name.asc`),
    sbRest(
      `org_roles?organization_id=neq.${member.org.id}&status=eq.open&select=organization_id,external_id,title&order=title.asc`
    ),
  ]);
  const orgs = orgsRes.ok
    ? ((await orgsRes.json()) as { id: string; slug: string; name: string }[])
    : [];
  const roles = rolesRes.ok
    ? ((await rolesRes.json()) as { organization_id: string; external_id: string; title: string }[])
    : [];

  return NextResponse.json({
    orgs: orgs.map((o) => ({
      id: o.id,
      slug: o.slug,
      name: o.name,
      jobs: roles
        .filter((r) => r.organization_id === o.id)
        .map((r) => ({ id: r.external_id, title: r.title })),
    })),
  });
}
