// One way to judge a person for a role, on every path (sourcing, applicants):
// the role's scorecard and the person's confirmed facts go to the judge, the
// answer is saved so the same inputs always give the same verdict, and the
// recruiter's overrules are laid back over it so judging again never flips a
// row they confirmed.

import crypto from "node:crypto";
import { sbRest } from "../supabase";
import { buildVerdictView, judgeVerdict, VERDICT_PROMPT_VERSION, type VerdictInput } from "../verdict";
import type { CandidateFacts } from "../facts";
import { applyOverrides, type Criterion } from "@/lib/rolecard";
import { isVerdictView, type VerdictView } from "@/lib/verdict-view";
import { factLine, loadConfirmedFacts, loadFeedback } from "./store";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export interface JudgeForRoleArgs {
  orgId: string;
  orgRoleId: string;
  /** "app_<id>" | "src_<id>" */
  candidateKey: string;
  criteria: Criterion[];
  input: Omit<VerdictInput, "criteria" | "confirmedFacts">;
  /** Role-level target companies: part of what makes a verdict reusable.
   *  Companies one search happened to target are not, or the same person
   *  would read differently from one search to the next. */
  roleTargets: string[];
  factsFor: (terms: string[]) => CandidateFacts | null;
  roleSkills: string[];
}

export interface JudgedForRole {
  view: VerdictView | null;
  /** True when a saved verdict was reused and no model was called. */
  saved: boolean;
}

/** What decides a verdict, and nothing that drifts: career years move with
 *  the calendar and employer context with a cache, so the hash is over the
 *  stored profile and the role as written. */
function inputHash(a: JudgeForRoleArgs, factLines: string[]): string {
  return sha(
    JSON.stringify({
      judge: VERDICT_PROMPT_VERSION,
      model: a.input.model,
      role: {
        title: a.input.roleTitle,
        jd: a.input.jdText,
        skills: a.input.skills,
        minYears: a.input.minYears,
        targets: [...a.roleTargets].map((t) => t.toLowerCase()).sort(),
        criteria: a.criteria.map((c) => [c.id, c.label, c.tier, c.good || ""]),
      },
      person: { profile: a.input.profileText, resume: a.input.resumeText || "", facts: factLines },
    })
  );
}

export async function judgeForRole(a: JudgeForRoleArgs): Promise<JudgedForRole> {
  const [facts, feedback] = await Promise.all([
    loadConfirmedFacts(a.orgId, a.candidateKey).catch(() => []),
    loadFeedback(a.orgId, a.orgRoleId, a.candidateKey).catch(() => ({ overrides: [], wrongRole: null })),
  ]);
  const factLines = facts.map(factLine);
  const hash = inputHash(a, factLines);

  const hit = await sbRest(
    `verdict_cache?org_role_id=eq.${a.orgRoleId}&candidate_key=eq.${encodeURIComponent(a.candidateKey)}&input_hash=eq.${hash}&select=verdict&limit=1`
  ).catch(() => null);
  const [cached] = hit?.ok ? ((await hit.json()) as { verdict: unknown }[]) : [];
  if (cached && isVerdictView(cached.verdict)) {
    return { view: applyOverrides(cached.verdict, feedback.overrides, feedback.wrongRole), saved: true };
  }

  const judged = await judgeVerdict({ ...a.input, criteria: a.criteria, confirmedFacts: factLines });
  if (!judged) return { view: null, saved: false };
  const view = buildVerdictView(judged, a.factsFor, a.roleSkills);

  // Saved as judged, before any overrule: overrules are laid over at read
  // time, so taking one back restores exactly what the judge said.
  await sbRest("verdict_cache?on_conflict=org_role_id,candidate_key,input_hash", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=minimal",
    body: JSON.stringify({
      organization_id: a.orgId,
      org_role_id: a.orgRoleId,
      candidate_key: a.candidateKey,
      input_hash: hash,
      judge_version: VERDICT_PROMPT_VERSION,
      model: a.input.model,
      verdict: view,
    }),
  }).catch(() => null);

  return { view: applyOverrides(view, feedback.overrides, feedback.wrongRole), saved: false };
}
