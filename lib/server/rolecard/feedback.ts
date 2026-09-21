// A recruiter's word on a verdict. Overruling a checklist row does three
// things: it is kept against the person and role (so judging again can never
// flip it), it becomes a confirmed fact on the person (so the judge knows it
// for every future role), and every stored copy of that verdict is re-stamped
// so tables, boards and drawers show the new label at once.

import { sbRest } from "../supabase";
import { applyOverrides, isScorecard, type RowStatus, type Tier } from "@/lib/rolecard";
import { isVerdictView, type VerdictView } from "@/lib/verdict-view";
import { loadConfirmedFacts, loadFeedback, saveConfirmedFacts, type ConfirmedFact } from "./store";

// The sourcing tag column only accepts the older vocabulary (CHECK, migration
// 020); the verdict itself carries the real label and every reader prefers it.
const LEGACY_TAG = { contact: "strong_yes", message: "worth_message", pass: "not_now" } as const;

export interface Who {
  email: string;
  name: string;
}

interface RoleRef {
  id: string;
  title: string;
  scorecard: unknown;
}

export async function roleByExternalId(orgId: string, jobId: string): Promise<RoleRef | null> {
  const res = await sbRest(
    `org_roles?organization_id=eq.${orgId}&external_id=eq.${encodeURIComponent(jobId)}&select=id,title,scorecard&limit=1`
  );
  const [row] = res.ok ? ((await res.json()) as RoleRef[]) : [];
  return row || null;
}

type Stored =
  | { kind: "run"; id: string; view: VerdictView }
  | { kind: "match"; id: string; verdict: Record<string, unknown>; view: VerdictView };

/** Every stored copy of this person's verdict for this role. */
async function storedViews(orgId: string, orgRoleId: string, candidateKey: string): Promise<Stored[]> {
  const out: Stored[] = [];
  if (candidateKey.startsWith("src_")) {
    const id = candidateKey.slice(4);
    const res = await sbRest(
      `sourcing_run_candidates?organization_id=eq.${orgId}&sourced_candidate_id=eq.${id}` +
        `&select=id,verdict,sourcing_runs!inner(org_role_id)&sourcing_runs.org_role_id=eq.${orgRoleId}`
    );
    const rows = res.ok ? ((await res.json()) as { id: string; verdict: unknown }[]) : [];
    for (const r of rows) if (isVerdictView(r.verdict)) out.push({ kind: "run", id: r.id, view: r.verdict });
  } else if (candidateKey.startsWith("app_")) {
    const appRes = await sbRest(
      `website_applications?organization_id=eq.${orgId}&id=eq.${candidateKey.slice(4)}&select=candidate_id&limit=1`
    );
    const [app] = appRes.ok ? ((await appRes.json()) as { candidate_id: string | null }[]) : [];
    if (app?.candidate_id) {
      const res = await sbRest(
        `match_verdicts?organization_id=eq.${orgId}&candidate_id=eq.${app.candidate_id}&org_role_id=eq.${orgRoleId}&select=id,verdict`
      );
      const rows = res.ok ? ((await res.json()) as { id: string; verdict: Record<string, unknown> | null }[]) : [];
      for (const r of rows) {
        const v2 = r.verdict?.v2;
        if (isVerdictView(v2)) out.push({ kind: "match", id: r.id, verdict: r.verdict!, view: v2 });
      }
    }
  }
  return out;
}

/** Lay the current feedback over every stored copy. Returns the newest view. */
async function restamp(orgId: string, orgRoleId: string, candidateKey: string): Promise<VerdictView | null> {
  const [copies, feedback] = await Promise.all([
    storedViews(orgId, orgRoleId, candidateKey),
    loadFeedback(orgId, orgRoleId, candidateKey),
  ]);
  let newest: VerdictView | null = null;
  for (const c of copies) {
    if (!c.view.card?.rows.length) continue;
    const view = applyOverrides(c.view, feedback.overrides, feedback.wrongRole);
    if (c.kind === "run") {
      await sbRest(`sourcing_run_candidates?id=eq.${c.id}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify({ verdict: view, tag: LEGACY_TAG[view.label] }),
      });
    } else {
      await sbRest(`match_verdicts?id=eq.${c.id}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify({ verdict: { ...c.verdict, v2: view } }),
      });
    }
    if (!newest || view.at > newest.at) newest = view;
  }
  return newest;
}

export type OverrideResult =
  | { ok: true; view: VerdictView }
  | { ok: false; error: "role_not_found" | "no_card" | "row_not_found" | "save_failed" };

