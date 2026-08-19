// Dimension scorecard: the hiring-guidance layer. Division of labor is
// strict — the LLM answers pointed evidence questions (seniority/scope,
// non-numeric must-haves); CODE computes stack match, years match, gap list,
// and the final STRONG/POSSIBLE/WEAK tier from fixed rules. No holistic
// LLM scores anywhere: same inputs, same tier, every line checkable.
// Thresholds live here so they become per-tenant dials in the SaaS phase.

import type { CandidateFacts } from "./facts";

export interface StackItem {
  term: string;
  evidenced: boolean;
  years?: number; // dated career years when we have them
  source?: "dated" | "listed" | "resume";
}

export interface ScopeSignal {
  question: string;
  answer: "yes" | "no" | "unclear";
  evidence: string;
}

export interface Scorecard {
  tier: "STRONG" | "POSSIBLE" | "WEAK";
  reason: string;
  stack: { items: StackItem[]; matched: number; total: number };
  years: { required: number | null; actual: number | null; met: boolean | null };
  seniority: { level: "staff+" | "senior" | "mid" | "junior" | "unknown"; signals: ScopeSignal[] };
  gaps: string[];
}

export const SCOPE_QUESTIONS = [
  "Does the resume/profile show architecture ownership (designing systems, not just building assigned pieces)?",
  "Is there evidence of leading people or projects (mentoring, tech lead, owning delivery)?",
  "Is there evidence of cross-team or org-level scope (work spanning multiple teams/stakeholders)?",
  "Is there evidence of production scale (traffic, data volume, uptime responsibilities)?",
] as const;

const norm = (s: string) =>
  s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9+#. ]/g, " ").replace(/\s+/g, " ").trim();

export function splitStack(techStack: string | null | undefined): string[] {
  return [...new Set(
    (techStack || "")
      .split(/[,/•;]|\band\b/i)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2 && t.length <= 40)
  )].slice(0, 12);
}

// Stack match — pure code. Evidenced = dated position skill, profile-listed
// skill, or a resume-text mention (word boundary).
export function checkStack(
  techStack: string | null | undefined,
  facts: CandidateFacts | null | undefined,
  resumeText?: string | null,
  profileSkills: string[] = []
): Scorecard["stack"] {
  const terms = splitStack(techStack);
  const resume = (resumeText || "").toLowerCase();
  const items: StackItem[] = terms.map((term) => {
    const t = norm(term);
    const dated = (facts?.skills || []).find(
      (s) => !s.listedOnly && (norm(s.skill) === t || (t.length >= 3 && norm(s.skill).includes(t)) || (norm(s.skill).length >= 3 && t.includes(norm(s.skill))))
    );
    if (dated) return { term, evidenced: true, years: dated.years, source: "dated" };
    const listed = profileSkills.some((s) => norm(s) === t || (t.length >= 3 && norm(s).includes(t)));
    if (listed) return { term, evidenced: true, source: "listed" };
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (t.length >= 2 && new RegExp(`\\b${escaped}\\b`, "i").test(resume)) {
      return { term, evidenced: true, source: "resume" };
    }
    return { term, evidenced: false };
  });
  return { items, matched: items.filter((i) => i.evidenced).length, total: items.length };
}

// Seniority classification — code over cited scope answers + title keywords.
export function classifySeniority(
  signals: ScopeSignal[],
  currentTitle: string | null | undefined
): Scorecard["seniority"]["level"] {
  const yes = signals.filter((s) => s.answer === "yes").length;
  const title = (currentTitle || "").toLowerCase();
  const titleStaff = /staff|principal|architect|head of|director|vp\b/.test(title);
  const titleSenior = /senior|lead|sr\.?\b/.test(title);
  if ((yes >= 3 && signals.some((s) => s.answer === "yes" && /architecture/i.test(s.question))) || (titleStaff && yes >= 2)) return "staff+";
  if (yes >= 2 || (titleSenior && yes >= 1)) return "senior";
  if (yes === 1 || titleSenior || signals.length === 0) return signals.length === 0 ? "unknown" : "mid";
  return "junior";
}

