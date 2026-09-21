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

const SYSTEM = `You are a senior technical recruiter turning a job description into the scorecard every candidate for this role is checked against. Each row is one thing a recruiter can verify from a LinkedIn profile, a resume, or a ten-minute call.

THREE TIERS, all three filled:
- required: the hiring manager would reject without it. 3 to 5 rows. Include the minimum years when the role states one, as its own row in exactly this form: "4+ years software engineering". Include each must-have skill.
- exceptional: what the ideal hire has beyond the bar, the rare thing that makes the hiring manager say yes on sight. 2 to 3 rows, always. Draw them from the role's core problem and the hardest responsibility in the description (for an agent-platform role: "Has built agent or browser-automation infrastructure in production"), never from generic praise.
- bonus: nice to have. 1 to 4 rows.

EVERY ROW MUST BE CHECKABLE. A recruiter must be able to answer yes or no to it from evidence.
- Never copy a sentence from the description. Never use an adjective as the test: no deep, strong, solid, expert, proven, extensive, significant, comfortable, familiar. Replace the adjective with what it means: "Deep TypeScript backend expertise" becomes "TypeScript backend in production, 2+ years".
- Replace abstractions with the thing done: "Production-grade infrastructure experience" becomes "Has run backend services in production (on-call, deploys, reliability)". "Comfort at the intersection of AI agents and systems engineering" becomes "Has built systems that run LLM agents or tool use".
- When another technology would do the job, fold it into the row: "TypeScript backend in production, 2+ years (or Node.js; Go or Java with some TypeScript)". Only fold in what a hiring manager for THIS role would accept.
- One fact per row. Never join two distinct skills with "and". "Or" alternatives may share a row.

label = at most 10 words, no question mark. good = one plain sentence, at most 24 words, saying what counts as evidence and which equivalents pass (a category is met by any instance: "vector database" by pgvector, Pinecone, FAISS).

Never invent requirements the description does not support. No rows about soft skills, culture, location, visa or salary. Order each tier by importance. 7 to 11 rows in total.`;

/** Enough written about the role to draft from. A bare title would make the
 *  model invent requirements, and invented Required rows would pass people. */
export const canDraft = (input: DraftInput): boolean => {
  const jd = input.jd || {};
  const text = [jd.about, input.description, ...(jd.needs || []), ...(jd.doing || [])].filter(Boolean).join(" ");
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
    (skills ? `SKILLS THE EMPLOYER LISTED:\n${skills}\n` : "");

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
