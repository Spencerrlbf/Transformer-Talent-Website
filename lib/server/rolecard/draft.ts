// Drafts a role's scorecard from its job description: three tiers, short
// testable rows. One call per role; the hiring manager or recruiter can then
// reword, move, delete or add rows. Nothing here writes to the database.

import { sanitizeScorecard, type Scorecard } from "@/lib/rolecard";

export interface DraftInput {
  title: string;
  yoe?: string | null;
  jd?: { about?: string; doing?: string[]; needs?: string[]; bonus?: string[] } | null;
  description?: string | null;
  skills?: { skill: string; must_have?: boolean; alternates?: string[] }[] | null;
  /** The role's free-text tech stack. Synced roles have no structured skills
   *  list, and without this the drafter never learns which other languages
   *  the employer's own stack would accept. */
  techStack?: string | null;
  minYears?: number | null;
}

export const DRAFT_MODEL = "gpt-4o";

// One array per tier, so a tier cannot be skipped the way a single list let it be.
const ROWS = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: { label: { type: "string" }, good: { type: "string" } },
    required: ["label", "good"],
  },
} as const;

// The examples below are deliberately from OTHER kinds of role (payments,
// data platform). The first version used an agent-platform role as its
// example; the first role it was tried on was an agent-platform role, and it
// copied three rows from the prompt, including a "2+ years" bar no job
// description had asked for.
const SYSTEM = `You are a senior technical recruiter turning a job description into the scorecard every candidate for this role is checked against. Most candidates are judged from a LinkedIn profile alone, so each row must be something a profile, a resume or a ten-minute call can answer.

THREE TIERS
- required: the hiring manager would reject without it. 3 to 5 rows. Include the minimum years when the role states one, as its own row, in exactly one of these two forms: for a software or engineering role, "5+ years as a software engineer"; for any other role (data science, research, product, design), "5+ years of professional experience". Include the core skill and the core kind of work.
- exceptional: what the ideal hire has beyond the bar: the rare thing that makes the hiring manager say yes on sight. 1 to 3 rows, drawn from the role's hardest responsibilities. Never generic praise.
- bonus: nice to have. 1 to 4 rows.

EVERY ROW IS CHECKABLE FROM WHAT PEOPLE ACTUALLY WRITE
- label: at most 10 words, no question mark. Never a sentence copied from the description. Never an adjective as the test: no deep, strong, solid, expert, proven, extensive, comfortable, familiar. Say the thing done: "Production-grade infrastructure experience" becomes "Has built and run backend services in production".
- good: one plain sentence, at most 28 words, naming what a PROFILE shows when this is true: titles, team names, skill tags, the words people use in a job description. Never duties nobody writes on a profile (on-call, code review, stakeholder management). Never "in any capacity", "exposure to", "familiarity with": they make everything count.
- One row, one question. If a single line on a profile would tick two rows, they are one row: merge them. When the description pairs two names for one capability, keep both joined by "or" ("evaluation or observability tooling"), because people describe their work with either word.
- A technology row says what else would do the job, in brackets, taken from the role's own tech stack: "Backend in Java or Kotlin (Go, Scala or C# accepted)". With no stated alternatives, name none. Put a years bar on a skill row ONLY when the description states one for that skill; how deep someone is, is a question for the call.
- A category row keeps technologies out of its label and lists them in good: label "Stream processing or message queues"; good "Kafka, Kinesis, Pub/Sub, RabbitMQ or SQS named on a job; Flink or Spark Streaming also count".

EXAMPLES OF THE FORM (from other roles; do not reuse their content)
- required: "Has built payment or ledger systems in production" :: good: "Payments, billing, ledger, reconciliation or card-processing work named in a title, a team or a job description."
- exceptional: "Has led a zero-to-one product as the first engineers" :: good: "Founding engineer, first engineer, early engineer or technical co-founder at a company that shipped."
- bonus: "Data warehouse modelling" :: good: "dbt, Snowflake, BigQuery or Redshift named on a job; dimensional modelling or analytics engineering in a description."

Never invent requirements the description does not support. No rows about soft skills, culture, location, visa or salary. Order each tier by importance. 7 to 11 rows in total.`;

/** Enough written about the role to draft from. A bare title would make the
 *  model invent requirements, and invented Required rows would pass people. */
export const canDraft = (input: DraftInput): boolean => {
  const jd = input.jd || {};
  const text = [jd.about, input.description, ...(jd.needs || []), ...(jd.doing || [])].filter(Boolean).join(" ");
  // (the tech stack alone is not enough to draft from: it says what, never why)
  return text.trim().length >= 80 || (input.skills || []).length >= 2;
};

export async function draftScorecard(input: DraftInput, timeoutMs = 40_000): Promise<Scorecard | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !canDraft(input)) return null;
  const jd = input.jd || {};
  const skills = (input.skills || [])
    .map((s) => `- ${s.skill}${s.must_have ? " (must-have)" : " (nice-to-have)"}${s.alternates?.length ? `; also accepts: ${s.alternates.join(", ")}` : ""}`)
    .join("\n");
  const user =
    `ROLE: ${input.title}${input.yoe ? ` (${input.yoe})` : input.minYears ? ` (${input.minYears}+ years)` : ""}\n\n` +
    (jd.about ? `ABOUT:\n${jd.about}\n\n` : input.description ? `DESCRIPTION:\n${input.description.slice(0, 4000)}\n\n` : "") +
    (jd.doing?.length ? `RESPONSIBILITIES:\n- ${jd.doing.join("\n- ")}\n\n` : "") +
    (jd.needs?.length ? `REQUIREMENTS:\n- ${jd.needs.join("\n- ")}\n\n` : "") +
    (jd.bonus?.length ? `NICE TO HAVE:\n- ${jd.bonus.join("\n- ")}\n\n` : "") +
    (skills ? `SKILLS THE EMPLOYER LISTED:\n${skills}\n\n` : "") +
    (input.techStack ? `TECH STACK THE ROLE LISTS (not all must-haves; use it to name the alternatives a technology row accepts): ${input.techStack}\n` : "");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: process.env.SCORECARD_DRAFT_MODEL || DRAFT_MODEL,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "scorecard",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { required: ROWS, exceptional: ROWS, bonus: ROWS },
            required: ["required", "exceptional", "bonus"],
          },
        },
      },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user.slice(0, 9000) },
      ],
    }),
  }).catch(() => null);
  if (!res || !res.ok) {
    if (res) console.error("scorecard draft: openai", res.status, (await res.text().catch(() => "")).slice(0, 300));
    return null;
  }
  try {
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    const out = JSON.parse(data.choices[0].message.content) as Record<"required" | "exceptional" | "bonus", { label: string; good: string }[]>;
    const criteria = (["exceptional", "required", "bonus"] as const).flatMap((tier) =>
      (Array.isArray(out[tier]) ? out[tier] : []).map((r) => ({ ...r, tier }))
    );
    return sanitizeScorecard({ criteria }, "ai");
  } catch {
    return null;
  }
}
