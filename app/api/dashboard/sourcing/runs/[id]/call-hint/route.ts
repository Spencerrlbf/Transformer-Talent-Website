// Is there a Required row that almost no profile in this run answers, and
// would making it a question for the call move anyone to Contact now? Worked
// out over every visible, judged person in the run (not the page on screen),
// and only offered when the answer is yes for at least one person.
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import { isCareerYearsRow, isScorecard, labelFromRows, type CardRow } from "@/lib/rolecard";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const { id } = await params;
  const runRes = await sbRest(`sourcing_runs?id=eq.${encodeURIComponent(id)}&organization_id=eq.${member.org.id}&select=id,status,org_role_id&limit=1`);
  const [run] = runRes.ok ? ((await runRes.json()) as { id: string; status: string; org_role_id: string }[]) : [];
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (run.status !== "done") return NextResponse.json({ hint: null });

  const [roleRes, rowsRes] = await Promise.all([
    sbRest(`org_roles?id=eq.${run.org_role_id}&select=scorecard&limit=1`),
    sbRest(`sourcing_run_candidates?run_id=eq.${run.id}&hidden=eq.false&verdict=not.is.null&select=rows:verdict->card->rows&limit=2000`),
  ]);
  const [role] = roleRes.ok ? ((await roleRes.json()) as { scorecard: unknown }[]) : [];
  const criteria = isScorecard(role?.scorecard) ? role.scorecard.criteria : [];
  const people = (rowsRes.ok ? ((await rowsRes.json()) as { rows: CardRow[] | null }[]) : []).map((p) => p.rows).filter((r): r is CardRow[] => Array.isArray(r) && r.length > 0);
  if (people.length < 8) return NextResponse.json({ hint: null });

  let best: { id: string; label: string; judged: number; silent: number; wouldContact: number } | null = null;
  for (const c of criteria) {
    if (c.tier !== "required" || c.confirmOnCall || isCareerYearsRow(c.label)) continue;
    const withRow = people.filter((rows) => rows.some((r) => r.id === c.id));
    const silent = withRow.filter((rows) => rows.find((r) => r.id === c.id)!.status === "unknown").length;
    if (withRow.length < 8 || silent / withRow.length < 0.8) continue;
    // Who would it actually move? Same rows, this one row flagged.
    const wouldContact = withRow.filter((rows) => {
      const now = labelFromRows(rows, "message");
      const then = labelFromRows(rows.map((r) => (r.id === c.id ? { ...r, call: true } : r)), "message");
      return now !== "contact" && then === "contact";
    }).length;
    if (wouldContact > 0 && (!best || wouldContact > best.wouldContact)) best = { id: c.id, label: c.label, judged: withRow.length, silent, wouldContact };
  }
  return NextResponse.json({ hint: best });
}
