// One sourcing run's status — the progress view polls this.
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const { id } = await params;
  const res = await sbRest(
    `sourcing_runs?id=eq.${encodeURIComponent(id)}&organization_id=eq.${member.org.id}` +
      `&select=id,status,error,search_params,match_estimate,pages_fetched,imported_count,duplicate_count,screened_count,screen_target,next_attempt_at,created_at,started_at,finished_at,org_roles(external_id,title)&limit=1`
  );
  const [run] = res.ok ? await res.json() : [];
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Terminal failures surface honestly: "N couldn't be reviewed — Retry".
  const failedRes = await sbRest(
    `sourcing_run_candidates?run_id=eq.${run.id}&screen_status=eq.failed&screen_attempts=gte.3&select=id`,
    { method: "HEAD", headers: { Prefer: "count=exact", Range: "0-0" } }
  );
  const unreviewable = parseInt((failedRes.headers.get("content-range") || "/0").split("/")[1], 10) || 0;
  return NextResponse.json({ run: { ...run, unreviewable } });
}
