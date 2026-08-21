import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { saveUnifiedStatus } from "@/lib/server/candidates-unified";

// Set a candidate's human pipeline status for one role.
export async function PUT(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const { key } = await ctx.params;
  if (!/^(app|src)_[0-9a-f-]{36}$/i.test(key))
    return NextResponse.json({ error: "bad_key" }, { status: 400 });

  let body: { jobId?: unknown; status?: unknown; interviewStage?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (typeof body.jobId !== "string" || !body.jobId || typeof body.status !== "string")
    return NextResponse.json({ error: "bad_body" }, { status: 400 });

  const result = await saveUnifiedStatus(
    member.org.id,
    key,
    body.jobId,
    body.status,
    typeof body.interviewStage === "string" ? body.interviewStage : null
  );
  if (!result.ok) {
    const code = result.error === "save_failed" ? 502 : result.error === "job_not_found" ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status: code });
  }
  return NextResponse.json({ ok: true, status: body.status });
}
