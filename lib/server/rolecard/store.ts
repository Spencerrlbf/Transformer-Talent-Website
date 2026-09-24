// Where a role's scorecard and a person's confirmed facts live.
//
// org_roles.scorecard is dashboard-owned (like target_companies): the role
// sync chain never writes it, so it survives a republish and is editable on
// synced roles. What a recruiter confirmed about a person lives in
// verdict_feedback, one row per person x role x criterion; the facts the
// judge reads for every other role are read from there, so two quick
// check-offs can never overwrite each other. candidate_profiles keeps a copy
// on the person for the steps that follow (signals, best fit).

import { sbRest } from "../supabase";
import { isScorecard, type Criterion, type RowOverride, type RowStatus, type Scorecard } from "@/lib/rolecard";
import { draftScorecard, type DraftInput } from "./draft";

export interface RoleForCard {
  id: string;
  title: string;
  yoe?: string | null;
  description?: string | null;
  jd?: { about?: string; doing?: string[]; needs?: string[]; bonus?: string[] } | null;
  skills?: { skill: string; must_have?: boolean; alternates?: string[] }[] | null;
  matching_profile?: { min_years?: number | null } | null;
  tech_stack?: string | null;
  scorecard?: unknown;
}

/** Columns a caller must select for ensureRoleCard. */
export const ROLE_CARD_COLS = "id,title,yoe,description,jd,skills,matching_profile,tech_stack,scorecard";

/** What the drafter is given for a role: the same for the job page and the scripts. */
export const roleDraftInput = (role: RoleForCard): DraftInput => ({
  title: role.title,
  yoe: role.yoe,
  jd: role.jd,
  description: role.description,
  skills: role.skills,
  techStack: role.tech_stack,
  minYears: role.matching_profile?.min_years ?? null,
});

export async function saveRoleCard(orgRoleId: string, card: Scorecard, onlyIfEmpty = false): Promise<boolean> {
  const res = await sbRest(`org_roles?id=eq.${orgRoleId}${onlyIfEmpty ? "&scorecard=is.null" : ""}`, {
    method: "PATCH",
    body: JSON.stringify({ scorecard: card }),
    prefer: "return=minimal",
  });
  return res.ok;
}

// A draft that failed is not retried on every call: a judging loop would
// otherwise spend its whole time budget drafting. Per warm instance.
const draftFailedAt = new Map<string, number>();
const DRAFT_BACKOFF_MS = 5 * 60_000;

/** The role's scorecard, drafting and saving one the first time a role
 *  without it is opened or judged. Null means none could be had (nothing
 *  written about the role, no key, model down): the judge then reads the
 *  job description on its own, as before. `drafted` tells a time-budgeted
 *  caller that a model call was just spent. */
export async function ensureRoleCard(
  role: RoleForCard,
  opts: { timeoutMs?: number } = {}
): Promise<{ card: Scorecard | null; drafted: boolean }> {
  if (isScorecard(role.scorecard) && role.scorecard.criteria.length) return { card: role.scorecard, drafted: false };
  const failed = draftFailedAt.get(role.id);
  if (failed && Date.now() - failed < DRAFT_BACKOFF_MS) return { card: null, drafted: false };
  const draft = await draftScorecard(
    roleDraftInput(role),
    opts.timeoutMs,
    // A caller on a short leash (a judging loop) gets one repair at most.
    opts.timeoutMs ? opts.timeoutMs * 2 : undefined
  );
  if (!draft) {
    draftFailedAt.set(role.id, Date.now());
    return { card: null, drafted: true };
  }
  // Two judges can reach a bare role together; the first draft wins and the
  // other reads it back, so both judge against the same rows.
  await saveRoleCard(role.id, draft, true);
  const back = await sbRest(`org_roles?id=eq.${role.id}&select=scorecard`);
  const [row] = back.ok ? ((await back.json()) as { scorecard: unknown }[]) : [];
  return { card: isScorecard(row?.scorecard) ? row.scorecard : draft, drafted: true };
}

export const criteriaOf = (card: Scorecard | null): Criterion[] => card?.criteria ?? [];

// ---------- the person ----------

/** The key a person's feedback, facts and saved verdicts are kept under.
 *  Sourced people: "src_<sourced id>". Applicants: "cand_<candidates.id>",
 *  because the same person can apply twice and their verdicts are stored per
 *  candidate, not per application. */
