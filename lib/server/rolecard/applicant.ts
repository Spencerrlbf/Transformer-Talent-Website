// One applicant against one role's scorecard. The same steps whether the
// person has just applied (the applicant pipeline) or a recruiter asks for
// them to be reviewed again from the dashboard: their LinkedIn profile as
// harvested, their resume as parsed, the role's scorecard (drafted the first
// time a role without one is judged), what recruiters have confirmed about
// them, and a saved verdict when none of that has changed.

import type { VerdictView } from "@/lib/verdict-view";
import { computeFacts, formatFacts, jobTexts } from "../facts";
import { harvestToExperiences, linkedinProfileText } from "../spine";
import { splitStack } from "../scorecard";
import { companySlugFromUrl, employerOf, getCompanyContexts } from "../sourcing/company-context";
import { judgeForRole } from "./judge";
import { criteriaOf, ensureRoleCard } from "./store";

export interface ApplicantRole {
  id: string;
  external_id: string;
  title: string;
  tech_stack: string | null;
  jd: { about?: string; doing?: string[]; needs?: string[]; bonus?: string[] } | null;
  skills: { skill: string; must_have?: boolean; alternates?: string[] }[] | null;
  matching_profile: { must_haves?: string[]; min_years?: number | null } | null;
  target_companies: { name?: string }[] | null;
  yoe: string | null;
  description: string | null;
  scorecard: unknown;
}
export const APPLICANT_ROLE_COLS = "id,external_id,title,tech_stack,yoe,description,jd,skills,matching_profile,target_companies,scorecard";

export interface JudgeApplicantArgs {
  orgId: string;
  candidateId: string;
  name: string | null;
  harvest: Record<string, unknown> | null;
  resumeText: string | null;
  role: ApplicantRole;
  /** How long drafting a missing scorecard may take, and the two together. */
  draftMs?: number;
  totalMs?: number;
  /** "Review against this role's scorecard" means exactly that: with no
   *  scorecard (nothing written about the role, or the draft timed out) it
   *  stops, rather than fall back to the older judge, which has no rows. */
  requireScorecard?: boolean;
}

export async function judgeApplicantForRole(a: JudgeApplicantArgs): Promise<{ view: VerdictView | null; saved: boolean; noScorecard?: boolean }> {
  const { role, harvest } = a;
  const expRows = harvestToExperiences(harvest);
  const eduList = harvest?.education ?? null;
  // Full uncapped skill list from Harvest.
  const harvestSkills = ((harvest?.skills as { name?: string }[] | undefined) || []).map((s) => s?.name || "").filter(Boolean);
  const terms = [...new Set([...splitStack(role.tech_stack), ...(role.skills || []).map((s) => s.skill)])].slice(0, 20);
  const roleFacts = computeFacts(expRows, terms, harvestSkills, eduList);
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
  // Drafting and judging share the time the judge alone had before.
  const t0 = Date.now();
  const total = a.totalMs ?? 40_000;
  const ensured = await ensureRoleCard(role, { timeoutMs: a.draftMs ?? 12_000 }).catch(() => ({ card: null, drafted: false }));
  const criteria = criteriaOf(ensured.card);
  if (a.requireScorecard && !criteria.length) return { view: null, saved: false, noScorecard: true };
  const roleTargets = (role.target_companies || []).map((t) => t?.name || "").filter(Boolean);
  // The current employer's company page, when the cache already has it (a
  // sourcing import fetches pages; an application does not, and must not
  // wait on one): head count and founding year for the report card's facts.
  const exp = Array.isArray(harvest?.experience) ? (harvest!.experience as Record<string, unknown>[]) : [];
  const current = exp.find((e) => /present/i.test(String((e.endDate as Record<string, unknown>)?.text ?? ""))) || exp[0];
  const employerSlug = companySlugFromUrl((current?.companyLinkedinUrl as string) || (current?.companyLink as string) || null);
  const employer = employerSlug ? employerOf((await getCompanyContexts([employerSlug], { cacheOnly: true }).catch(() => new Map())).get(employerSlug)) : null;
  return judgeForRole({
    orgId: a.orgId,
    orgRoleId: role.id,
    // Per candidate, not per application: the same person applying twice
    // keeps their confirmed rows and their saved verdict.
    personKey: `cand_${a.candidateId}`,
    criteria,
    roleTargets,
    input: {
      roleTitle: role.title,
      jdText,
      skills: (role.skills || []).map((s) => ({ skill: s.skill, mustHave: !!s.must_have, alternates: s.alternates || [] })),
      minYears: role.matching_profile?.min_years ?? null,
      targetedCompanies: roleTargets,
      employerContext: null,
      employer,
      education: eduList,
      candidateName: a.name || "Candidate",
      // The whole profile and the whole resume (scorecard-judge.ts guards
      // the total once, at 100,000 characters).
      profileText: linkedinProfileText(harvest, { whole: true }),
      resumeText: a.resumeText,
      factsBlock: formatFacts(roleFacts),
      careerYears: roleFacts.careerYears,
      facts: roleFacts,
      jobs: jobTexts(expRows, eduList),
      model: process.env.SOURCING_JUDGE_MODEL || "gpt-4o",
      timeoutMs: Math.max(20_000, total - (Date.now() - t0)),
    },
    factsFor: (more) => computeFacts(expRows, [...new Set([...terms, ...more])], harvestSkills, eduList),
    roleSkills: (role.skills || []).map((s) => s.skill),
  });
}
