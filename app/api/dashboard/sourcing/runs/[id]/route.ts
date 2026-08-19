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
      `&select=id,status,error,search_params,match_estimate,pages_fetched,imported_count,duplicate_count,screened_count,screen_target,created_at,started_at,finished_at,org_roles(external_id,title)&limit=1`
  );
  const [run] = res.ok ? await res.json() : [];
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ run });
}