// The tier: fixed rules, no model. Thresholds are the future tenant dials.
export function computeTier(args: {
  stack: Scorecard["stack"];
  years: Scorecard["years"];
  mustHaveNoCount: number;
}): { tier: Scorecard["tier"]; reason: string } {
  const { stack, years, mustHaveNoCount } = args;
  const ratio = stack.total ? stack.matched / stack.total : 1;
  const yearsFailed = years.met === false;
  const yearsLabel =
    years.required !== null && years.actual !== null
      ? `years ${years.actual} vs ${years.required}+ ${years.met ? "✓" : "✗"}`
      : "years n/a";
  const stackLabel = stack.total ? `stack ${stack.matched}/${stack.total}` : "stack n/a";

  let tier: Scorecard["tier"];
  if (!yearsFailed && ratio >= 0.6 && mustHaveNoCount === 0) tier = "STRONG";
  else if (yearsFailed || ratio < 0.3 || mustHaveNoCount >= 2) tier = "WEAK";
  else tier = "POSSIBLE";

  return {
    tier,
    reason: `${yearsLabel} · ${stackLabel} · ${mustHaveNoCount} must-have miss${mustHaveNoCount === 1 ? "" : "es"}`,
  };
}

export function buildScorecard(args: {
  techStack: string | null | undefined;
  minYears: number | null;
  facts: CandidateFacts | null | undefined;
  resumeText?: string | null;
  profileSkills?: string[];
  scopeSignals: ScopeSignal[];
  answers: { question: string; answer: string }[];
}): Scorecard {
  const stack = checkStack(args.techStack, args.facts, args.resumeText, args.profileSkills || []);
  const actual = args.facts?.careerYears ?? null;
  const years: Scorecard["years"] = {
    required: args.minYears,
    actual,
    met: args.minYears !== null && actual !== null ? actual >= args.minYears : null,
  };
  const level = classifySeniority(args.scopeSignals, args.facts?.currentTitle);
  const mustHaveNoCount = args.answers.filter((a) => a.answer === "no").length;
  const { tier, reason } = computeTier({ stack, years, mustHaveNoCount });
  const gaps = [
    ...stack.items.filter((i) => !i.evidenced).map((i) => `${i.term} not evidenced`),
    ...args.answers.filter((a) => a.answer === "no").map((a) => a.question.replace(/\?$/, "")),
  ].slice(0, 8);
  return { tier, reason, stack, years, seniority: { level, signals: args.scopeSignals }, gaps };
}

// Compact rendering for Airtable / recruiter cards.
export function renderScorecard(jobId: string, sc: Scorecard): string {
  const stackLine = sc.stack.total
    ? `stack ${sc.stack.matched}/${sc.stack.total} (✗ ${sc.stack.items.filter((i) => !i.evidenced).map((i) => i.term).join(", ") || "none"})`
    : "stack n/a";
  return [
    `#${jobId} ${sc.tier} — ${sc.reason}`,
    `  ${stackLine}`,
    `  seniority: ${sc.seniority.level}`,
    sc.gaps.length ? `  gaps: ${sc.gaps.slice(0, 4).join("; ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// The one LLM task in this module: pointed evidence questions, cited answers.
export async function assessScope(
  evidence: string,
  opts?: { timeoutMs?: number; onError?: (info: { status: number; code?: string; retryAfter?: string }) => void }
): Promise<ScopeSignal[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !evidence) return [];
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      // Same hang-protection as interrogate: never wait forever on the LLM.
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 90_000),
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "scope",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["signals"],
              properties: {
                signals: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["question", "answer", "evidence"],
                    properties: {
                      question: { type: "string" },
                      answer: { type: "string", enum: ["yes", "no", "unclear"] },
                      evidence: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        messages: [
          {
            role: "system",
            content:
              "Answer each question about this candidate with yes/no/unclear plus a short citation " +
              "from the material (max 15 words). No evidence = 'unclear', never a guess. " +
              "Answer ALL questions, in order.",
          },
          { role: "user", content: `CANDIDATE MATERIAL:\n${evidence.slice(0, 7000)}\n\nQUESTIONS:\n${SCOPE_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join("\n")}` },
        ],
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (JSON.parse(data.choices[0].message.content).signals as ScopeSignal[]).slice(0, SCOPE_QUESTIONS.length);
  } catch {
    return [];
  }
}
