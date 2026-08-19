// The sourced-candidate judge: an engineering-manager read of a LinkedIn
// profile against a JD. Sourced profiles carry no resume, so this judge
// INFERS — from titles, employers, tenure, role descriptions, and declared
// skill alternates — the way a technical hiring manager actually reads a
// profile. The apply flow's strict evidence engine is untouched; this is
// the sourcing module's own judgment path.
//
// Discipline that keeps "just ask the AI" reliable at 500-candidate scale:
// anchored rubric (no drift), temperature 0 + strict schema (deterministic),
// computed FACTS supplied for all numbers (the model never does date math),
// and thin code rails after the call (contradictions cap the tag; unknowns
// never punish).

export interface JudgeSkill {
  skill: string;
  must_have: boolean;
  alternates: string[];
}

export interface JudgeInput {
  roleTitle: string;
  jdText: string; // about + responsibilities + requirements, assembled by caller
  skills: JudgeSkill[];
  minYears: number | null;
  profileText: string; // linkedinProfileText output
  factsBlock: string; // formatFacts output — the model's only source of numbers
  careerYears: number | null; // code-computed, for the rails
  targetedCompanies?: string[]; // companies the employer explicitly searched for
  currentEmployerContext?: string | null; // cached company-context line
  timeoutMs?: number;
  model?: string;
  onError?: (info: { status: number; code?: string; retryAfter?: string }) => void;
}

export type JudgeTag = "strong_yes" | "yes" | "worth_message" | "not_now";

export interface JudgeVerdict {
  tag: JudgeTag;
  why_fit: string;
  gaps_to_probe: string[];
  judge: string; // e.g. "em-v2/gpt-4o"
}

const RUBRIC = `TAG DEFINITIONS (anchor every judgment to these four):
- strong_yes: You would put this person in front of the hiring manager TODAY, and call them first. Seniority fits, nothing is contradicted, and EITHER the core requirements are demonstrated/near-certain OR the alignment is overwhelming — e.g. they are doing essentially this job right now at a company the employer targeted (or an obvious peer), or they carry elite-calibre experience in the same domain. One unconfirmed skill does NOT block strong_yes when alignment is overwhelming.
  Worked example: role wants a senior TypeScript agent-platform engineer; candidate has 6 years, currently leads agent platform development at a company the employer targeted, deep JavaScript history but TypeScript unlisted → strong_yes ("doing this exact job at a targeted company; JS→TS ramp is days").
- yes: Call-worthy this week. Real fit signals; one or two meaningful requirements unconfirmed or satisfied via a clearly-argued adjacent skill.
  Worked example: role wants Python; candidate has 5 years of production Golang backend work at credible companies → yes ("missing Python, the #1 skill, but production Golang demonstrates the same backend systems depth; language ramp is weeks").
- worth_message: Not a clear fit on requirements, but the calibre or trajectory justifies thirty seconds of outreach — strong company pedigree, impressive trajectory, adjacent domain. A cheap LinkedIn message, not a call.
- not_now: A core requirement is CONTRADICTED — verified years clearly under the bar, genuinely different discipline, or seniority far off. Skip unless the pipeline is thin.

JUDGING RULES:
1. You have ONLY a LinkedIn profile — no resume. Infer generously from titles, employers, tenure, and role descriptions. An engineer at a company known for a stack plausibly uses that stack even when their profile lists nothing.
2. Company signals are evidence. If the employer TARGETED the candidate's company in their search, treat employment there (in the right kind of role at the right seniority) as strong fit evidence by construction — the employer chose that talent pool deliberately. Independently, sustained tenure at companies with famously high hiring bars is evidence of general engineering excellence; use the provided employer context for companies you do not recognize.
3. Trajectory is evidence: rapid promotions, founding-team roles, and progression into scope all count.
4. Adjacent skills count, and you must SAY SO explicitly: when a required skill is absent but a near-equivalent is present, name the equivalence and what transfers.
5. Some skills list acceptable alternates declared by the employer — an alternate fully satisfies that skill.
6. Unconfirmed is NOT disqualifying: absence of evidence lowers confidence and becomes a probe question. Only contradictions push to not_now.
7. Use ONLY the numbers in the FACTS block for years and tenure — never compute your own.
8. An unnecessary outreach costs minutes; a missed great candidate costs a hire. When genuinely torn between two adjacent tags, choose the higher one.

OUTPUT:
- why_fit: 2-3 concrete sentences a hiring manager would respect, citing the profile (companies, titles, durations, inferred capabilities). No hedging boilerplate.
- gaps_to_probe: at most 3, each phrased as a specific question to ask in a first conversation. Empty array if there is genuinely nothing to probe.`;

