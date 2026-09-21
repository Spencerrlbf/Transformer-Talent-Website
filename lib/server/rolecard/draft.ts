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

const SYSTEM = `You are a senior technical recruiter turning a job description into the scorecard every candidate for this role is checked against. Each row is one thing a recruiter can verify from a LinkedIn profile, a resume, or a short call.

THREE TIERS:
- required: the hiring manager would reject without it. 3 to 6 rows. Include the minimum years when the role states one, and each must-have skill (fold accepted alternates into the row: "TypeScript backend (or Go, Java)").
- exceptional: what the ideal hire has beyond the bar: the rare thing that makes the hiring manager say yes on sight. 1 to 3 rows. Drawn from the role's core problem, not from generic praise.
- bonus: nice to have. 0 to 4 rows.

EACH ROW: label = a short capability, at most 9 words, no question mark, no "experience with" padding, one fact per row (never join two distinct skills with "and"; "or" alternatives may share a row). good = one plain sentence, at most 22 words, saying what counts as evidence, including equivalents that should pass (a category is met by any instance: "vector database" by pgvector, Pinecone, FAISS).

Never invent requirements the description does not support. Never write rows about soft skills, culture, location, visa or salary. Order each tier by importance. 6 to 11 rows in total.`;

export async function draftScorecard(input: DraftInput): Promise<Scorecard | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
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
    signal: AbortSignal.timeout(40_000),
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
            properties: {
              criteria: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    label: { type: "string" },
                    tier: { type: "string", enum: ["exceptional", "required", "bonus"] },
                    good: { type: "string" },
                  },
                  required: ["label", "tier", "good"],
                },
              },
            },
            required: ["criteria"],
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
    return sanitizeScorecard(JSON.parse(data.choices[0].message.content), "ai");
  } catch {
    return null;
  }
}
