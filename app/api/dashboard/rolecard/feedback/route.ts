// A recruiter's word on one person's verdict for one role: overrule a
// checklist row (or take the overrule back), or mark "right person, wrong
// role". Returns the verdict as it now reads.
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { loadProfile } from "@/lib/server/recruiter-profile";
import { ROW_STATUSES, type RowStatus } from "@/lib/rolecard";
import { setRowOverride, setWrongRole } from "@/lib/server/rolecard/feedback";

export const maxDuration = 30;

const KEY_RE = /^(app|src)_[0-9a-f-]{36}$/;

const nameFromEmail = (email: string) => {
  const first = email.split("@")[0].split(/[._+-]/)[0] || email;
  return first.charAt(0).toUpperCase() + first.slice(1);
};

export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const candidateKey = String(body?.candidateKey || "");
  const jobId = String(body?.jobId || "").slice(0, 40);
  if (!KEY_RE.test(candidateKey) || !jobId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const membershipId = typeof body?.membershipId === "string" && /^[0-9a-f-]{36}$/.test(body.membershipId) ? body.membershipId : null;
  const profile = await loadProfile(member.org.id, member.userId).catch(() => null);
  const who = { email: member.email, name: profile?.display_name?.trim() || nameFromEmail(member.email) };

  const result =
    typeof body?.wrongRole === "boolean"
      ? await setWrongRole({ orgId: member.org.id, jobId, candidateKey, membershipId, on: body.wrongRole, who })
      : await (() => {
          const criterionId = String(body?.criterionId || "").slice(0, 40);
          const status = body?.status === null ? null : (String(body?.status || "") as RowStatus);
          if (!criterionId || (status !== null && !ROW_STATUSES.includes(status))) return null;
          return setRowOverride({
            orgId: member.org.id, jobId, candidateKey, membershipId, criterionId, status,
            note: typeof body?.note === "string" ? body.note : null, who,
          });
        })();
  if (!result) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.error === "save_failed" ? 502 : 409 });
  return NextResponse.json({ verdict: result.view });
}
