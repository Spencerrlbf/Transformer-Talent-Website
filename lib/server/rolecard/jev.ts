// The judge of judgment rows: TypeSafe's Jev, a "System One" model that
// takes typed questions and answers with probabilities; it writes no text.
// Each judgment row of a person becomes one Score question over the row's
// own ladder (lib/rolecard.ts ladderOf), rung 1 first; every unremembered
// row of a person goes in ONE request and is answered on its own.
//
// What Jev sees is the person and nothing else: the whole profile, the whole
// resume, one code-written line of years, and what a recruiter confirmed as
// true. No role title, no job description, no tier and no per-skill facts:
// measured, the model reads a company's product or reputation as evidence
// about the person when it is given the chance, and it says "no" from
// silence when a rung lets it. Years stay in code because the model is weak
// at arithmetic and dates by its makers' own account.
//
// Docs: https://docs.typesafe.ai (POST /v1/systemone).

import { ladderOf, metAtOf, workNotTitlesRule, type Criterion } from "@/lib/rolecard";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** Pinned: a remembered row is keyed on the model that read it. */
export const JEV_MODEL = "jev-1.13.0";
/** Published price, input tokens only; output is free. */
export const JEV_USD_PER_M_INPUT = 0.042;

export const jevConfigured = () => !!process.env.TYPESAFE_API_KEY;

/** The person, as the only thing in the request's state. */
export interface JevCandidate {
  name: string;
  profile: string;
  /** Omitted when there is none. */
  resume?: string;
  /** One line written by code, in whole years. */
  years: string;
  /** What a recruiter checked off as true, on any role. Never a confirmed "no". */
  confirmed?: string[];
}

/** One row's answer: p[k] is the probability of rung k+1 (2 dp), with the
 *  model's confidence in the answer (2 dp). */
export interface JevAnswer {
  p: number[];
  confidence: number;
}

export interface JevResult {
  /** In the order the criteria were given; null where the model returned nothing for a row. */
  answers: (JevAnswer | null)[];
  ms: number;
  inputTokens: number;
  model: string;
}

export interface JevError {
  error: "no_key" | "key_rejected" | "rate_limited" | "failed";
  /** As a caller paces retries on it: 401 for a key problem, 429 for a rate
   *  limit, 0 for anything transient (network, timeout, an upstream error). */
  status: 401 | 429 | 0;
  code?: string;
  retryAfter?: string;
  detail?: string;
}

export const isJevError = (r: JevResult | JevError): r is JevError => "error" in r;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The question one judgment row becomes. Exported so a test or the
 *  measurement harness can see exactly what is asked. */
export function jevQuestion(c: Criterion): { type: "score"; instructions: string; criteria: string[] } {
  return {
    type: "score",
    instructions:
      `The row on the role's scorecard: "${c.label}". Judging only from candidate (their profile, resume, the years line and any confirmed statements), which one of these situations best describes this person? They are ordered from weakest to strongest and numbered from 1, the first. Choose the first whenever the material is silent or too thin to tell, however likely the rest may seem. Judge the person, not their employer: a company's product, technology stack or reputation is not evidence about them. Statements under confirmed were checked by a recruiter and are true. ${workNotTitlesRule(metAtOf(c))}`,
    criteria: ladderOf(c),
  };
}

