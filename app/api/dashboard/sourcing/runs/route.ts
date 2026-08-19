// Sourcing runs: list per job (the tab's home screen) and create.
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import { sanitizeLeadQuery, providerMode } from "@/lib/server/sourcing/harvest";
import { MAX_IMPORT } from "@/lib/server/sourcing/run";
import { sbRpc } from "@/lib/server/supabase";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const jobId = req.nextUrl.searchParams.get("jobId") || "";
  let roleFilter = "";
  if (jobId) {
    const roleRes = await sbRest(
      `org_roles?organization_id=eq.${member.org.id}&external_id=eq.${encodeURIComponent(jobId)}&select=id&limit=1`
    );
    const [role] = roleRes.ok ? await roleRes.json() : [];
    if (!role) return NextResponse.json({ runs: [] });
    roleFilter = `&org_role_id=eq.${role.id}`;
  }
  const res = await sbRest(
    `sourcing_runs?organization_id=eq.${member.org.id}${roleFilter}` +
      `&select=id,status,search_params,match_estimate,imported_count,duplicate_count,screened_count,screen_target,created_at,finished_at` +
      `&order=created_at.desc&limit=50`
  );
  const runs = res.ok ? await res.json() : [];
  return NextResponse.json({ runs });
}

export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  const query = sanitizeLeadQuery(body.query || {});
  const matchEstimate = Number(body.matchEstimate);
  if (!jobId || !Object.keys(query).length || !Number.isFinite(matchEstimate) || matchEstimate < 1) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (matchEstimate > MAX_IMPORT) {
    return NextResponse.json({ error: "too_broad", maxImport: MAX_IMPORT }, { status: 400 });
  }
  const roleRes = await sbRest(
    `org_roles?organization_id=eq.${member.org.id}&external_id=eq.${encodeURIComponent(jobId)}&select=id&limit=1`
  );
  const [role] = roleRes.ok ? await roleRes.json() : [];
  if (!role) return NextResponse.json({ error: "job_not_found" }, { status: 404 });

  try {
    // Atomic credit check + creation: an org-level lock means two
    // simultaneous imports can never both spend the same balance.
    const result = await sbRpc<{ ok: boolean; run?: unknown; available?: number; needed?: number }>(
      "create_run_with_credits",
      {
        p_org: member.org.id,
        p_role: role.id,
        p_created_by: member.userId,
        p_params: query,
        p_estimate: Math.trunc(matchEstimate),
        p_mode: providerMode(),
      }
    );
    if (!result.ok) {
      return NextResponse.json(
        { error: "insufficient_credits", available: result.available, needed: result.needed },
        { status: 402 }
      );
    }
    return NextResponse.json({ run: result.run });
  } catch (err) {
    console.error("sourcing run create failed:", err);
    return NextResponse.json({ error: "create_failed" }, { status: 502 });
  }
}
