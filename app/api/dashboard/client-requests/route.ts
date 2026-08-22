import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import { publishOrgRole, nextExternalId } from "@/lib/server/publish-role";
import type { RoleInput } from "@/lib/server/roles-pipeline";

export const maxDuration = 60;

// TT-only: client jobs whose owners asked for sourcing help, plus the
// one-click "copy to my jobs & link" action.

type ClientJobRow = {
  organization_id: string;
  external_id: string;
  title: string;
  salary: string | null;
  locations: string[] | null;
  workplace: string | null;
  visa: string | null;
  yoe: string | null;
  role_type: string | null;
  tech_stack: string | null;
  jd: RoleInput["jd"];
  description: string | null;
  skills: unknown;
  sourcing_requested_at: string | null;
};

async function requireTT(req: NextRequest) {
  const member = await requireMember(req);
  if (!member || member.org.slug !== "transformer-talent") return null;
  return member;
}

export async function GET(req: NextRequest) {
  const member = await requireTT(req);
  if (!member) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [reqRes, orgsRes, ttRes] = await Promise.all([
    sbRest(
      `org_roles?organization_id=neq.${member.org.id}&sourcing_requested=is.true&status=eq.open` +
        `&select=organization_id,external_id,title,sourcing_requested_at&order=sourcing_requested_at.desc`
    ),
    sbRest(`organizations?id=neq.${member.org.id}&select=id,name`),
    sbRest(`org_roles?organization_id=eq.${member.org.id}&linked_org_role=not.is.null&select=external_id,title,linked_org_role`),
  ]);
  const rows = reqRes.ok
    ? ((await reqRes.json()) as { organization_id: string; external_id: string; title: string; sourcing_requested_at: string | null }[])
    : [];
  const orgs = new Map(
    (orgsRes.ok ? ((await orgsRes.json()) as { id: string; name: string }[]) : []).map((o) => [o.id, o.name])
  );
  const ttLinks = ttRes.ok
    ? ((await ttRes.json()) as { external_id: string; title: string; linked_org_role: { orgId?: string; jobId?: string } | null }[])
    : [];

  return NextResponse.json({
    requests: rows.map((r) => {
      const linkedBy = ttLinks.find(
        (t) => t.linked_org_role?.orgId === r.organization_id && t.linked_org_role?.jobId === r.external_id
      );
      return {
        orgId: r.organization_id,
        orgName: orgs.get(r.organization_id) || "Client",
        jobId: r.external_id,
        title: r.title,
        requestedAt: r.sourcing_requested_at,
        linkedTo: linkedBy ? { id: linkedBy.external_id, title: linkedBy.title } : null,
      };
    }),
  });
}

// Copy a client's job into TT's jobs (their JD, skills and all) and link it.
export async function POST(req: NextRequest) {
  const member = await requireTT(req);
  if (!member) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { orgId?: unknown; jobId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const orgId = String(body.orgId ?? "");
  const jobId = String(body.jobId ?? "").slice(0, 40);
  if (!/^[0-9a-f-]{36}$/.test(orgId) || !jobId || orgId === member.org.id)
    return NextResponse.json({ error: "bad_target" }, { status: 400 });

  const res = await sbRest(
    `org_roles?organization_id=eq.${orgId}&external_id=eq.${encodeURIComponent(jobId)}` +
      `&select=organization_id,external_id,title,salary,locations,workplace,visa,yoe,role_type,tech_stack,jd,description,skills,sourcing_requested_at&limit=1`
  );
  const [src] = res.ok ? ((await res.json()) as ClientJobRow[]) : [];
  if (!src) return NextResponse.json({ error: "target_job_not_found" }, { status: 404 });

  const externalId = await nextExternalId(member.org.id);
  const role: RoleInput = {
    jobId: externalId,
    title: src.title,
    description: src.description || null,
    jd: src.jd || null,
    roleType: src.role_type || "",
    yoe: src.yoe || "",
    visa: src.visa || "",
    workplace: src.workplace || "",
    locations: src.locations || [],
    techStack: src.tech_stack || "",
    salary: src.salary || "",
  };
  const skills = Array.isArray(src.skills) ? (src.skills as { skill: string; must_have: boolean; alternates: string[] }[]) : [];
  try {
    await publishOrgRole(member.org.id, role, skills, "dashboard", member.userId);
  } catch (e) {
    console.error("copy client job failed", e);
    return NextResponse.json({ error: "copy_failed" }, { status: 502 });
  }
  const link = await sbRest(
    `org_roles?organization_id=eq.${member.org.id}&external_id=eq.${externalId}`,
    {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({ linked_org_role: { orgId, jobId } }),
    }
  );
  if (!link.ok) return NextResponse.json({ error: "link_failed" }, { status: 502 });

  return NextResponse.json({ id: externalId });
}