/** Overrule one row, or take the overrule back (status null). */
export async function setRowOverride(args: {
  orgId: string;
  jobId: string;
  candidateKey: string;
  criterionId: string;
  status: RowStatus | null;
  note?: string | null;
  who: Who;
}): Promise<OverrideResult> {
  const role = await roleByExternalId(args.orgId, args.jobId);
  if (!role) return { ok: false, error: "role_not_found" };
  const copies = await storedViews(args.orgId, role.id, args.candidateKey);
  const row = copies.flatMap((c) => c.view.card?.rows || []).find((r) => r.id === args.criterionId);
  if (!copies.some((c) => c.view.card?.rows.length)) return { ok: false, error: "no_card" };
  if (!row) return { ok: false, error: "row_not_found" };
  const criterion = isScorecard(role.scorecard) ? role.scorecard.criteria.find((c) => c.id === args.criterionId) : null;
  const label = criterion?.label || row.label;
  const tier: Tier = criterion?.tier || row.tier;
  const note = (args.note || "").replace(/\s+/g, " ").trim().slice(0, 240) || null;
  const where =
    `verdict_feedback?organization_id=eq.${args.orgId}&org_role_id=eq.${role.id}` +
    `&candidate_key=eq.${encodeURIComponent(args.candidateKey)}&kind=eq.override&criterion_id=eq.${encodeURIComponent(args.criterionId)}`;

  if (args.status === null) {
    const del = await sbRest(where, { method: "DELETE", prefer: "return=minimal" });
    if (!del.ok) return { ok: false, error: "save_failed" };
  } else {
    const now = new Date().toISOString();
    const up = await sbRest("verdict_feedback?on_conflict=organization_id,org_role_id,candidate_key,kind,criterion_id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: JSON.stringify({
        organization_id: args.orgId,
        org_role_id: role.id,
        candidate_key: args.candidateKey,
        kind: "override",
        criterion_id: args.criterionId,
        criterion_label: label,
        tier,
        ai_status: row.ai,
        status: args.status,
        note,
        member_email: args.who.email,
        member_name: args.who.name,
        updated_at: now,
      }),
    });
    if (!up.ok) return { ok: false, error: "save_failed" };
  }

  // The person: a yes, equivalent or no is a fact the judge should know for
  // any role. "Not shown" and a taken-back overrule are not facts.
  const factId = `${role.id}:${args.criterionId}`;
  const facts = (await loadConfirmedFacts(args.orgId, args.candidateKey)).filter((f) => f.id !== factId);
  if (args.status && args.status !== "unknown") {
    const fact: ConfirmedFact = {
      id: factId,
      label,
      status: args.status,
      ...(note ? { note } : {}),
      by: args.who.name,
      byEmail: args.who.email,
      at: new Date().toISOString(),
      roleId: role.id,
      roleTitle: role.title,
    };
    facts.push(fact);
  }
  await saveConfirmedFacts(args.orgId, args.candidateKey, facts);

  const view = await restamp(args.orgId, role.id, args.candidateKey);
  return view ? { ok: true, view } : { ok: false, error: "no_card" };
}

/** The one feedback button: right person, wrong role. A toggle. */
export async function setWrongRole(args: {
  orgId: string;
  jobId: string;
  candidateKey: string;
  on: boolean;
  who: Who;
}): Promise<OverrideResult> {
  const role = await roleByExternalId(args.orgId, args.jobId);
  if (!role) return { ok: false, error: "role_not_found" };
  if (args.on) {
    const up = await sbRest("verdict_feedback?on_conflict=organization_id,org_role_id,candidate_key,kind,criterion_id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: JSON.stringify({
        organization_id: args.orgId,
        org_role_id: role.id,
        candidate_key: args.candidateKey,
        kind: "wrong_role",
        criterion_id: "",
        member_email: args.who.email,
        member_name: args.who.name,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!up.ok) return { ok: false, error: "save_failed" };
  } else {
    const del = await sbRest(
      `verdict_feedback?organization_id=eq.${args.orgId}&org_role_id=eq.${role.id}` +
        `&candidate_key=eq.${encodeURIComponent(args.candidateKey)}&kind=eq.wrong_role`,
      { method: "DELETE", prefer: "return=minimal" }
    );
    if (!del.ok) return { ok: false, error: "save_failed" };
  }
  const view = await restamp(args.orgId, role.id, args.candidateKey);
  return view ? { ok: true, view } : { ok: false, error: "no_card" };
}
