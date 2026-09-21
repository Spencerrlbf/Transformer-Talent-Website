// A second opinion on scorecard rows, from TypeSafe's Jev (a "System One"
// model: typed questions in, answers with probabilities out; it writes no
// text). Used ONLY by the owner's comparison page: nothing in the product
// reads it. Each row that needs reading becomes one Score question on four
// levels; every row of a person goes in one request and is answered on its
// own. Career-years rows are decided by rule, for both judges alike.
//
// Docs: https://docs.typesafe.ai (POST /v1/systemone). The model is weak at
// arithmetic and dates by its makers' own account, which is why years stay
// in code and the FACTS block is handed over already computed.

import { isCareerYearsRow, type Criterion, type RowStatus } from "@/lib/rolecard";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
/** Published price, input tokens only; output is free. */
export const JEV_USD_PER_M_INPUT = 0.042;

/** Ordered by strength of evidence for the requirement. */
const LEVELS: { status: RowStatus; text: string }[] = [
  { status: "no", text: "Contradicted: the candidate's whole history plainly points to a different stack, discipline or level, so they do not meet this." },
  { status: "unknown", text: "Not shown: the candidate's profile says nothing either way about this." },
  { status: "equivalent", text: "Equivalent: not shown directly, but closely related or transferable experience is: an accepted alternative, a concrete instance of the category, or the same work in another technology." },
  { status: "yes", text: "Clearly shown: the candidate's profile or facts directly show this, named in a role, a project or the dated history." },
];

export interface JevRow {
  id: string;
  status: RowStatus;
  confidence: number;
  /** Probability per status. */
  probabilities: Record<RowStatus, number>;
}

export interface JevResult {
  rows: JevRow[];
  ms: number;
  inputTokens: number;
  model: string;
}

export type JevError = "no_key" | "key_rejected" | "rate_limited" | "failed";

export const jevConfigured = () => !!process.env.TYPESAFE_API_KEY;

export async function jevJudgeRows(input: {
  roleTitle: string;
  jd: { about?: string; doing?: string[]; needs?: string[] } | null;
  criteria: Criterion[];
  candidateName: string;
  profileText: string;
  factsBlock: string;
  timeoutMs?: number;
}): Promise<JevResult | { error: JevError; detail?: string }> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return { error: "no_key" };
  const asked = input.criteria.filter((c) => !isCareerYearsRow(c.label));
  if (!asked.length) return { rows: [], ms: 0, inputTokens: 0, model: JEV_MODEL };

  // Question keys are q0..qn: a scorecard id is free text, a JSON key here
  // should not be.
  const questions: Record<string, unknown> = {};
  asked.forEach((c, i) => {
    questions[`q${i}`] = {
      type: "score",
      instructions:
        `Judging only from \`candidate\`: how well does this person meet this requirement of the role? Requirement: "${c.label}".` +
        (c.good ? ` What counts as evidence: ${c.good}` : "") +
        " Per-skill years in `candidate.facts` count only the positions where the skill is tagged, so they are a minimum; people under-list skills.",
      criteria: LEVELS.map((l) => l.text),
    };
  });

  const started = Date.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(input.timeoutMs ?? 20_000),
    body: JSON.stringify({
      model: JEV_MODEL,
      state: {
        role: {
          title: input.roleTitle,
          about: input.jd?.about || "",
          responsibilities: input.jd?.doing || [],
          requirements: input.jd?.needs || [],
        },
        candidate: { name: input.candidateName, profile: input.profileText.slice(0, 6000), facts: input.factsBlock },
      },
      questions,
    }),
  }).catch(() => null);
  if (!res) return { error: "failed", detail: "no response" };
  if (res.status === 401 || res.status === 403) return { error: "key_rejected" };
  if (res.status === 429 || res.status === 529) return { error: "rate_limited" };
  if (!res.ok) return { error: "failed", detail: `${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}` };

  try {
    const data = (await res.json()) as {
      model?: string;
      answers: Record<string, { probabilities?: Record<string, number>; confidence?: number }>;
      usage?: { input_tokens?: number };
    };
    const rows: JevRow[] = asked.map((c, i) => {
      const a = data.answers?.[`q${i}`];
      const p = LEVELS.map((_, k) => Number(a?.probabilities?.[String(k)] ?? 0));
      const top = p.indexOf(Math.max(...p));
      return {
        id: c.id,
        status: LEVELS[Math.max(0, top)].status,
        confidence: Math.round(Number(a?.confidence ?? 0) * 100) / 100,
        probabilities: Object.fromEntries(LEVELS.map((l, k) => [l.status, Math.round(p[k] * 100) / 100])) as Record<RowStatus, number>,
      };
    });
    return { rows, ms: Date.now() - started, inputTokens: data.usage?.input_tokens ?? 0, model: data.model || JEV_MODEL };
  } catch {
    return { error: "failed", detail: "unreadable response" };
  }
}
