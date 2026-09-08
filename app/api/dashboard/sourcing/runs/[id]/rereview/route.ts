// Re-review candidates. Default: only those that permanently failed (3
// attempts / poison rows) get their retry budget reset. {all: true}: every
// visible person in the run is judged again with the current verdict, so a
// run made under an older judge can be brought up to date without a new
// import. Either way the advance loop does the rest — review-all semantics
// mean the rows simply rejoin the queue.
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const { id } = await params;
  const owned = await sbRest(
    `sourcing_runs?id=eq.${encodeURIComponent(id)}&organization_id=eq.${member.org.id}&select=id,status&limit=1`
  );
  const [run] = owned.ok ? await owned.json() : [];
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });
  let all = false;
  try {
    const body = (await req.json()) as { all?: unknown };
    all = body?.all === true;
  } catch {
    /* no body: the failed-only form */
  }
  if (all && !["done", "failed"].includes(run.status)) {
    return NextResponse.json({ error: "run_active" }, { status: 409 });
  }

  const reset = await sbRest(
    `sourcing_run_candidates?run_id=eq.${run.id}&` +
      (all ? `hidden=eq.false&screen_status=neq.pending` : `screen_status=eq.failed&screen_attempts=gte.3`),
    {
      method: "PATCH",
      body: JSON.stringify({
        screen_status: "none",
        screen_attempts: 0,
        orphan_heals: 0,
        screen_next_attempt_at: null,
        screen_claim_id: null,
        // A full re-review clears the old reading so the table shows
        // "Reviewing…" until the new verdict lands, never a stale tag.
        ...(all ? { tag: null, reason: null, verdict: null, screened_at: null } : {}),
      }),
      prefer: "return=representation",
    }
  );
  const rows = reset.ok ? ((await reset.json()) as unknown[]) : [];
  if (rows.length && (run.status === "done" || run.status === "failed")) {
    await sbRest(`sourcing_runs?id=eq.${run.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "screening", finished_at: null, allfail_streak: 0, next_attempt_at: null, error: null }),
      prefer: "return=minimal",
    });
  }
  return NextResponse.json({ ok: true, reset: rows.length });
}
