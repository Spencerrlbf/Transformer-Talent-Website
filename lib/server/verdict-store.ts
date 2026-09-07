// Where a verdict lives for an applicant: inside the match_verdicts row for
// that candidate x role, as `v2`, beside the scorecard the row already has.
// Older rows without v2 keep rendering the scorecard.
import { sbRest } from "./supabase";
import type { VerdictView } from "@/lib/verdict-view";

export async function attachVerdictToMatch(orgId: string, candidateId: string, orgRoleId: string, view: VerdictView): Promise<boolean> {
  const res = await sbRest(
    `match_verdicts?organization_id=eq.${orgId}&candidate_id=eq.${candidateId}&org_role_id=eq.${orgRoleId}&select=id,verdict&order=created_at.desc&limit=1`
  );
  const [row] = res.ok ? ((await res.json()) as { id: string; verdict: Record<string, unknown> | null }[]) : [];
  if (!row) return false;
  const patched = await sbRest(`match_verdicts?id=eq.${row.id}`, {
    method: "PATCH",
    body: JSON.stringify({ verdict: { ...(row.verdict || {}), v2: view } }),
    prefer: "return=minimal",
  });
  return patched.ok;
}
