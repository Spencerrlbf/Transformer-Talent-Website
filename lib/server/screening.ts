import profilesJson from "@/data/matching-profiles.json";

export interface MatchingProfile {
  must_haves: string[];
  nice_to_haves: string[];
  screening_questions: string[];
  min_years: number | null;
  visa_transfer_ok: boolean;
  onsite_city: string | null;
}

const PROFILES = profilesJson as Record<string, MatchingProfile>;

export function profileFor(jobId: string): MatchingProfile | undefined {
  return PROFILES[jobId];
}

// Hard gates run in code — free, and absolute.
export function passesHardGates(
  jobId: string,
  applicant: { visa: string | null; years: number | null }
): boolean {
  const p = PROFILES[jobId];
  if (!p) return true;
  const needsSponsorship =
    !!applicant.visa && !/none needed|citizen|green card/i.test(applicant.visa);
  if (needsSponsorship && !p.visa_transfer_ok) return false;
  if (p.min_years && applicant.years !== null && applicant.years < p.min_years - 1) return false;
  return true;
}

export interface ScreeningResult {
  job_id: string;
  qualified: boolean;
  fit_score: number;
  meets: string[];
  unclear: string[];
  fails: string[];
}

// ONE batched LLM call evaluates a candidate against up to 5 role checklists.
// Bounded by design: never called per-role, never with more than 5 roles.
export async function screenCandidate(
  candidateSummary: string,
  jobIds: string[]
): Promise<ScreeningResult[]> {
  const key = process.env.OPENAI_API_KEY;
  const targets = jobIds
    .slice(0, 5)
    .map((id) => ({ id, p: PROFILES[id] }))
    .filter((t) => t.p);
  if (!key || !targets.length || !candidateSummary) return [];

  const rolesBlock = targets
    .map(
      (t) =>
        `ROLE ${t.id}:\nMUST-HAVES: ${t.p.must_haves.join("; ")}\nQUESTIONS: ${t.p.screening_questions.join(" | ")}`
    )
    .join("\n\n");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "screening",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              results: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    job_id: { type: "string" },
                    qualified: { type: "boolean" },
                    fit_score: { type: "number" },
                    meets: { type: "array", items: { type: "string" } },
                    unclear: { type: "array", items: { type: "string" } },
                    fails: { type: "array", items: { type: "string" } },
                  },
                  required: ["job_id", "qualified", "fit_score", "meets", "unclear", "fails"],
                },
              },
            },
            required: ["results"],
          },
        },
      },
      messages: [
        {
          role: "system",
          content:
            "You are screening one candidate against several roles, like a rigorous recruiter. " +
            "For each role: check every must-have against the candidate's evidence. " +
            "meets = requirements clearly satisfied (short phrases citing evidence). " +
            "fails = requirements clearly NOT met. unclear = cannot tell from the data. " +
            "qualified = no fails and at least half of must-haves met. " +
            "fit_score = 0-1 overall fit judgment. Be strict: unsupported claims are 'unclear', not 'meets'.",
        },
        { role: "user", content: `CANDIDATE:\n${candidateSummary.slice(0, 6000)}\n\n${rolesBlock}` },
      ],
    }),
  });
  if (!res.ok) return [];
  try {
    const data = await res.json();
    return (JSON.parse(data.choices[0].message.content).results as ScreeningResult[]).filter((r) =>
      targets.some((t) => t.id === r.job_id)
    );
  } catch {
    return [];
  }
}

// JD-matcher stage 2: one bounded call screens the top anonymized matches
// against the hiring manager's extracted requirements.
export interface JDFit {
  ref: string;
  strengths: string; // strongest evidenced fit, short
  verify: string; // main thing to probe on a call, short
}

export async function screenAgainstJD(
  jdSummary: string,
  requirements: string[],
  candidates: { ref: string; profileText: string }[]
): Promise<JDFit[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !requirements.length || !candidates.length) return [];
  const block = candidates
    .slice(0, 5)
    .map((c) => `CANDIDATE ${c.ref}:\n${c.profileText.slice(0, 1500)}`)
    .join("\n\n");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "jd_fit",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              results: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    ref: { type: "string" },
                    strengths: { type: "string" },
                    verify: { type: "string" },
                  },
                  required: ["ref", "strengths", "verify"],
                },
              },
            },
            required: ["results"],
          },
        },
      },
      messages: [
        {
          role: "system",
          content:
            "For each candidate, write a recruiter's read against the role. " +
            "strengths: the strongest evidenced fit signals (max 12 words, e.g. 'Staff-level infra depth, ex-FAANG, right market'). " +
            "verify: the one thing to probe on a call (max 10 words, e.g. 'hands-on Go in production'). " +
            "Anonymized profiles are sparse — judge what IS there generously, flag what's absent as verify, never as failure. Never invent.",
        },
        {
          role: "user",
          content: `ROLE: ${jdSummary.slice(0, 1200)}\nREQUIREMENTS: ${requirements.join("; ")}\n\n${block}`,
        },
      ],
    }),
  });
  if (!res.ok) return [];
  try {
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content).results as JDFit[];
  } catch {
    return [];
  }
}
