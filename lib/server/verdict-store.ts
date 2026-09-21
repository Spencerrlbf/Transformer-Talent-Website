// Where a verdict lives for an applicant: inside the match_verdicts row for
// that candidate x role, as `v2`, beside the scorecard the row already has.
// Older rows without v2 keep rendering the scorecard.
import { sbRest } from "./supabase";
import type { VerdictView } from "@/lib/verdict-view";

/** The verdict row the dashboard reads for this person and role: the newest.
 *  Found by person and role only. Screening writes its rows under the site's
 *  own organisation whichever board the person applied through, so filtering
 *  by the member's organisation hid every tenant applicant's row; the role id
 *  is already scoped to the organisation by whoever loaded it. */
export async function findVerdictRow(candidateId: string, orgRoleId: string): Promise<{ id: string; verdict: Record<string, unknown> | null } | null> {
  const res = await sbRest(`match_verdicts?candidate_id=eq.${candidateId}&org_role_id=eq.${orgRoleId}&select=id,verdict&order=created_at.desc&limit=1`);
  if (!res.ok) throw new Error(`findVerdictRow: ${res.status}`);
  const [row] = (await res.json()) as { id: string; verdict: Record<string, unknown> | null }[];
  return row || null;
}

export async function attachVerdictToMatch(_orgId: string, candidateId: string, orgRoleId: string, view: VerdictView): Promise<boolean> {
  const row = await findVerdictRow(candidateId, orgRoleId).catch(() => null);
  if (!row) return false;
  const patched = await sbRest(`match_verdicts?id=eq.${row.id}`, {
    method: "PATCH",
    body: JSON.stringify({ verdict: { ...(row.verdict || {}), v2: view } }),
    prefer: "return=minimal",
  });
  return patched.ok;
}
