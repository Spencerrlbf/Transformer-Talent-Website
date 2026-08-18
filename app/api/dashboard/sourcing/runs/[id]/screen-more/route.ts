// "Review 50 more": raise the run's screen target and reopen the screening
// stage; the run view's advance loop does the rest.
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import { MAX_SCREEN_TARGET } from "@/lib/server/sourcing/run";

const STEP = 50;

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const { id } = await params;
  const res = await sbRest(
    `sourcing_runs?id=eq.${encodeURIComponent(id)}&organization_id=eq.${member.org.id}&select=id,status,screen_target,screened_count&limit=1`
  );
  const [run] = res.ok ? await res.json() : [];
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (run.status !== "done" && run.status !== "screening") {
    return NextResponse.json({ error: "not_ready" }, { status: 409 });
  }
  const target = Math.min(run.screen_target + STEP, MAX_SCREEN_TARGET);
  if (target === run.screen_target) {
    return NextResponse.json({ error: "at_cap", cap: MAX_SCREEN_TARGET }, { status: 409 });
  }
  const patch = await sbRest(`sourcing_runs?id=eq.${run.id}`, {
    method: "PATCH",
    body: JSON.stringify({ screen_target: target, status: "screening", finished_at: null, updated_at: new Date(0).toISOString() }),
    prefer: "return=minimal",
  });
  if (!patch.ok) return NextResponse.json({ error: "update_failed" }, { status: 502 });
  return NextResponse.json({ ok: true, screenTarget: target });
}
