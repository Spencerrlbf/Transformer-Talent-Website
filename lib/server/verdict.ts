// The verdict: one recruiter-facing paragraph per candidate per role, with an
// action label. Written to be read in ten seconds before deciding whether to
// contact someone. One judge for every way a person enters the system; the
// FACTS block supplies every number, the model supplies the reading.
//
// Discipline: anchored label definitions, temperature 0, strict schema, code
// rails after the call (a verified years shortfall caps the label).

export type VerdictLabel = "contact" | "message" | "pass";

export const VERDICT_LABEL: Record<VerdictLabel, string> = {
  contact: "Contact now",
  message: "Worth a message",
  pass: "Pass",
};

export const VERDICT_PROMPT_VERSION = "v1";

export interface VerdictSkill {
  skill: string;
  mustHave: boolean;
  alternates: string[];
}

export interface VerdictInput {
  roleTitle: string;
  jdText: string;
  skills: VerdictSkill[];
  minYears: number | null;
  targetedCompanies: string[];
  employerContext: string | null;
  candidateName: string;
  profileText: string;
  resumeText: string | null;
  factsBlock: string;
  careerYears: number | null;
  model: string;
  timeoutMs?: number;
}

export interface Verdict {
  label: VerdictLabel;
  paragraph: string;
  /** Plain statements of what the profile does not show or contradicts. */
  missing: string[];
  /** Questions for a first call. */
  ask: string[];
  /** For pass/message: where they would fit. */
  betterSuited: string;
  model: string;
  promptVersion: string;
  usage: { input: number; output: number };
  ms: number;
}

const SYSTEM = `You are a senior technical recruiter writing the note a hiring manager reads in ten seconds to decide whether to contact a candidate for one role. You have the candidate's LinkedIn profile (and a resume when supplied), a FACTS block computed from their dated positions, and the role.

WRITE ONE PARAGRAPH of 3 to 5 sentences, at most 80 words, in this order:
1. Who they are: current title, company, and career years (from FACTS).
2. Why they fit: the requirements they clearly meet, with the evidence (companies, titles, durations, listed skills). When a required skill is absent but an equivalent is present, say so plainly and name what transfers, e.g. "The role asks for Go; five years of production Python backend covers the same ground and the ramp is weeks."
3. What is missing: plain statements, never questions. Distinguish "not shown on the profile" (unconfirmed) from "contradicted" (verified years under the bar, a different discipline, seniority far off).
4. The call, in a few words.

LABEL (anchor to these):
- contact: you would put this person in front of the hiring manager today. Seniority fits, nothing is contradicted, and the core requirements are shown or near-certain, or the alignment is overwhelming (doing essentially this job now at a company the employer targeted or an obvious peer).
- message: real fit signals, but one or two meaningful requirements are unconfirmed or met through an equivalent; or calibre and trajectory justify a short message even though the fit is partial.
- pass: a core requirement is contradicted, or a different discipline or seniority.
Unconfirmed is not disqualifying; only contradictions push to pass. When torn between two labels, choose the higher.

RULES: Use ONLY the FACTS block for years and tenure; never compute your own. Company signals are evidence: employment at a company the employer targeted, in the right kind of role, is strong fit evidence; sustained tenure at companies with high hiring bars is evidence of calibre. An alternate the employer declared fully satisfies that skill. No hedging boilerplate, no "the candidate": use the first name once, then "they". No bullet points, no headings, no quotation marks.

ALSO RETURN: missing (0 to 4 short plain statements, the same points as in the paragraph), ask (0 to 3 short questions for a first call), better_suited (for pass or message when honest: one sentence naming where they would fit; otherwise an empty string).`;

export async function judgeVerdict(input: VerdictInput): Promise<Verdict | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const started = Date.now();
  const skillsBlock = input.skills.length
    ? input.skills
        .map(
          (s) =>
            `- ${s.skill}${s.mustHave ? " (must-have)" : " (nice-to-have)"}` +
            (s.alternates.length ? ` — employer also accepts: ${s.alternates.join(", ")}` : "")
        )
        .join("\n")
    : "(no explicit skill list; judge from the job description)";
  const user =
    `ROLE: ${input.roleTitle}${input.minYears ? ` (${input.minYears}+ years)` : ""}\n\n` +
    `JOB DESCRIPTION:\n${input.jdText.slice(0, 5000)}\n\n` +
    `REQUIRED SKILLS:\n${skillsBlock}\n\n` +
    (input.targetedCompanies.length
      ? `SEARCH CONTEXT: the employer explicitly targeted candidates at these companies: ${input.targetedCompanies.join(", ")}\n\n`
      : "") +
    (input.employerContext ? `CANDIDATE'S CURRENT EMPLOYER: ${input.employerContext}\n\n` : "") +
    `CANDIDATE: ${input.candidateName}\nLINKEDIN PROFILE:\n${input.profileText.slice(0, 5000)}\n\n` +
    (input.resumeText ? `RESUME EXCERPT:\n${input.resumeText.slice(0, 3000)}\n\n` : "") +
    `FACTS (computed from dated position history; use these numbers verbatim):\n${input.factsBlock}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(input.timeoutMs ?? 30_000),
    body: JSON.stringify({
      model: input.model,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "verdict",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: { type: "string", enum: ["contact", "message", "pass"] },
              paragraph: { type: "string" },
              missing: { type: "array", items: { type: "string" } },
              ask: { type: "array", items: { type: "string" } },
              better_suited: { type: "string" },
            },
            required: ["label", "paragraph", "missing", "ask", "better_suited"],
          },
        },
      },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
    }),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  try {
    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const out = JSON.parse(data.choices[0].message.content) as {
      label: VerdictLabel;
      paragraph: string;
      missing: string[];
      ask: string[];
      better_suited: string;
    };
    if (!out.label || !out.paragraph) return null;
    let label = out.label;
    let missing = (out.missing || []).slice(0, 4).map((m) => m.slice(0, 160));
    // Rail: a verified years shortfall of more than a year blocks "contact"
    // however persuasive the narrative; the number is not negotiable.
    if (label === "contact" && input.minYears != null && input.careerYears != null && input.careerYears < input.minYears - 1) {
      label = "message";
      missing = [`Dated history shows ${input.careerYears} years against ${input.minYears}+ required.`, ...missing].slice(0, 4);
    }
    return {
      label,
      paragraph: out.paragraph.trim().slice(0, 700),
      missing,
      ask: (out.ask || []).slice(0, 3).map((q) => q.slice(0, 200)),
      betterSuited: (out.better_suited || "").slice(0, 250),
      model: input.model,
      promptVersion: VERDICT_PROMPT_VERSION,
      usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 },
      ms: Date.now() - started,
    };
  } catch {
    return null;
  }
}