export async function judgeSourcedCandidate(input: JudgeInput): Promise<JudgeVerdict | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const model = input.model || process.env.SOURCING_JUDGE_MODEL || "gpt-4o";

  const skillsBlock = input.skills.length
    ? input.skills
        .map(
          (s) =>
            `- ${s.skill}${s.must_have ? " (must-have)" : " (nice-to-have)"}` +
            (s.alternates.length ? ` — employer also accepts: ${s.alternates.join(", ")}` : "")
        )
        .join("\n")
    : "(no explicit skill list — judge from the JD text)";

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(input.timeoutMs ?? 20_000),
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "judgment",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              tag: { type: "string", enum: ["strong_yes", "yes", "worth_message", "not_now"] },
              why_fit: { type: "string" },
              gaps_to_probe: { type: "array", items: { type: "string" } },
            },
            required: ["tag", "why_fit", "gaps_to_probe"],
          },
        },
      },
      messages: [
        {
          role: "system",
          content:
            "You are an experienced engineering manager who has hired many engineers, deciding " +
            "whether a sourced candidate deserves a first call for your open role.\n\n" + RUBRIC,
        },
        {
          role: "user",
          content:
            `ROLE: ${input.roleTitle}${input.minYears ? ` (${input.minYears}+ years)` : ""}\n\n` +
            `JOB DESCRIPTION:\n${input.jdText.slice(0, 5000)}\n\n` +
            `REQUIRED SKILLS:\n${skillsBlock}\n\n` +
            (input.targetedCompanies?.length
              ? `SEARCH CONTEXT: the employer explicitly targeted candidates at these companies: ${input.targetedCompanies.join(", ")}\n\n`
              : "") +
            (input.currentEmployerContext
              ? `CANDIDATE'S CURRENT EMPLOYER: ${input.currentEmployerContext}\n\n`
              : "") +
            `CANDIDATE (LinkedIn profile — no resume available):\n${input.profileText.slice(0, 5000)}\n\n` +
            `FACTS (computed from dated position history — use these numbers verbatim):\n${input.factsBlock}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    if (input.onError) {
      let code: string | undefined;
      try { code = (await res.json())?.error?.code; } catch { /* body unreadable */ }
      input.onError({ status: res.status, code, retryAfter: res.headers.get("retry-after") ?? undefined });
    }
    return null;
  }

  try {
    const data = await res.json();
    const out = JSON.parse(data.choices[0].message.content) as Omit<JudgeVerdict, "judge">;
    if (!out.tag || !out.why_fit) return null;
    let tag = out.tag;
    // Rail: a code-verified years shortfall (>1yr under the bar) blocks the
    // top two tiers no matter how persuasive the narrative — the judge may
    // argue calibre, but verified experience math is not negotiable.
    if (
      (tag === "strong_yes" || tag === "yes") &&
      input.minYears != null &&
      input.careerYears != null &&
      input.careerYears < input.minYears - 1
    ) {
      tag = "worth_message";
      out.gaps_to_probe = [
        `Verify total experience — dated history shows ${input.careerYears} yrs vs ${input.minYears}+ required`,
        ...out.gaps_to_probe,
      ].slice(0, 3);
    }
    return {
      tag,
      why_fit: out.why_fit.slice(0, 600),
      gaps_to_probe: (out.gaps_to_probe || []).slice(0, 3).map((g) => g.slice(0, 200)),
      judge: `em-v2/${model}`,
    };
  } catch {
    return null;
  }
}

/** Client-facing reason line assembled from the judgment. */
export function judgeReason(v: JudgeVerdict): string {
  const probe = v.gaps_to_probe.length ? ` Worth asking: ${v.gaps_to_probe.join(" · ")}` : "";
  return `${v.why_fit}${probe}`;
}
