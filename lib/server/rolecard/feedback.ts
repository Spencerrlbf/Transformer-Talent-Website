// A recruiter's word on a verdict. Checking off a scorecard row does three
// things: it is kept against the person and role (so judging again can never
// flip it), it becomes a confirmed fact about the person (so the judge knows
// it for every other role), and every stored copy of that verdict is
// re-stamped so tables, boards and drawers show the new label at once.

import { sbRest } from "../supabase";
import { applyOverrides, type RowStatus } from "@/lib/rolecard";
import { isVerdictView, type VerdictView } from "@/lib/verdict-view";
import { loadPersonContext, personKey, syncPersonFacts } from "./store";

// The sourcing tag column only accepts the older vocabulary (CHECK, migration
// 020); the verdict itself carries the real label and every reader prefers it.
const LEGACY_TAG = { contact: "strong_yes", message: "worth_message", pass: "not_now" } as const;

export interface Who {
  email: string;
  name: string;
}

export async function roleByExternalId(orgId: string, jobId: string): Promise<{ id: string; title: string } | null> {
  const res = await sbRest(
    `org_roles?organization_id=eq.${orgId}&external_id=eq.${encodeURIComponent(jobId)}&select=id,title&limit=1`
  );
  const [row] = res.ok ? ((await res.json()) as { id: string; title: string }[]) : [];
  return row || null;
}

type Stored =
  | { kind: "run"; id: string; view: VerdictView }
  | { kind: "match"; id: string; verdict: Record<string, unknown>; view: VerdictView };

/** Every stored copy of this person's verdict for this role. */
async function storedViews(orgId: string, orgRoleId: string, candidateKey: string, candidateId: string | null): Promise<Stored[]> {
  const out: Stored[] = [];
  if (candidateKey.startsWith("src_")) {
    const res = await sbRest(
      `sourcing_run_candidates?organization_id=eq.${orgId}&sourced_candidate_id=eq.${candidateKey.slice(4)}` +
        `&select=id,verdict,sourcing_runs!inner(org_role_id)&sourcing_runs.org_role_id=eq.${orgRoleId}`
    );
    const rows = res.ok ? ((await res.json()) as { id: string; verdict: unknown }[]) : [];
    for (const r of rows) if (isVerdictView(r.verdict)) out.push({ kind: "run", id: r.id, view: r.verdict });
  } else if (candidateId) {
    const res = await sbRest(
      `match_verdicts?organization_id=eq.${orgId}&candidate_id=eq.${candidateId}&org_role_id=eq.${orgRoleId}&select=id,verdict`
    );
    const rows = res.ok ? ((await res.json()) as { id: string; verdict: Record<string, unknown> | null }[]) : [];
    for (const r of rows) {
      const v2 = r.verdict?.v2;
      if (isVerdictView(v2)) out.push({ kind: "match", id: r.id, verdict: r.verdict!, view: v2 });
    }
  }
  return out;
}

/** Lay the current feedback over every stored copy. Returns the copy the
 *  caller is looking at (`showing`, a run row id) or else the newest. */
async function restamp(orgId: string, orgRoleId: string, key: string, copies: Stored[], showing?: string | null): Promise<VerdictView | null> {
  const ctx = await loadPersonContext(orgId, orgRoleId, key);
  let shown: VerdictView | null = null;
  let newest: VerdictView | null = null;
  for (const c of copies) {
    if (!c.view.card?.rows.length) continue;
    const view = applyOverrides(c.view, ctx.overrides, ctx.wrongRole);
    const res =
      c.kind === "run"
        ? await sbRest(`sourcing_run_candidates?id=eq.${c.id}`, {
            method: "PATCH",
            prefer: "return=minimal",
            body: JSON.stringify({ verdict: view, tag: LEGACY_TAG[view.label] }),
          })
        : await sbRest(`match_verdicts?id=eq.${c.id}`, {
            method: "PATCH",
            prefer: "return=minimal",
            body: JSON.stringify({ verdict: { ...c.verdict, v2: view } }),
          });
    if (!res.ok) throw new Error(`restamp ${c.kind}: ${res.status}`);
    if (c.id === showing) shown = view;
    if (!newest || view.at > newest.at) newest = view;
  }
  return shown || newest;
}

export type FeedbackError = "role_not_found" | "no_card" | "row_not_found" | "save_failed";
export type FeedbackResult = { ok: true; view: VerdictView } | { ok: false; error: FeedbackError };

