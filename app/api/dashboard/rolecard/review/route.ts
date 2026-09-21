// "Review again" for someone who applied: their stored LinkedIn profile and
// resume, judged against the role's scorecard as it stands now, by the same
// code that judged them when they applied. A verdict is otherwise only ever
// made at the moment of applying, so without this an applicant from before
// the scorecard existed (or before it was edited) never gets one.
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import { APPLICANT_ROLE_COLS, judgeApplicantForRole, type ApplicantRole } from "@/lib/server/rolecard/applicant";
import { attachVerdictToMatch, findVerdictRow } from "@/lib/server/verdict-store";

export const maxDuration = 60;

const KEY_RE = /^app_[0-9a-f-]{36}$/;

export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const candidateKey = String(body?.candidateKey || "");
  const jobId = String(body?.jobId || "").slice(0, 40);
  if (!KEY_RE.test(candidateKey) || !jobId) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const orgId = member.org.id;

  const [appRes, roleRes] = await Promise.all([
    sbRest(`website_applications?organization_id=eq.${orgId}&id=eq.${candidateKey.slice(4)}&select=id,name,candidate_id,harvest_profile,resume_text&limit=1`),
    sbRest(`org_roles?organization_id=eq.${orgId}&external_id=eq.${encodeURIComponent(jobId)}&select=${APPLICANT_ROLE_COLS}&limit=1`),
  ]);
  if (!appRes.ok || !roleRes.ok) return NextResponse.json({ error: "load_failed" }, { status: 502 });
  const [app] = (await appRes.json()) as { id: string; name: string | null; candidate_id: string | null; harvest_profile: Record<string, unknown> | null; resume_text: string | null }[];
  const [role] = (await roleRes.json()) as ApplicantRole[];
  if (!app || !role) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!app.candidate_id) return NextResponse.json({ error: "still_processing" }, { status: 409 });
  if (!app.harvest_profile && !app.resume_text) return NextResponse.json({ error: "nothing_to_review" }, { status: 409 });

  // Before anything is spent: is there a verdict row to keep the review on?
  // Every screened role has one. (None is made here: other readers take the
  // newest row for a person and role to be a screening result.)
  const row = await findVerdictRow(app.candidate_id, role.id).catch(() => undefined);
  if (row === undefined) return NextResponse.json({ error: "load_failed" }, { status: 502 });
  if (!row) return NextResponse.json({ error: "not_screened" }, { status: 409 });

  // The applicant pipeline's own time budget, which fits the 60 seconds this
  // function has: a draft (24s at most) or none, the rows, the note (15s).
  const judged = await judgeApplicantForRole({
    orgId,
    candidateId: app.candidate_id,
    name: app.name,
    harvest: app.harvest_profile,
    resumeText: app.resume_text,
    role,
    draftMs: 12_000,
    totalMs: 40_000,
    requireScorecard: true,
  }).catch((e) => (console.error("applicant review failed", e), { view: null, saved: false, noScorecard: false }));
  if (judged.noScorecard) return NextResponse.json({ error: "no_scorecard" }, { status: 409 });
  const view = judged.view;
  if (!view) return NextResponse.json({ error: "review_failed" }, { status: 502 });
  if (!(await attachVerdictToMatch(orgId, app.candidate_id, role.id, view).catch(() => false)))
    return NextResponse.json({ error: "save_failed" }, { status: 502 });
  return NextResponse.json({ verdict: view });
}
