// Where a role's scorecard and a person's confirmed facts live.
//
// org_roles.scorecard is dashboard-owned (like target_companies): the role
// sync chain never writes it, so it survives a republish and is editable on
// synced roles. candidate_profiles.confirmed_facts is what a recruiter
// confirmed about a person by overruling a checklist row; the judge reads it
// for every role that person is ever considered for.

import { sbRest } from "../supabase";
import { isScorecard, type Criterion, type RowOverride, type RowStatus, type Scorecard } from "@/lib/rolecard";
import { draftScorecard } from "./draft";

export interface RoleForCard {
  id: string;
  title: string;
  yoe?: string | null;
  description?: string | null;
  jd?: { about?: string; doing?: string[]; needs?: string[]; bonus?: string[] } | null;
  skills?: { skill: string; must_have?: boolean; alternates?: string[] }[] | null;
  matching_profile?: { min_years?: number | null } | null;
  scorecard?: unknown;
}

/** Columns a caller must select for ensureRoleCard. */
export const ROLE_CARD_COLS = "id,title,yoe,description,jd,skills,matching_profile,scorecard";

export async function saveRoleCard(orgRoleId: string, card: Scorecard, onlyIfEmpty = false): Promise<boolean> {
  const res = await sbRest(`org_roles?id=eq.${orgRoleId}${onlyIfEmpty ? "&scorecard=is.null" : ""}`, {
    method: "PATCH",
    body: JSON.stringify({ scorecard: card }),
    prefer: "return=minimal",
  });
  return res.ok;
}

/** The role's criteria, drafting and saving a scorecard the first time a role
 *  without one is opened or judged. An empty list means no scorecard could be
 *  had (no key, model down): the judge then falls back to reading the job
 *  description on its own, as before. */
export async function ensureRoleCard(role: RoleForCard): Promise<Scorecard | null> {
  if (isScorecard(role.scorecard) && role.scorecard.criteria.length) return role.scorecard;
  const drafted = await draftScorecard({
    title: role.title,
    yoe: role.yoe,
    jd: role.jd,
    description: role.description,
    skills: role.skills,
    minYears: role.matching_profile?.min_years ?? null,
  });
  if (!drafted) return null;
  // Two judges can reach a bare role together; the first draft wins and the
  // other reads it back, so both judge against the same rows.
  await saveRoleCard(role.id, drafted, true);
  const back = await sbRest(`org_roles?id=eq.${role.id}&select=scorecard`);
  const [row] = back.ok ? ((await back.json()) as { scorecard: unknown }[]) : [];
  return isScorecard(row?.scorecard) ? row.scorecard : drafted;
}

export const criteriaOf = (card: Scorecard | null): Criterion[] => card?.criteria ?? [];

// ---------- the person ----------

export interface ConfirmedFact {
  /** `${orgRoleId}:${criterionId}`: one fact per row a recruiter ruled on. */
  id: string;
  label: string;
  status: Exclude<RowStatus, "unknown">;
  note?: string;
  by: string;
  byEmail: string;
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

export async function loadConfirmedFacts(orgId: string, candidateKey: string): Promise<ConfirmedFact[]> {
  const res = await sbRest(
    `candidate_profiles?organization_id=eq.${orgId}&candidate_key=eq.${encodeURIComponent(candidateKey)}&select=confirmed_facts&limit=1`
  );
  const [row] = res.ok ? ((await res.json()) as { confirmed_facts: ConfirmedFact[] | null }[]) : [];
  return Array.isArray(row?.confirmed_facts) ? row.confirmed_facts : [];
}

export async function saveConfirmedFacts(orgId: string, candidateKey: string, facts: ConfirmedFact[]): Promise<boolean> {
  const res = await sbRest("candidate_profiles?on_conflict=organization_id,candidate_key", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({
      organization_id: orgId,
      candidate_key: candidateKey,
      confirmed_facts: facts.slice(-40),
      updated_at: new Date().toISOString(),
    }),
  });
  return res.ok;
}

export interface PersonFeedback {
  overrides: RowOverride[];
  wrongRole: { by: string; at: string } | null;
}

/** Everything a recruiter said about this person on this role. */
export async function loadFeedback(orgId: string, orgRoleId: string, candidateKey: string): Promise<PersonFeedback> {
  const res = await sbRest(
    `verdict_feedback?organization_id=eq.${orgId}&org_role_id=eq.${orgRoleId}&candidate_key=eq.${encodeURIComponent(candidateKey)}` +
      `&select=kind,criterion_id,status,note,member_email,member_name,updated_at`
  );
  const rows = res.ok
    ? ((await res.json()) as { kind: string; criterion_id: string; status: RowStatus | null; note: string | null; member_email: string; member_name: string | null; updated_at: string }[])
    : [];
  const overrides: RowOverride[] = [];
  let wrongRole: PersonFeedback["wrongRole"] = null;
  for (const r of rows) {
    const by = r.member_name || r.member_email;
    if (r.kind === "wrong_role") wrongRole = { by, at: r.updated_at };
    else if (r.kind === "override" && r.status) overrides.push({ criterionId: r.criterion_id, status: r.status, note: r.note, by, at: r.updated_at });
  }
  return { overrides, wrongRole };
}