interface Target {
  orgId: string;
  jobId: string;
  /** "app_<id>" | "src_<id>", as the dashboard knows the person. */
  candidateKey: string;
  /** The run row on screen, so the verdict returned is the one being read. */
  membershipId?: string | null;
  who: Who;
}

async function resolve(t: Target) {
  const role = await roleByExternalId(t.orgId, t.jobId);
  if (!role) return { error: "role_not_found" as const };
  const person = await personKey(t.orgId, t.candidateKey);
  const copies = await storedViews(t.orgId, role.id, t.candidateKey, person.candidateId);
  if (!copies.some((c) => c.view.card?.rows.length)) return { error: "no_card" as const };
  return { role, person, copies };
}

/** Check off one row, or take the check-off back (status null). */
export async function setRowOverride(t: Target & { criterionId: string; status: RowStatus | null; note?: string | null }): Promise<FeedbackResult> {
  try {
    const r = await resolve(t);
    if ("error" in r) return { ok: false, error: r.error! };
    const { role, person, copies } = r;
    const where =
      `verdict_feedback?organization_id=eq.${t.orgId}&org_role_id=eq.${role.id}` +
      `&candidate_key=eq.${encodeURIComponent(person.key)}&kind=eq.override&criterion_id=eq.${encodeURIComponent(t.criterionId)}`;

    if (t.status === null) {
      // Taking back works even when the row has since left the scorecard.
      const del = await sbRest(where, { method: "DELETE", prefer: "return=minimal" });
      if (!del.ok) return { ok: false, error: "save_failed" };
    } else {
      // The row as the recruiter is reading it: its wording is what they
      // confirmed, whatever the scorecard says now.
      const shown = copies.find((c) => c.id === t.membershipId) || copies[0];
      const row = (shown.view.card?.rows || []).find((x) => x.id === t.criterionId) ||
        copies.flatMap((c) => c.view.card?.rows || []).find((x) => x.id === t.criterionId);
      if (!row) return { ok: false, error: "row_not_found" };
      const note = (t.note || "").replace(/\s+/g, " ").trim().slice(0, 240) || null;
      const up = await sbRest("verdict_feedback?on_conflict=organization_id,org_role_id,candidate_key,kind,criterion_id", {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: JSON.stringify({
          organization_id: t.orgId,
          org_role_id: role.id,
          candidate_key: person.key,
          kind: "override",
          criterion_id: t.criterionId,
          criterion_label: row.label,
          tier: row.tier,
          ai_status: row.ai,
          status: t.status,
          note,
          member_email: t.who.email,
          member_name: t.who.name,
          updated_at: new Date().toISOString(),
        }),
      });
      if (!up.ok) return { ok: false, error: "save_failed" };
    }
    const [view] = await Promise.all([
      restamp(t.orgId, role.id, person.key, copies, t.membershipId),
      syncPersonFacts(t.orgId, person.key).catch(() => undefined),
    ]);
    return view ? { ok: true, view } : { ok: false, error: "no_card" };
  } catch (e) {
    console.error("rolecard feedback failed", e);
    return { ok: false, error: "save_failed" };
  }
}

/** The one feedback button: right person, wrong role. A toggle. */
export async function setWrongRole(t: Target & { on: boolean }): Promise<FeedbackResult> {
  try {
    const r = await resolve(t);
    if ("error" in r) return { ok: false, error: r.error! };
    const { role, person, copies } = r;
    const res = t.on
      ? await sbRest("verdict_feedback?on_conflict=organization_id,org_role_id,candidate_key,kind,criterion_id", {
          method: "POST",
          prefer: "resolution=merge-duplicates,return=minimal",
          body: JSON.stringify({
            organization_id: t.orgId,
            org_role_id: role.id,
            candidate_key: person.key,
            kind: "wrong_role",
            criterion_id: "",
            member_email: t.who.email,
            member_name: t.who.name,
            updated_at: new Date().toISOString(),
          }),
        })
      : await sbRest(
          `verdict_feedback?organization_id=eq.${t.orgId}&org_role_id=eq.${role.id}` +
            `&candidate_key=eq.${encodeURIComponent(person.key)}&kind=eq.wrong_role`,
          { method: "DELETE", prefer: "return=minimal" }
        );
    if (!res.ok) return { ok: false, error: "save_failed" };
    const view = await restamp(t.orgId, role.id, person.key, copies, t.membershipId);
    return view ? { ok: true, view } : { ok: false, error: "no_card" };
  } catch (e) {
    console.error("rolecard wrong-role failed", e);
    return { ok: false, error: "save_failed" };
  }
}
