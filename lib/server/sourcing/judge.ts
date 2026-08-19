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
  timeoutMs?: number;
  model?: string;
  onError?: (info: { status: number; code?: string; retryAfter?: string }) => void;
}

export interface JudgeVerdict {
  tag: "strong" | "possible" | "stretch";
  why_fit: string;
  gaps_to_probe: string[];
  judge: string; // e.g. "em-v1/gpt-4o-mini"
}

const RUBRIC = `TAG DEFINITIONS (anchor your judgment to these):
- strong: You would confidently put this person in front of the hiring manager today. Seniority fits, and the core technical requirements are demonstrated or near-certain from their history. Example: the role wants a senior backend engineer with Python; they have 5 years of production backend work at credible companies, Python or an equivalent clearly in the picture.
- possible: Worth a first call. Real signals of fit, but at least one meaningful requirement is unconfirmed or met via an adjacent skill. Example: the role wants Python; they have solid production Golang — same backend fundamentals, language ramp is short. Say exactly that.
- stretch: You would only call them if the pipeline were thin. A core requirement is contradicted (not merely unconfirmed), the seniority is clearly off, or the domain is genuinely different.

JUDGING RULES:
1. You have ONLY a LinkedIn profile — no resume. Infer generously from titles, employers, tenure, and role descriptions. An engineer at a company known for a stack plausibly uses that stack even when their profile lists nothing.
2. Adjacent skills count, and you must SAY SO explicitly: when a required skill is absent but a near-equivalent is present, name the equivalence and what transfers (e.g. "missing Python, but 4 years of production Golang shows the same backend systems depth; the ramp is weeks").
3. Some skills list acceptable alternates declared by the employer — treat an alternate as fully satisfying that skill.
4. Unconfirmed is NOT disqualifying: absence of evidence lowers confidence, it does not contradict. Only contradictions (wrong seniority, wrong domain, clearly insufficient experience) push toward stretch.
5. Use ONLY the numbers in the FACTS block for years and tenure — never compute your own.
6. An unnecessary outreach costs minutes; a missed great candidate costs a hire. When genuinely torn between two tags, choose the higher one.

OUTPUT:
- why_fit: 2-3 concrete sentences a hiring manager would respect, citing the profile (companies, titles, durations, inferred capabilities). No hedging boilerplate.
- gaps_to_probe: at most 3, each phrased as a specific question to ask on a first call. Empty array if there is genuinely nothing to probe.`;

export async function judgeSourcedCandidate(input: JudgeInput): Promise<JudgeVerdict | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const model = input.model || process.env.SOURCING_JUDGE_MODEL || "gpt-4o-mini";

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
              tag: { type: "string", enum: ["strong", "possible", "stretch"] },
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
    // Rail: a code-verified years contradiction caps the tag — the judge may
    // argue the fit, but it cannot call someone 'strong' who verifiably
    // lacks the required experience by more than a year.
    if (
      tag === "strong" &&
      input.minYears != null &&
      input.careerYears != null &&
      input.careerYears < input.minYears - 1
    ) {
      tag = "possible";
      out.gaps_to_probe = [
        `Verify total experience — dated history shows ${input.careerYears} yrs vs ${input.minYears}+ required`,
        ...out.gaps_to_probe,
      ].slice(0, 3);
    }
    return {
      tag,
      why_fit: out.why_fit.slice(0, 600),
      gaps_to_probe: (out.gaps_to_probe || []).slice(0, 3).map((g) => g.slice(0, 200)),
      judge: `em-v1/${model}`,
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
