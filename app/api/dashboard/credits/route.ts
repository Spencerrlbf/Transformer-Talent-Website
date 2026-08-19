// Org credit balance + history. Balance is always computed from the grants
// ledger minus the exactly-once usage ledger — never a stored number.
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest, sbRpc } from "@/lib/server/supabase";

export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const [[summary], grantsRes, spendRes] = await Promise.all([
    sbRpc<{ granted: number; spent: number; held: number; balance: number; available: number }[]>(
      "org_credit_summary", { p_org: member.org.id }
    ),
    sbRest(
      `credit_grants?organization_id=eq.${member.org.id}&select=credits,reason,created_at&order=created_at.desc&limit=20`
    ),
    sbRest(
      `usage_events?organization_id=eq.${member.org.id}&credits=gt.0&select=credits,created_at,run_id,` +
        `sourcing_runs(org_roles(title))&order=created_at.desc&limit=200`
    ),
  ]);

  const grants = grantsRes.ok ? await grantsRes.json() : [];
  type SpendRow = { credits: number; created_at: string; run_id: string | null; sourcing_runs: { org_roles: { title: string } | null } | null };
  const spendRows: SpendRow[] = spendRes.ok ? await spendRes.json() : [];

  // Aggregate spend per run so history reads "search — N credits", not pages.
  const byRun = new Map<string, { credits: number; at: string; title: string }>();
  for (const row of spendRows) {
    const key = row.run_id || row.created_at;
    const cur = byRun.get(key);
    if (cur) {
      cur.credits += row.credits;
      if (row.created_at < cur.at) cur.at = row.created_at;
    } else {
      byRun.set(key, {
        credits: row.credits,
        at: row.created_at,
        title: row.sourcing_runs?.org_roles?.title || "Sourcing search",
      });
    }
  }

  const history = [
    ...grants.map((g: { credits: number; reason: string | null; created_at: string }) => ({
      kind: "grant" as const, credits: g.credits, label: g.reason || "Credits added", at: g.created_at,
    })),
    ...[...byRun.values()].map((s) => ({
      kind: "spend" as const, credits: -s.credits, label: `${s.title} — candidate imports`, at: s.at,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 25);

  return NextResponse.json({ summary: summary ?? { granted: 0, spent: 0, held: 0, balance: 0, available: 0 }, history });
}
