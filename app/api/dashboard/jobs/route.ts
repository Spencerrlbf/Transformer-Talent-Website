import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import { publishOrgRole, nextExternalId, sanitizeSkills } from "@/lib/server/publish-role";
import { roleInputFromBody } from "@/lib/server/job-body";

export const maxDuration = 60;

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

// Create a job: form fields -> matching profile + screening questions ->
// org_roles row -> embeddings -> live. All generation via roles-pipeline.
export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const skills = sanitizeSkills(body.skills);
  const parsed = roleInputFromBody(body, skills);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (skills.length === 0)
    return NextResponse.json({ error: "at_least_one_skill" }, { status: 400 });

  const externalId = await nextExternalId(member.org.id);
  const role = { ...parsed.role, jobId: externalId };
  try {
    await publishOrgRole(member.org.id, role, skills, "dashboard", member.userId);
  } catch (e) {
    console.error("publish role failed", e);
    return NextResponse.json({ error: "publish_failed" }, { status: 502 });
  }
  return NextResponse.json({ id: externalId });
}