export async function jevJudgeLadders(input: { candidate: JevCandidate; criteria: Criterion[]; timeoutMs?: number }): Promise<JevResult | JevError> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return { error: "no_key", status: 401, code: "typesafe_key" };
  if (!input.criteria.length) return { answers: [], ms: 0, inputTokens: 0, model: JEV_MODEL };

  // Question keys are q0..qn in card order: a scorecard id is free text, a
  // JSON key here should not be.
  const questions: Record<string, unknown> = {};
  input.criteria.forEach((c, i) => {
    questions[`q${i}`] = jevQuestion(c);
  });
  const { name, profile, resume, years, confirmed } = input.candidate;
  const candidate: Record<string, unknown> = { name, profile, ...(resume ? { resume } : {}), years, ...(confirmed?.length ? { confirmed } : {}) };

  const started = Date.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(input.timeoutMs ?? 20_000),
    body: JSON.stringify({ model: JEV_MODEL, state: { candidate }, questions }),
  }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  if (res instanceof Error) return { error: "failed", status: 0, code: res.name || "fetch_failed", detail: res.message.slice(0, 200) };
  if (res.status === 401 || res.status === 403) return { error: "key_rejected", status: 401, code: "typesafe_key", detail: String(res.status) };
  if (res.status === 429 || res.status === 529) return { error: "rate_limited", status: 429, code: `typesafe_${res.status}`, retryAfter: res.headers.get("retry-after") ?? undefined };
  if (!res.ok) return { error: "failed", status: 0, code: `typesafe_${res.status}`, detail: (await res.text().catch(() => "")).slice(0, 200) };

  try {
    const data = (await res.json()) as {
      model?: string;
      answers?: Record<string, { probabilities?: Record<string, number>; confidence?: number }>;
      usage?: { input_tokens?: number };
    };
    const answers = input.criteria.map((c, i) => {
      const a = data.answers?.[`q${i}`];
      if (!a || typeof a !== "object") return null;
      const rungs = ladderOf(c).length;
      const p = Array.from({ length: rungs }, (_, k) => round2(Number(a.probabilities?.[String(k)] ?? 0) || 0));
      return { p, confidence: round2(Number(a.confidence ?? 0) || 0) };
    });
    return { answers, ms: Date.now() - started, inputTokens: data.usage?.input_tokens ?? 0, model: data.model || JEV_MODEL };
  } catch {
    return { error: "failed", status: 0, code: "unreadable" };
  }
}

/** One answer to a Choice question: the probability of each option by its key. */
export interface JevChoice {
  probabilities: Record<string, number>;
  confidence: number;
}

/** Choice questions over one state, all in one request (the person's
 *  positions, read one by one: role-type.ts). Same key, errors and pacing as
 *  the scorecard rows. */
export async function jevChoose(input: {
  state: Record<string, unknown>;
  questions: Record<string, { instructions: string; criteria: Record<string, string> }>;
  timeoutMs?: number;
}): Promise<{ answers: Record<string, JevChoice | null>; ms: number; inputTokens: number; model: string } | JevError> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return { error: "no_key", status: 401, code: "typesafe_key" };
  const ids = Object.keys(input.questions);
  if (!ids.length) return { answers: {}, ms: 0, inputTokens: 0, model: JEV_MODEL };
  const questions = Object.fromEntries(ids.map((id) => [id, { type: "choice", ...input.questions[id] }]));
  const started = Date.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(input.timeoutMs ?? 20_000),
    body: JSON.stringify({ model: JEV_MODEL, state: input.state, questions }),
  }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  if (res instanceof Error) return { error: "failed", status: 0, code: res.name || "fetch_failed", detail: res.message.slice(0, 200) };
  if (res.status === 401 || res.status === 403) return { error: "key_rejected", status: 401, code: "typesafe_key", detail: String(res.status) };
  if (res.status === 429 || res.status === 529) return { error: "rate_limited", status: 429, code: `typesafe_${res.status}`, retryAfter: res.headers.get("retry-after") ?? undefined };
  if (!res.ok) return { error: "failed", status: 0, code: `typesafe_${res.status}`, detail: (await res.text().catch(() => "")).slice(0, 200) };
  try {
    const data = (await res.json()) as {
      model?: string;
      answers?: Record<string, { probabilities?: Record<string, number>; confidence?: number }>;
      usage?: { input_tokens?: number };
    };
    const answers: Record<string, JevChoice | null> = {};
    for (const id of ids) {
      const a = data.answers?.[id];
      if (!a || typeof a !== "object" || !a.probabilities) { answers[id] = null; continue; }
      const opts = Object.keys(input.questions[id].criteria);
      answers[id] = {
        probabilities: Object.fromEntries(opts.map((o) => [o, round2(Number(a.probabilities?.[o] ?? 0) || 0)])),
        confidence: round2(Number(a.confidence ?? 0) || 0),
      };
    }
    return { answers, ms: Date.now() - started, inputTokens: data.usage?.input_tokens ?? 0, model: data.model || JEV_MODEL };
  } catch {
    return { error: "failed", status: 0, code: "unreadable" };
  }
}
