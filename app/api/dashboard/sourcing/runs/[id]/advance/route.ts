// Advance a run within this invocation's time budget. Drivers loop until
// done. The engine claims a DB-clock lease itself (busy when another driver
// holds it) and every write is fenced — concurrent callers are harmless.
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import { advanceRun, RunFailure } from "@/lib/server/sourcing/run";

export const maxDuration = 60;
const BUDGET_MS = 50_000;

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const { id } = await params;
  const owned = await sbRest(
    `sourcing_runs?id=eq.${encodeURIComponent(id)}&organization_id=eq.${member.org.id}&select=id&limit=1`
  );
  const rows = owned.ok ? await owned.json() : [];
  if (!rows.length) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const result = await advanceRun(id, BUDGET_MS);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof RunFailure) {
      return NextResponse.json({ status: "failed", done: true, error: err.message });
    }
    // Transient (network/DB blip): the run stays active — tell the driver
    // to retry rather than stop.
    console.error(`advance run ${id} transient error:`, err);
    return NextResponse.json({ transient: true, busy: true, done: false, retryAfterMs: 8000 }, { status: 200 });
  }
}
