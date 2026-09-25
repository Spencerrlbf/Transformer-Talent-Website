import { after, NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import { publishOrgRole, sanitizeSkills } from "@/lib/server/publish-role";
import { roleInputFromBody } from "@/lib/server/job-body";
import { sendEmail } from "@/lib/server/email";
import { escapeHtml, plainLine } from "@/lib/server/html";
import { cardChanges, isScorecard, sanitizeScorecard } from "@/lib/rolecard";
import { saveRoleCard } from "@/lib/server/rolecard/store";
import { relabelRole } from "@/lib/server/rolecard/feedback";

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

async function loadJob(orgId: string, externalId: string) {
  const res = await sbRest(
    `org_roles?organization_id=eq.${orgId}&external_id=eq.${encodeURIComponent(externalId)}` +
      `&select=id,external_id,title,status,salary,locations,workplace,visa,yoe,role_type,tech_stack,jd,skills,source,updated_at,target_companies,company_name,linked_org_role,sourcing_requested,scorecard,created_by,notify_user_ids&limit=1`
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

  // Lead emails: who hears about a new applicant for this job (the job's
  // recruiter by default), and the teammates who could.
  const [membersRes, profilesRes] = await Promise.all([
    sbRest(`org_members?organization_id=eq.${member.org.id}&select=user_id,email,member_role&order=created_at.asc`),
    sbRest(`recruiter_profiles?organization_id=eq.${member.org.id}&select=user_id,display_name`),
  ]);
  const members = membersRes.ok ? ((await membersRes.json()) as { user_id: string; email: string; member_role: string }[]) : [];
  const names = new Map(
    (profilesRes.ok ? ((await profilesRes.json()) as { user_id: string; display_name: string | null }[]) : []).map((p) => [p.user_id, p.display_name])
  );
  const team = members.map((m) => ({ userId: m.user_id, email: m.email, name: names.get(m.user_id) || null, owner: m.member_role === "owner" }));
  const chosen = ((job.notify_user_ids as string[] | null) ?? (job.created_by ? [job.created_by as string] : [])).filter((u) =>
    team.some((t) => t.userId === u)
  );

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
      leadEmails: { userIds: chosen, team },
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
    body.sourcingRequested !== undefined ||
    body.notifyUserIds !== undefined
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
            // The company name and job title are the client's own text.
            subject: plainLine(`${member.org.name} asked for help: ${job.title} (#${job.external_id})`),
            html: `<p style="margin:0 0 14px;"><b>${escapeHtml(member.org.name)}</b> switched on sourcing help for
              <b>${escapeHtml(job.title)}</b> (#${escapeHtml(job.external_id)}).</p>
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
        // Only a job whose company asked TT for help (open, "ask for help" on).
        const tRes = await sbRest(
          `org_roles?organization_id=eq.${orgId}&external_id=eq.${encodeURIComponent(jobId)}` +
            `&status=eq.open&sourcing_requested=is.true&select=id&limit=1`
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
    if (body.notifyUserIds !== undefined) {
      // Who gets this job's lead emails: teammates only, every one a current
      // member of this company. null = back to the job's recruiter.
      if (body.notifyUserIds === null) {
        patch.notify_user_ids = null;
      } else {
        const raw = Array.isArray(body.notifyUserIds) ? body.notifyUserIds : null;
        const ids = raw ? [...new Set(raw.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)))] : null;
        if (!ids || ids.length !== raw!.length || ids.length > 10)
          return NextResponse.json({ error: "bad_notify" }, { status: 400 });
        if (ids.length) {
          const mres = await sbRest(
            `org_members?organization_id=eq.${member.org.id}&user_id=in.(${ids.join(",")})&select=user_id`
          );
          const found = new Set(mres.ok ? ((await mres.json()) as { user_id: string }[]).map((m) => m.user_id) : []);
          if (ids.some((u) => !found.has(u))) return NextResponse.json({ error: "not_a_teammate" }, { status: 400 });
        }
        patch.notify_user_ids = ids;
      }
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
  // The scorecard edited in the form. The republish above never touches it.
  // Same rules as the scorecard's own save route (PUT /api/dashboard/rolecard/[jobId]).
  const prevCard = isScorecard(job.scorecard) ? job.scorecard : null;
  const card = sanitizeScorecard(body.scorecard, "user", prevCard);
  let relabelled = 0;
  let reask = 0;
  if (card?.criteria.some((c) => c.tier === "required")) {
    const changed = !prevCard || JSON.stringify(prevCard.criteria) !== JSON.stringify(card.criteria);
    card.editedBy = changed ? member.email : prevCard?.editedBy;
    card.editedAt = changed ? new Date().toISOString() : prevCard?.editedAt;
    if (changed) {
      await saveRoleCard(job.id, card).catch(() => false);
      // A call question came or went, or a row counts from another rung:
      // stored verdicts for the role are re-labelled, nobody is judged again.
      // Reworded ladders wait for Review again, which re-asks only those rows.
      const changes = cardChanges(prevCard, card);
      reask = changes.reask;
      if ((changes.calls || changes.metAts) && changes.reask === 0)
        relabelled = await relabelRole(member.org.id, job.id, card.criteria).catch((e) => (console.error("relabel failed", e), -1));
    }
  }
  return NextResponse.json({ id: job.external_id, relabelled, reask });
}
