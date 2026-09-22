// A run's ranked candidates (paginated, filterable) + row actions.
// Client-safe payload only: tag + reason, never the verdict/profile jsonb.
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import { isVerdictView } from "@/lib/verdict-view";
import { computeFacts } from "@/lib/server/facts";
import { harvestToExperiences } from "@/lib/server/spine";

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
    filter === "strong" ? "tag=in.(strong_yes,strong,contact)" : null,
    filter === "yes" ? "tag=eq.yes" : null,
    filter === "message" ? "tag=in.(worth_message,possible,message)" : null,
    filter === "shortlisted" ? "shortlisted=eq.true" : null,
  ].filter(Boolean).join("&");

  const select =
    `&select=id,rank,tag,reason,verdict,screen_status,shortlisted,hidden,sourced_candidate_id,` +
    `sourced_candidates(full_name,headline,location,current_title,current_company,linkedin_url,linkedin_username,years_experience,skills,profile)`;
  const paging = `&limit=${PAGE}&offset=${(page - 1) * PAGE}`;
  // Best fit first: Contact now, Worth a message, Pass (alphabetical order of
  // the stored labels happens to be that order), then how strongly the
  // scorecard is met (cardStrength: each row by its status and tier, plus a
  // little for rungs read above met-from on an unconfirmed row), then the
  // search's own rank. People not judged yet come last. If the ordering is
  // ever refused, the table still loads in search-rank order.
  const byFit = `&order=verdict->>label.asc.nullslast,verdict->card->strength.desc.nullslast,rank.asc.nullslast,created_at.asc`;
  const byRank = `&order=rank.asc.nullslast,created_at.asc`;
  let res = await sbRest(`sourcing_run_candidates?${filters}${select}${byFit}${paging}`, { headers: { Prefer: "count=exact" } });
  if (!res.ok) {
    console.error("run candidates: fit ordering refused", res.status, (await res.text().catch(() => "")).slice(0, 200));
    res = await sbRest(`sourcing_run_candidates?${filters}${select}${byRank}${paging}`, { headers: { Prefer: "count=exact" } });
  }
  if (!res.ok) return NextResponse.json({ error: "load_failed" }, { status: 502 });
  const total = parseInt((res.headers.get("content-range") || "/0").split("/")[1], 10) || 0;
  type Row = {
    id: string; rank: number | null; tag: string | null; reason: string | null; verdict: unknown;
    sourced_candidate_id: string;
    screen_status: string; shortlisted: boolean; hidden: boolean;
    sourced_candidates: {
      full_name: string | null; headline: string | null; location: string | null;
      current_title: string | null; current_company: string | null;
      linkedin_url: string | null; linkedin_username: string | null;
      years_experience: number | null; skills: string[] | null;
      profile: ({ experience?: { companyName?: string; company?: string }[]; education?: unknown } & Record<string, unknown>) | null;
    } | null;
  };
  const rows = (await res.json()) as Row[];
  return NextResponse.json({
    total,
    page,
    pageSize: PAGE,
    candidates: rows.map((r) => ({
      membershipId: r.id,
      // The person's key everywhere else in the dashboard.
      candidateKey: `src_${r.sourced_candidate_id}`,
      rank: r.rank,
      // The tag column holds an older word for a judged row; the verdict's
      // label is the one to show. The view carries no profile or raw output.
      tag: isVerdictView(r.verdict) ? r.verdict.label : r.tag,
      reason: r.reason,
      verdict: isVerdictView(r.verdict) ? r.verdict : null,
      screenStatus: r.screen_status,
      shortlisted: r.shortlisted,
      hidden: r.hidden,
      name: r.sourced_candidates?.full_name || r.sourced_candidates?.linkedin_username || "Unknown",
      title: r.sourced_candidates?.current_title || null,
      company: r.sourced_candidates?.current_company || null,
      location: r.sourced_candidates?.location || null,
      linkedinUrl: r.sourced_candidates?.linkedin_url || null,
      // 5-second snapshot: years · company trajectory · top skills
      // Career years as of today, from the dated positions. The number stored
      // at import is a snapshot: it never grew, and read low within weeks.
      years: (() => {
        const profile = r.sourced_candidates?.profile;
        if (!profile) return r.sourced_candidates?.years_experience ?? null;
        const live = computeFacts(harvestToExperiences(profile), [], [], profile.education ?? null).careerYears;
        return live ?? r.sourced_candidates?.years_experience ?? null;
      })(),
      priorCompanies: [...new Set(
        (r.sourced_candidates?.profile?.experience || [])
          .map((e) => e.companyName || e.company)
          .filter((c): c is string => !!c)
      )].slice(1, 4), // skip current (shown already), next 3 priors
      topSkills: (r.sourced_candidates?.skills || []).slice(0, 5),
      skillCount: (r.sourced_candidates?.skills || []).length,
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
