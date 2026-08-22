import { after, NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import { publishOrgRole, sanitizeSkills } from "@/lib/server/publish-role";
import { roleInputFromBody } from "@/lib/server/job-body";
import { sendEmail } from "@/lib/server/email";

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

async function loadJob(orgId: string, externalId: string) {
  const res = await sbRest(
    `org_roles?organization_id=eq.${orgId}&external_id=eq.${encodeURIComponent(externalId)}` +
      `&select=id,external_id,title,status,salary,locations,workplace,visa,yoe,role_type,tech_stack,jd,skills,source,updated_at,target_companies,company_name,linked_org_role,sourcing_requested&limit=1`
  );
  if (!res.ok) return null;
  const [row] = await res.json();
  return row ?? null;
}

export async function GET(req: NextRequest, { params }: Params) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const { id } = await params;
  const job = await loadJob(member.org.id, id);
  if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const appsRes = await sbRest(
    `website_applications?organization_id=eq.${member.org.id}&role_ids=cs.{"${job.external_id}"}&select=id`
  );
  const applicants = appsRes.ok ? ((await appsRes.json()) as unknown[]).length : 0;

  return NextResponse.json({
    job: {
      id: job.external_id,
      title: job.title,
      status: job.status,
      salary: job.salary || "",
      locations: job.locations || [],
      workplace: job.workplace || "",
      visa: job.visa || "",
      yoe: job.yoe || "",
      roleType: job.role_type || "",
      jd: job.jd || null,
      skills: job.skills || [],
      source: job.source,
      updatedAt: job.updated_at,
      applicants,
      targetCompanies: Array.isArray(job.target_companies) ? job.target_companies : [],
      companyName: job.company_name || "",
      linkedOrgRole: job.linked_org_role || null,
      sourcingRequested: !!job.sourcing_requested,
    },
  });
}

// --- Dashboard-owned fields: ideal companies + hiring company name. ---
// These never come from the role sync chain, so editing them is safe (and
// allowed) for synced roles too — unlike the JD fields below.
type TargetCompany = { name: string; linkedinUrl: string | null; logo: string | null };

function sanitizeTargets(v: unknown): TargetCompany[] | null {
  if (!Array.isArray(v) || v.length > 20) return null;
  const out: TargetCompany[] = [];
  for (const t of v) {
    if (!t || typeof t !== "object") return null;
    const { name, linkedinUrl, logo } = t as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim() || name.length > 120) return null;
    const url = typeof linkedinUrl === "string" && /^https:\/\/([a-z0-9-]+\.)?linkedin\.com\//i.test(linkedinUrl) ? linkedinUrl.slice(0, 300) : null;
    const logoUrl = typeof logo === "string" && /^https:\/\//i.test(logo) ? logo.slice(0, 500) : null;
    if (!out.some((x) => x.name.toLowerCase() === name.trim().toLowerCase()))
      out.push({ name: name.trim(), linkedinUrl: url, logo: logoUrl });
  }
  return out;
}

// Edit (full fields -> regenerate profile + embeddings) or status-only
// close/reopen. Editing is limited to dashboard-created roles — Notion-synced
// roles are owned by the sync chain and would be overwritten on next sync.
export async function PATCH(req: NextRequest, { params }: Params) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const { id } = await params;
  const job = await loadJob(member.org.id, id);
  if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  // Dashboard-owned fields first — no sync-chain gate (see above).
  if (
    body.targetCompanies !== undefined ||
    body.companyName !== undefined ||
    body.linkedOrgRole !== undefined ||
    body.sourcingRequested !== undefined
  ) {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.sourcingRequested !== undefined) {
      // Client raises (or lowers) a hand for sourcing help on this role.
      const on = body.sourcingRequested === true;
      patch.sourcing_requested = on;
      patch.sourcing_requested_at = on ? new Date().toISOString() : null;
      if (on && !job.sourcing_requested) {
        // Notify Spencer on the false -> true transition only.
        after(async () => {
          await sendEmail({
            to: "spencer@transformertalent.com",
            subject: `${member.org.name} asked for help: ${job.title} (#${job.external_id})`,
            html: `<p style="margin:0 0 14px;"><b>${member.org.name}</b> switched on sourcing help for
              <b>${job.title}</b> (#${job.external_id}).</p>
              <p style="margin:0;">Open your <a href="https://www.transformertalent.com/dashboard" style="color:#2a5bd7;">Jobs page</a>
              to copy it into your jobs and link it.</p>`,
          });
        });
      }
    }
    if (body.linkedOrgRole !== undefined) {
      // Cross-org send bridge target: TT wires its jobs to client jobs.
      if (member.org.slug !== "transformer-talent")
        return NextResponse.json({ error: "not_available" }, { status: 404 });
      if (body.linkedOrgRole === null) {
        patch.linked_org_role = null;
      } else {
        const l = body.linkedOrgRole as { orgId?: unknown; jobId?: unknown };
        const orgId = String(l?.orgId ?? "");
        const jobId = String(l?.jobId ?? "").slice(0, 40);
        if (!/^[0-9a-f-]{36}$/.test(orgId) || !jobId || orgId === member.org.id)
          return NextResponse.json({ error: "bad_link" }, { status: 400 });
        const tRes = await sbRest(
          `org_roles?organization_id=eq.${orgId}&external_id=eq.${encodeURIComponent(jobId)}&select=id&limit=1`
        );
        if (!tRes.ok || ((await tRes.json()) as unknown[]).length === 0)
          return NextResponse.json({ error: "target_job_not_found" }, { status: 400 });
        patch.linked_org_role = { orgId, jobId };
      }
    }
    if (body.targetCompanies !== undefined) {
      const targets = sanitizeTargets(body.targetCompanies);
      if (!targets) return NextResponse.json({ error: "bad_target_companies" }, { status: 400 });
      patch.target_companies = targets;
    }
    if (body.companyName !== undefined) {
      if (typeof body.companyName !== "string" || body.companyName.length > 120)
        return NextResponse.json({ error: "bad_company_name" }, { status: 400 });
      patch.company_name = body.companyName.trim() || null;
    }
    const up = await sbRest(`org_roles?id=eq.${job.id}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify(patch),
    });
    if (!up.ok) return NextResponse.json({ error: "update_failed" }, { status: 502 });
    return NextResponse.json({ id: job.external_id });
  }

  // Notion-synced roles are owned by the sync chain: edits would be
  // overwritten and closes silently reverted on the next sync.
  if (job.source !== "dashboard")
    return NextResponse.json({ error: "synced_role_readonly" }, { status: 409 });

  // Status-only change: close / reopen.
  if (body.status && !body.title) {
    const status = body.status === "closed" ? "closed" : "open";
    const up = await sbRest(`org_roles?id=eq.${job.id}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
    });
    if (!up.ok) return NextResponse.json({ error: "update_failed" }, { status: 502 });
    return NextResponse.json({ id: job.external_id, status });
  }

  const skills = sanitizeSkills(body.skills);
  const parsed = roleInputFromBody(body, skills);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (skills.length === 0)
    return NextResponse.json({ error: "at_least_one_skill" }, { status: 400 });

  const role = { ...parsed.role, jobId: job.external_id };
  try {
    await publishOrgRole(member.org.id, role, skills, "dashboard");
  } catch (e) {
    console.error("republish role failed", e);
    return NextResponse.json({ error: "publish_failed" }, { status: 502 });
  }
  return NextResponse.json({ id: job.external_id });
}
