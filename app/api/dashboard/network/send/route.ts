import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sendNetworkCandidate, TT_ORG_SLUG } from "@/lib/server/network";

export const maxDuration = 60;

// Send a pool person to a job: creates the Via-Transformer-Talent
// application that appears in that job's pipeline. TT org only.
export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  if (member.org.slug !== TT_ORG_SLUG)
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { candidateId?: unknown; jobId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (
    typeof body.candidateId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(body.candidateId) ||
    typeof body.jobId !== "string" ||
    !body.jobId
  )
    return NextResponse.json({ error: "bad_body" }, { status: 400 });

  const result = await sendNetworkCandidate(member.org.id, body.candidateId, body.jobId);
  if (!result.ok) {
    const code =
      result.error === "insert_failed" ? 502 :
      result.error === "already_sent" ? 409 : 404;
    return NextResponse.json({ error: result.error }, { status: code });
  }
  return NextResponse.json({ ok: true, applicationId: result.applicationId });
}
