// Advance a run within this invocation's time budget. The run view calls
// this in a sequential loop while the page is open; the engine is resumable
// so a closed tab just pauses the run until someone reopens it.
//
// Soft lock: an active run freshly touched by another advance (updated_at
// heartbeat) returns busy instead of double-processing — two open tabs
// must not both fetch page 7.
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import { advanceRun } from "@/lib/server/sourcing/run";

export const maxDuration = 60;
const BUDGET_MS = 40_000;
const HEARTBEAT_MS = 20_000;
const ACTIVE = new Set(["importing", "ranking", "screening"]);

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const { id } = await params;
  const res = await sbRest(
    `sourcing_runs?id=eq.${encodeURIComponent(id)}&organization_id=eq.${member.org.id}&select=id,status,updated_at&limit=1`
  );
  const [run] = res.ok ? await res.json() : [];
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (run.status === "done" || run.status === "failed" || run.status === "cancelled") {
    return NextResponse.json({ status: run.status, done: true });
  }
  if (ACTIVE.has(run.status) && Date.now() - new Date(run.updated_at).getTime() < HEARTBEAT_MS) {
    return NextResponse.json({ busy: true, status: run.status, done: false });
  }
  try {
    const result = await advanceRun(run.id, BUDGET_MS);
    return NextResponse.json(result);
  } catch (err) {
    console.error(`advance run ${run.id} failed:`, err);
    return NextResponse.json({ status: "failed", done: true, error: String((err as Error).message).slice(0, 200) });
  }
}