export async function personKey(orgId: string, candidateKey: string): Promise<{ key: string; candidateId: string | null }> {
  if (!candidateKey.startsWith("app_")) return { key: candidateKey, candidateId: null };
  const res = await sbRest(
    `website_applications?organization_id=eq.${orgId}&id=eq.${candidateKey.slice(4)}&select=candidate_id&limit=1`
  );
  if (!res.ok) throw new Error(`personKey: ${res.status}`);
  const [app] = (await res.json()) as { candidate_id: string | null }[];
  return app?.candidate_id ? { key: `cand_${app.candidate_id}`, candidateId: app.candidate_id } : { key: candidateKey, candidateId: null };
}

export interface ConfirmedFact {
  label: string;
  status: Exclude<RowStatus, "unknown">;
  note?: string;
  by: string;
  at: string;
  roleId: string;
  roleTitle: string;
}

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

/** A fact as the judge reads it. */
export function factLine(f: ConfirmedFact): string {
  const word = f.status === "yes" ? "yes" : f.status === "equivalent" ? "has equivalent experience" : "no";
  return `${f.label}: ${word}${f.note ? `. ${f.note}` : ""} (confirmed by ${f.by}, ${day(f.at)}, reviewing for ${f.roleTitle})`;
}

type FeedbackRow = {
  org_role_id: string;
  kind: string;
  criterion_id: string;
  criterion_label: string | null;
  status: RowStatus | null;
  note: string | null;
  member_email: string;
  member_name: string | null;
  updated_at: string;
  org_roles: { title: string } | null;
};

export interface PersonContext {
  /** What a recruiter said about this person on THIS role. */
  overrides: RowOverride[];
  wrongRole: { by: string; at: string } | null;
  /** What was confirmed about them on OTHER roles, oldest first. A
   *  confirmation on this role is already an overrule of its own row; feeding
   *  it to the judge as well would make the judge's "own" read a copy of it,
   *  and taking the overrule back would then restore nothing. */
  facts: ConfirmedFact[];
}

/** Everything recruiters have said about this person, in one read. Throws
 *  when the read fails: a verdict written without the recruiter's rows would
 *  silently undo them, so the caller must treat that as "try again". */
export async function loadPersonContext(orgId: string, orgRoleId: string, key: string): Promise<PersonContext> {
  const res = await sbRest(
    `verdict_feedback?organization_id=eq.${orgId}&candidate_key=eq.${encodeURIComponent(key)}` +
      `&select=org_role_id,kind,criterion_id,criterion_label,status,note,member_email,member_name,updated_at,org_roles(title)` +
      `&order=updated_at.asc`,
    { signal: AbortSignal.timeout(8_000) }
  );
  if (!res.ok) throw new Error(`verdict_feedback read: ${res.status}`);
  const rows = (await res.json()) as FeedbackRow[];
  const ctx: PersonContext = { overrides: [], wrongRole: null, facts: [] };
  for (const r of rows) {
    const by = r.member_name || r.member_email;
    const here = r.org_role_id === orgRoleId;
    if (r.kind === "wrong_role") {
      if (here) ctx.wrongRole = { by, at: r.updated_at };
    } else if (r.kind === "override" && r.status) {
      if (here) ctx.overrides.push({ criterionId: r.criterion_id, label: r.criterion_label, status: r.status, note: r.note, by, at: r.updated_at });
      else if (r.status !== "unknown" && r.criterion_label)
        ctx.facts.push({
          label: r.criterion_label,
          status: r.status,
          ...(r.note ? { note: r.note } : {}),
          by,
          at: r.updated_at,
          roleId: r.org_role_id,
          roleTitle: r.org_roles?.title || "another role",
        });
    }
  }
  return ctx;
}

/** The person's copy of what was confirmed about them, rebuilt whole from
 *  verdict_feedback each time, so concurrent check-offs converge. */
export async function syncPersonFacts(orgId: string, key: string): Promise<void> {
  const res = await sbRest(
    `verdict_feedback?organization_id=eq.${orgId}&candidate_key=eq.${encodeURIComponent(key)}&kind=eq.override` +
      `&status=in.(yes,equivalent,no)&select=org_role_id,criterion_id,criterion_label,status,note,member_email,member_name,updated_at,org_roles(title)` +
      `&order=updated_at.asc`
  );
  if (!res.ok) return;
  const facts = ((await res.json()) as FeedbackRow[]).slice(-40).map((r) => ({
    id: `${r.org_role_id}:${r.criterion_id}`,
    label: r.criterion_label,
    status: r.status,
    note: r.note,
    by: r.member_name || r.member_email,
    byEmail: r.member_email,
    at: r.updated_at,
    roleId: r.org_role_id,
    roleTitle: r.org_roles?.title || null,
  }));
  await sbRest("candidate_profiles?on_conflict=organization_id,candidate_key", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({ organization_id: orgId, candidate_key: key, confirmed_facts: facts, updated_at: new Date().toISOString() }),
  });
}
