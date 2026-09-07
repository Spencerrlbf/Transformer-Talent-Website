// The verdict: one recruiter-facing paragraph per candidate per role, with an
// action label. Written to be read in ten seconds before deciding whether to
// contact someone. One judge for every way a person enters the system; the
// FACTS block supplies every number, the model supplies the reading.
//
// Discipline: anchored label definitions, temperature 0, strict schema, code
// rails after the call (a verified years shortfall caps the label).

import type { CandidateFacts } from "./facts";
import { VERDICT_LABEL, type ChipStatus, type RequirementRead, type TechChip, type VerdictLabel, type VerdictView } from "@/lib/verdict-view";

export { VERDICT_LABEL };
export type { VerdictLabel };

export const VERDICT_PROMPT_VERSION = "v2";

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
  /** Failure visibility for callers that pace retries (rate limit vs dead key). */
  onError?: (info: { status: number; code?: string; retryAfter?: string }) => void;
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
  /** One read per role requirement: met, met through an equivalent, or missing. */
  requirements: RequirementRead[];
  /** Technologies evidenced in the current position, and in earlier ones. */
  technologiesNow: string[];
  technologiesBefore: string[];
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

CATEGORIES: a requirement stated as a category is met by any concrete instance of it: "vector database" by pgvector, Pinecone, Weaviate, Qdrant, Milvus, Chroma or FAISS; "cloud" by AWS, GCP or Azure; "message queue" by Kafka, SQS or RabbitMQ; "orchestration" by Temporal, Airflow or Prefect; and so on. Adjacent evidence without a named instance (embeddings or retrieval work with no vector store named) counts as an equivalent, and the paragraph says so.

RULES: Use ONLY the FACTS block for years and tenure; never compute your own. Company signals are evidence: employment at a company the employer targeted, in the right kind of role, is strong fit evidence; sustained tenure at companies with high hiring bars is evidence of calibre. An alternate the employer declared fully satisfies that skill. No hedging boilerplate, no "the candidate": use the first name once, then "they". No bullet points, no headings, no quotation marks.

ALSO RETURN: missing (0 to 4 short plain statements, the same points as in the paragraph), ask (0 to 3 short questions for a first call), better_suited (for pass or message when honest: one sentence naming where they would fit; otherwise an empty string), requirements (one entry per REQUIRED SKILL line and per hard requirement in the job description: requirement as written, status met / equivalent / missing, evidence = the technology or fact that decides it, at most 12 words), technologies_now (technologies evidenced in the CURRENT position: languages, frameworks, databases, cloud, infrastructure, tools; from that position's skills or description, or the resume's most recent role; at most 8; technology names only, never soft skills), technologies_before (technologies from earlier positions, or listed on the profile with no date; most recent first; at most 8; none that are already in technologies_now).`;

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
              requirements: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    requirement: { type: "string" },
                    status: { type: "string", enum: ["met", "equivalent", "missing"] },
                    evidence: { type: "string" },
                  },
                  required: ["requirement", "status", "evidence"],
                },
              },
              technologies_now: { type: "array", items: { type: "string" } },
              technologies_before: { type: "array", items: { type: "string" } },
            },
            required: ["label", "paragraph", "missing", "ask", "better_suited", "requirements", "technologies_now", "technologies_before"],
          },
        },
      },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
    }),
  }).catch(() => null);
  if (!res || !res.ok) {
    if (res && input.onError) {
      let code: string | undefined;
      try {
        code = ((await res.json()) as { error?: { code?: string } })?.error?.code;
      } catch {
        /* body unreadable */
      }
      input.onError({ status: res.status, code, retryAfter: res.headers.get("retry-after") ?? undefined });
    }
    return null;
  }
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
      requirements: RequirementRead[];
      technologies_now: string[];
      technologies_before: string[];
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
      requirements: (out.requirements || [])
        .filter((r) => r && typeof r.requirement === "string" && ["met", "equivalent", "missing"].includes(r.status))
        .slice(0, 16)
        .map((r) => ({ requirement: r.requirement.slice(0, 120), status: r.status, evidence: (r.evidence || "").slice(0, 120) })),
      technologiesNow: cleanTech(out.technologies_now),
      technologiesBefore: cleanTech(out.technologies_before),
      model: input.model,
      promptVersion: VERDICT_PROMPT_VERSION,
      usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 },
      ms: Date.now() - started,
    };
  } catch {
    return null;
  }
}

const cleanTech = (list: unknown): string[] => {
  const seen = new Set<string>();
  return (Array.isArray(list) ? list : [])
    .map((t) => String(t || "").trim().replace(/\s+/g, " "))
    .filter((t) => t.length >= 2 && t.length <= 40)
    .filter((t) => {
      const k = t.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 8);
};

const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9+#. ]/g, " ").replace(/\s+/g, " ").trim();
const mentions = (hay: string, needle: string) => {
  const h = norm(hay);
  const n = norm(needle);
  return n.length >= 2 && (h === n || h.includes(n) || (n.length >= 4 && n.includes(h) && h.length >= 3));
};

/** The verdict as the product stores and shows it. `factsFor` recomputes the
 *  facts over the technologies the judge named, so each chip can carry its
 *  dated years; requirement reads decide each chip's status. */
export function buildVerdictView(v: Verdict, factsFor: (terms: string[]) => CandidateFacts | null): VerdictView {
  const terms = [...new Set([...v.technologiesNow, ...v.technologiesBefore])];
  const facts = terms.length ? factsFor(terms) : null;
  const yearsOf = (name: string): number | null => {
    const f = (facts?.skills || []).find((s) => !s.listedOnly && mentions(s.skill, name));
    return f ? f.years : null;
  };
  const statusOf = (name: string): { status: ChipStatus; evidence?: string } => {
    const met = v.requirements.find((r) => r.status === "met" && (mentions(r.evidence, name) || mentions(r.requirement, name)));
    if (met) return { status: "met", evidence: met.requirement };
    const eq = v.requirements.find((r) => r.status === "equivalent" && (mentions(r.evidence, name) || mentions(r.requirement, name)));
    if (eq) return { status: "equivalent", evidence: `stands in for ${eq.requirement}` };
    return { status: "plain" };
  };
  const chip = (name: string): TechChip => ({ name, years: yearsOf(name), ...statusOf(name) });
  const now = v.technologiesNow.map(chip);
  const nowSet = new Set(now.map((c) => c.name.toLowerCase()));
  const before = v.technologiesBefore.filter((t) => !nowSet.has(t.toLowerCase())).map(chip);
  const gaps = v.requirements.filter((r) => r.status === "missing").map((r) => r.requirement).slice(0, 6);
  return {
    v: 2,
    label: v.label,
    paragraph: v.paragraph,
    missing: v.missing,
    ask: v.ask,
    betterSuited: v.betterSuited,
    requirements: v.requirements,
    tech: { now, before, gaps, nowPosition: facts?.currentTitle ? [facts.currentTitle, facts.currentCompany].filter(Boolean).join(" at ") : null },
    model: v.model,
    at: new Date().toISOString(),
  };
}
