// One way to judge a person for a role, on every path (sourcing, applicants):
// the role's scorecard and what recruiters confirmed about the person on
// other roles go to the judge, the answer is saved so the same inputs always
// give the same verdict, and the recruiter's overrules on this role are laid
// back over it so judging again never flips a row they confirmed.

import crypto from "node:crypto";
import { sbRest } from "../supabase";
import { buildVerdictView, judgeVerdict, VERDICT_PROMPT_VERSION, type VerdictInput } from "../verdict";
import type { CandidateFacts } from "../facts";
import { applyOverrides, type Criterion } from "@/lib/rolecard";
import { isVerdictView, type VerdictView } from "@/lib/verdict-view";
import { factLine, loadPersonContext, type PersonContext } from "./store";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const CACHE_TIMEOUT_MS = 5_000;
/** The judge reads the newest few; the hash covers exactly what it reads. */
const MAX_FACTS = 12;

export interface JudgeForRoleArgs {
  orgId: string;
  orgRoleId: string;
  /** "src_<sourced id>" | "cand_<candidates.id>" (see store.personKey). */
  personKey: string;
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
      person: {
        profile: a.input.profileText,
        resume: a.input.resumeText || "",
        facts: factLines,
        // Career years move with the calendar. Whole years are part of what
        // decides a verdict (a "4+ years" row flips on one); the months are not.
        wholeYears: a.input.careerYears == null ? null : Math.floor(a.input.careerYears),
      },
    })
  );
}

export async function judgeForRole(a: JudgeForRoleArgs): Promise<JudgedForRole> {
  // The recruiter's word first. If it cannot be read, no verdict is written:
  // one written without their rows would quietly undo them. Reported as a
  // transient failure so a run pauses and retries rather than blaming the row.
  let ctx: PersonContext;
  try {
    ctx = await loadPersonContext(a.orgId, a.orgRoleId, a.personKey).catch(() => loadPersonContext(a.orgId, a.orgRoleId, a.personKey));
  } catch {
    a.input.onError?.({ status: 0, code: "feedback_read_failed" });
    return { view: null, saved: false };
  }
  const factLines = ctx.facts.slice(-MAX_FACTS).map(factLine);
  const hash = inputHash(a, factLines);

  const hit = await sbRest(
    `verdict_cache?org_role_id=eq.${a.orgRoleId}&candidate_key=eq.${encodeURIComponent(a.personKey)}&input_hash=eq.${hash}&select=verdict&limit=1`,
    { signal: AbortSignal.timeout(CACHE_TIMEOUT_MS) }
  ).catch(() => null);
  const [cached] = hit?.ok ? ((await hit.json().catch(() => [])) as { verdict: unknown }[]) : [];
  if (cached && isVerdictView(cached.verdict)) {
    return { view: applyOverrides(cached.verdict, ctx.overrides, ctx.wrongRole), saved: true };
  }

  const judged = await judgeVerdict({ ...a.input, criteria: a.criteria, confirmedFacts: factLines });
  if (!judged) return { view: null, saved: false };
  const view = buildVerdictView(judged, a.factsFor, a.roleSkills);

  // Saved as judged, before any overrule: overrules are laid over at read
  // time, so taking one back restores exactly what the judge said. A verdict
  // with a row the model skipped is shown but not kept.
  if (!judged.unassessed) {
    await sbRest("verdict_cache?on_conflict=org_role_id,candidate_key,input_hash", {
      method: "POST",
      prefer: "resolution=ignore-duplicates,return=minimal",
      signal: AbortSignal.timeout(CACHE_TIMEOUT_MS),
      body: JSON.stringify({
        organization_id: a.orgId,
        org_role_id: a.orgRoleId,
        candidate_key: a.personKey,
        input_hash: hash,
        judge_version: VERDICT_PROMPT_VERSION,
        model: a.input.model,
        verdict: view,
      }),
    }).catch(() => null);
  }

  // The model call takes seconds: a row checked off meanwhile must not be
  // written over, so the recruiter's word is read again before it is laid on.
  const now = await loadPersonContext(a.orgId, a.orgRoleId, a.personKey).catch(() => ctx);
  return { view: applyOverrides(view, now.overrides, now.wrongRole), saved: false };
}
