// A run's ranked candidates (paginated, filterable) + row actions.
// Client-safe payload only: tag + reason, never the verdict/profile jsonb.
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";

type Params = { params: Promise<{ id: string }> };
const PAGE = 25;

async function ownRun(orgId: string, runId: string): Promise<boolean> {
  const res = await sbRest(`sourcing_runs?id=eq.${encodeURIComponent(runId)}&organization_id=eq.${orgId}&select=id&limit=1`);
  const rows = res.ok ? await res.json() : [];
  return rows.length > 0;
}

export async function GET(req: NextRequest, { params }: Params) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const { id } = await params;
  if (!(await ownRun(member.org.id, id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10) || 1);
  const filter = sp.get("filter") || "all"; // all | strong | yes | message | shortlisted
  const showHidden = sp.get("hidden") === "1";
  const filters = [
    `run_id=eq.${encodeURIComponent(id)}`,
    showHidden ? null : "hidden=eq.false",
    filter === "strong" ? "tag=in.(strong_yes,strong)" : null,
    filter === "yes" ? "tag=eq.yes" : null,
    filter === "message" ? "tag=in.(worth_message,possible)" : null,
    filter === "shortlisted" ? "shortlisted=eq.true" : null,
  ].filter(Boolean).join("&");

  const res = await sbRest(
    `sourcing_run_candidates?${filters}` +
      `&select=id,rank,tag,reason,screen_status,shortlisted,hidden,` +
      `sourced_candidates(full_name,headline,location,current_title,current_company,linkedin_url,linkedin_username)` +
      `&order=rank.asc.nullslast,created_at.asc&limit=${PAGE}&offset=${(page - 1) * PAGE}`,
    { headers: { Prefer: "count=exact" } }
  );
  if (!res.ok) return NextResponse.json({ error: "load_failed" }, { status: 502 });
  const total = parseInt((res.headers.get("content-range") || "/0").split("/")[1], 10) || 0;
  type Row = {
    id: string; rank: number | null; tag: string | null; reason: string | null;
    screen_status: string; shortlisted: boolean; hidden: boolean;
    sourced_candidates: {
      full_name: string | null; headline: string | null; location: string | null;
      current_title: string | null; current_company: string | null;
      linkedin_url: string | null; linkedin_username: string | null;
    } | null;
  };
  const rows = (await res.json()) as Row[];
  return NextResponse.json({
    total,
    page,
    pageSize: PAGE,
    candidates: rows.map((r) => ({
      membershipId: r.id,
      rank: r.rank,
      tag: r.tag,
      reason: r.reason,
      screenStatus: r.screen_status,
      shortlisted: r.shortlisted,
      hidden: r.hidden,
      name: r.sourced_candidates?.full_name || r.sourced_candidates?.linkedin_username || "Unknown",
      title: r.sourced_candidates?.current_title || null,
      company: r.sourced_candidates?.current_company || null,
      location: r.sourced_candidates?.location || null,
      linkedinUrl: r.sourced_candidates?.linkedin_url || null,
    })),
  });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const { id } = await params;
  if (!(await ownRun(member.org.id, id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const membershipId = typeof body.membershipId === "string" ? body.membershipId : "";
  const patch: Record<string, boolean> = {};
  if (typeof body.shortlisted === "boolean") patch.shortlisted = body.shortlisted;
  if (typeof body.hidden === "boolean") patch.hidden = body.hidden;
  if (!membershipId || !Object.keys(patch).length) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const res = await sbRest(
    `sourcing_run_candidates?id=eq.${encodeURIComponent(membershipId)}&run_id=eq.${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(patch), prefer: "return=minimal" }
  );
  if (!res.ok) return NextResponse.json({ error: "update_failed" }, { status: 502 });
  return NextResponse.json({ ok: true });
}
