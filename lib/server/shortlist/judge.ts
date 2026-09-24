// Phase 3: the light judge over a role's shortlist. One pool person against
// the role's scorecard, through the same judge every entry path uses
// (lib/server/rolecard/judge.ts), with rows only: no reference quotes and
// no written review. The rows are remembered by hash, so a person judged
// tonight costs nothing tomorrow unless the profile or the card changed,
// and the report card's full judge only adds the quotes and the review.
import crypto from "node:crypto";
import { criteriaOf } from "../rolecard/store";
import { judgeForRole } from "../rolecard/judge";
import { SCORECARD_JUDGE_VERSION } from "../rolecard/scorecard-judge";
import { computeFacts, formatFacts, jobTexts } from "../facts";
import { splitStack } from "../scorecard";
import { poolEducation, poolExperiences, poolProfileText, poolSkills, poolSourceHash, type PoolCandidate } from "../pool/profile";
import type { JudgeSkill } from "../sourcing/judge";
import type { Criterion, Scorecard } from "@/lib/rolecard";
import type { VerdictInput } from "../verdict";
import type { VerdictView } from "@/lib/verdict-view";

export const SHORTLIST_ROLE_COLS = "id,external_id,organization_id,tech_stack,title,yoe,description,jd,skills,matching_profile,target_companies,scorecard";

export interface ShortlistRoleRow {
  id: string;
  external_id: string;
  organization_id: string;
  tech_stack?: string | null;
  title: string;
  yoe?: string | null;
  description?: string | null;
  jd?: { about?: string; doing?: string[]; needs?: string[]; bonus?: string[] } | null;
  skills?: { skill: string; must_have?: boolean; alternates?: string[] }[] | null;
  matching_profile?: { min_years?: number | null; must_haves?: string[] } | null;
  target_companies?: { name?: string }[] | null;
  scorecard?: Scorecard | null;
}

export interface ShortlistRoleContext {
  role: ShortlistRoleRow;
  criteria: Criterion[];
  jdText: string;
  judgeSkills: JudgeSkill[];
  roleTargets: string[];
  minYears: number | null;
  roleWords: NonNullable<VerdictInput["roleWords"]>;
  stackTerms: string[];
  /** Changes when the card's rows or the judge's version change. */
  roleHash: string;
}

/** What a verdict is keyed on for the role side: the rows that decide it. */
export const roleHashOf = (criteria: Criterion[]): string =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify([SCORECARD_JUDGE_VERSION, criteria.map((c) => [c.label, c.tier, c.kind ?? null, c.ladder ?? null, c.metAt ?? null, c.confirmOnCall ?? null])]))
    .digest("hex")
    .slice(0, 32);

/** The same role context the sourcing run builds, minus a search's own targets. */
export function shortlistRoleContext(role: ShortlistRoleRow): ShortlistRoleContext {
  const criteria = criteriaOf(role.scorecard ?? null);
  const jd = role.jd || {};
  const jdText =
    [
      jd.about,
      jd.doing?.length ? `Responsibilities:\n- ${jd.doing.join("\n- ")}` : null,
      jd.needs?.length ? `Requirements:\n- ${jd.needs.join("\n- ")}` : null,
      jd.bonus?.length ? `Nice to have:\n- ${jd.bonus.join("\n- ")}` : null,
    ]
      .filter(Boolean)
      .join("\n\n") || (role.matching_profile?.must_haves || []).join("; ");
  const judgeSkills: JudgeSkill[] = (role.skills || []).map((sk) => ({ skill: sk.skill, must_have: !!sk.must_have, alternates: sk.alternates || [] }));
  const roleTargets = (role.target_companies || []).map((t) => t?.name || "").filter(Boolean);
  return {
    role,
    criteria,
    jdText,
    judgeSkills,
    roleTargets,
    minYears: role.matching_profile?.min_years ?? null,
    roleWords: { about: jd.about, needs: jd.needs, doing: jd.doing, techStack: role.tech_stack },
    stackTerms: splitStack(role.tech_stack).slice(0, 20),
    roleHash: roleHashOf(criteria),
  };
}

export interface PoolJudgement {
  view: VerdictView | null;
  /** Everything came from memory: no model was called. */
  saved: boolean;
  candidateHash: string;
  error: { status: number; code?: string } | null;
}

/** One pool person against the role, rows only. */
export async function judgePoolCandidate(ctx: ShortlistRoleContext, c: PoolCandidate, opts: { timeoutMs?: number; model?: string } = {}): Promise<PoolJudgement> {
  const expRows = poolExperiences(c);
  const education = poolEducation(c);
  const skills = poolSkills(c);
  const facts = computeFacts(expRows, ctx.stackTerms, skills, education);
  let error: PoolJudgement["error"] = null;
  const { view, saved } = await judgeForRole({
    orgId: ctx.role.organization_id,
    orgRoleId: ctx.role.id,
    personKey: `cand_${c.id}`,
    criteria: ctx.criteria,
    roleTargets: ctx.roleTargets,
    input: {
      roleTitle: ctx.role.title,
      jdText: ctx.jdText,
      skills: ctx.judgeSkills.map((s) => ({ skill: s.skill, mustHave: s.must_have, alternates: s.alternates })),
      minYears: ctx.minYears,
      targetedCompanies: ctx.roleTargets,
      employerContext: null,
      employer: null,
      education,
      roleWords: ctx.roleWords,
      candidateName: c.full_name || "Candidate",
      profileText: poolProfileText(c),
      resumeText: null,
      factsBlock: formatFacts(facts),
      careerYears: facts.careerYears,
      facts,
      jobs: jobTexts(expRows, education),
      model: opts.model || process.env.SOURCING_JUDGE_MODEL || "gpt-4o",
      timeoutMs: opts.timeoutMs ?? 45_000,
      light: true,
      onError: (info) => {
        error = { status: info.status, code: info.code };
      },
    },
    factsFor: (terms) => computeFacts(expRows, [...new Set([...ctx.stackTerms, ...terms])], skills, education),
    roleSkills: ctx.judgeSkills.map((s) => s.skill),
  });
  return { view, saved, candidateHash: poolSourceHash(c), error };
}
