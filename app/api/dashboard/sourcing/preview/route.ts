// Preview a sourcing search: one metered page-1 request → match count and
// the import/too-broad guardrail verdict. No run is created yet.
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import { sanitizeLeadQuery } from "@/lib/server/sourcing/harvest";
import { previewSearch, MAX_IMPORT } from "@/lib/server/sourcing/run";
import { sbRpc } from "@/lib/server/supabase";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  const query = sanitizeLeadQuery(body.query || {});
  if (!jobId || !Object.keys(query).length) {
    return NextResponse.json({ error: "empty_search" }, { status: 400 });
  }
  const roleRes = await sbRest(
    `org_roles?organization_id=eq.${member.org.id}&external_id=eq.${encodeURIComponent(jobId)}&select=id&limit=1`
  );
  const [role] = roleRes.ok ? await roleRes.json() : [];
  if (!role) return NextResponse.json({ error: "job_not_found" }, { status: 404 });

  try {
    const [preview, [credits]] = await Promise.all([
      previewSearch(member.org.id, query),
      sbRpc<{ available: number }[]>("org_credit_summary", { p_org: member.org.id }),
    ]);
    return NextResponse.json({
      ...preview,
      maxImport: MAX_IMPORT,
      query,
      creditsAvailable: credits?.available ?? 0,
    });
  } catch (err) {
    console.error("sourcing preview failed:", err);
    return NextResponse.json({ error: "preview_failed" }, { status: 502 });
  }
}
