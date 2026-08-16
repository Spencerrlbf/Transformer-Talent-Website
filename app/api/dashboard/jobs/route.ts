import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";

// Org-scoped jobs list with applicant counts. Applications store role_ids as
// text[] of external ids, so counts are computed here from one fetch rather
// than per-role queries.
export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const [rolesRes, appsRes] = await Promise.all([
    sbRest(
      `org_roles?organization_id=eq.${member.org.id}&select=external_id,title,status,salary,locations,workplace,yoe,updated_at&order=status.asc,title.asc`
    ),
    sbRest(`website_applications?organization_id=eq.${member.org.id}&select=role_ids`),
  ]);
  if (!rolesRes.ok) return NextResponse.json({ error: "roles_unavailable" }, { status: 502 });

  const roles = (await rolesRes.json()) as {
    external_id: string;
    title: string;
    status: string;
    salary: string | null;
    locations: string[];
    workplace: string | null;
    yoe: string | null;
    updated_at: string;
  }[];
  const apps = appsRes.ok ? ((await appsRes.json()) as { role_ids: string[] | null }[]) : [];

  const counts = new Map<string, number>();
  for (const a of apps)
    for (const id of a.role_ids || []) counts.set(id, (counts.get(id) || 0) + 1);

  return NextResponse.json({
    jobs: roles.map((r) => ({
      id: r.external_id,
      title: r.title,
      status: r.status,
      salary: r.salary || "",
      locations: r.locations || [],
      workplace: r.workplace || "",
      yoe: r.yoe || "",
      applicants: counts.get(r.external_id) || 0,
    })),
  });
}
