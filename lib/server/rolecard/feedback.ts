// A recruiter's word on a verdict. Checking off a scorecard row does three
// things: it is kept against the person and role (so judging again can never
// flip it), it becomes a confirmed fact about the person (so the judge knows
// it for every other role), and every stored copy of that verdict is
// re-stamped so tables, boards and drawers show the new label at once.

import { sbRest } from "../supabase";
import { applyOverrides, isScorecard, type Criterion, type RowStatus } from "@/lib/rolecard";
import { isVerdictView, type VerdictView } from "@/lib/verdict-view";
import { loadPersonContext, personKey, syncPersonFacts } from "./store";

// The sourcing tag column only accepts the older vocabulary (CHECK, migration
// 020); the verdict itself carries the real label and every reader prefers it.
const LEGACY_TAG = { contact: "strong_yes", message: "worth_message", pass: "not_now" } as const;

export interface Who {
  email: string;
  name: string;
}

export async function roleByExternalId(orgId: string, jobId: string): Promise<{ id: string; title: string; criteria: Criterion[] } | null> {
  const res = await sbRest(
    `org_roles?organization_id=eq.${orgId}&external_id=eq.${encodeURIComponent(jobId)}&select=id,title,scorecard&limit=1`
  );
  const [row] = res.ok ? ((await res.json()) as { id: string; title: string; scorecard: unknown }[]) : [];
  return row ? { id: row.id, title: row.title, criteria: isScorecard(row.scorecard) ? row.scorecard.criteria : [] } : null;
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
      // (by person and role only: screening files its rows under the site's own
      // organisation whichever board the person applied through, and the role
      // id is already this organisation's)
      `match_verdicts?candidate_id=eq.${candidateId}&org_role_id=eq.${orgRoleId}&select=id,verdict`
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
async function restamp(orgId: string, orgRoleId: string, key: string, copies: Stored[], criteria: Criterion[], showing?: string | null): Promise<VerdictView | null> {
  const ctx = await loadPersonContext(orgId, orgRoleId, key);
  let shown: VerdictView | null = null;
  let newest: VerdictView | null = null;
  for (const c of copies) {
    if (!c.view.card?.rows.length) continue;
    const view = applyOverrides(c.view, ctx.overrides, ctx.wrongRole, criteria.length ? criteria : undefined);
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
      restamp(t.orgId, role.id, person.key, copies, role.criteria, t.membershipId),
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
    const view = await restamp(t.orgId, role.id, person.key, copies, role.criteria, t.membershipId);
    return view ? { ok: true, view } : { ok: false, error: "no_card" };
  } catch (e) {
    console.error("rolecard wrong-role failed", e);
    return { ok: false, error: "save_failed" };
  }
}

/** "Confirm on a call" is a setting of the role. When it changes, every stored
 *  verdict for the role is re-labelled from its own rows: nobody is judged
 *  again, and every list, board and drawer shows the new label at once.
 *  Returns how many people's label or call questions changed. */
export async function relabelRole(orgId: string, orgRoleId: string, criteria: Criterion[]): Promise<number> {
  const MAX = 3000;
  const fbRes = await sbRest(
    `verdict_feedback?organization_id=eq.${orgId}&org_role_id=eq.${orgRoleId}&select=candidate_key,kind,criterion_id,criterion_label,status,note,member_email,member_name,updated_at&limit=5000`
  );
  if (!fbRes.ok) throw new Error(`relabel: feedback read ${fbRes.status}`);
  type Fb = { candidate_key: string; kind: string; criterion_id: string; criterion_label: string | null; status: RowStatus | null; note: string | null; member_email: string; member_name: string | null; updated_at: string };
  const byPerson = new Map<string, { overrides: Parameters<typeof applyOverrides>[1]; wrongRole: { by: string; at: string } | null }>();
  for (const f of (await fbRes.json()) as Fb[]) {
    const p = byPerson.get(f.candidate_key) || { overrides: [], wrongRole: null };
    const by = f.member_name || f.member_email;
    if (f.kind === "wrong_role") p.wrongRole = { by, at: f.updated_at };
    else if (f.status) p.overrides.push({ criterionId: f.criterion_id, label: f.criterion_label, status: f.status, note: f.note, by, at: f.updated_at });
    byPerson.set(f.candidate_key, p);
  }
  const changedFrom = (a: VerdictView, b: VerdictView) =>
    a.label !== b.label ||
    JSON.stringify(a.card?.confirm || []) !== JSON.stringify(b.card?.confirm || []) ||
    JSON.stringify((a.card?.rows || []).map((r) => [!!r.call, r.status, r.ai])) !== JSON.stringify((b.card?.rows || []).map((r) => [!!r.call, r.status, r.ai]));
  let changed = 0;
  const todo: (() => Promise<void>)[] = [];

  const runRes = await sbRest(
    `sourcing_run_candidates?organization_id=eq.${orgId}&verdict=not.is.null&select=id,sourced_candidate_id,verdict,sourcing_runs!inner(org_role_id)&sourcing_runs.org_role_id=eq.${orgRoleId}&limit=${MAX}`
  );
  const runRows = runRes.ok ? ((await runRes.json()) as { id: string; sourced_candidate_id: string; verdict: unknown }[]) : [];
  for (const r of runRows) {
    if (!isVerdictView(r.verdict) || !r.verdict.card?.rows.length) continue;
    const fb = byPerson.get(`src_${r.sourced_candidate_id}`);
    const next = applyOverrides(r.verdict, fb?.overrides || [], fb?.wrongRole || null, criteria);
    if (!changedFrom(r.verdict, next)) continue;
    changed++;
    todo.push(async () => {
      await sbRest(`sourcing_run_candidates?id=eq.${r.id}`, { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ verdict: next, tag: LEGACY_TAG[next.label] }) });
    });
  }
  const mvRes = await sbRest(`match_verdicts?org_role_id=eq.${orgRoleId}&select=id,candidate_id,verdict&limit=${MAX}`);
  const mvRows = mvRes.ok ? ((await mvRes.json()) as { id: string; candidate_id: string; verdict: Record<string, unknown> | null }[]) : [];
  for (const r of mvRows) {
    const v2 = r.verdict?.v2;
    if (!isVerdictView(v2) || !v2.card?.rows.length) continue;
    const fb = byPerson.get(`cand_${r.candidate_id}`);
    const next = applyOverrides(v2, fb?.overrides || [], fb?.wrongRole || null, criteria);
    if (!changedFrom(v2, next)) continue;
    changed++;
    todo.push(async () => {
      await sbRest(`match_verdicts?id=eq.${r.id}`, { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ verdict: { ...r.verdict, v2: next } }) });
    });
  }
  if (runRows.length >= MAX || mvRows.length >= MAX) console.warn(`relabel: role ${orgRoleId} has more stored verdicts than ${MAX}; the rest keep their label until reviewed again`);
  for (let i = 0; i < todo.length; i += 6) await Promise.all(todo.slice(i, i + 6).map((t) => t()));
  return changed;
}
