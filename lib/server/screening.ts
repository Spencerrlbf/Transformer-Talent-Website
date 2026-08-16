import crypto from "node:crypto";
import profilesJson from "@/data/matching-profiles.json";
import { sbRest } from "./supabase";
import { getOrgId } from "./spine";
import type { CandidateFacts } from "./facts";
import { assessScope, buildScorecard, type Scorecard, type ScopeSignal } from "./scorecard";

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

// Hard gates run in code — free, and absolute. Core takes any matching
// profile (site JSON or a tenant's org_roles row); the jobId wrapper keeps
// the site's existing call sites unchanged.
export function passesProfileGates(
  p: { visa_transfer_ok?: boolean; min_years?: number | null } | null | undefined,
  applicant: { visa: string | null; years: number | null }
): boolean {
  if (!p) return true;
  const needsSponsorship =
    !!applicant.visa && !/none needed|citizen|green card/i.test(applicant.visa);
  if (needsSponsorship && !p.visa_transfer_ok) return false;
  if (p.min_years && applicant.years !== null && applicant.years < p.min_years - 1) return false;
  return true;
}

export function passesHardGates(
  jobId: string,
  applicant: { visa: string | null; years: number | null }
): boolean {
  return passesProfileGates(PROFILES[jobId], applicant);
}

// ---------- Question-sheet screening v2 (cache-aware) ----------
//
// Each shortlisted role's screening questions get answered yes/no/unclear
// with cited evidence, in ONE batched call. Verdicts are cached in
// match_verdicts keyed by content hashes of both sides — a repeat pairing
// with unchanged profile and role costs nothing and reuses the stored
// verdict (its surfaced_count is bumped for the audit trail).

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export interface VerdictAnswer {
  question: string;
  answer: "yes" | "no" | "unclear";
  evidence: string;
}

// Inference, fenced off from facts: a plausible capability suggested by
// evidence combinations. May inform probe lists and small ranking nudges —
// NEVER a yes-answer or a qualification decision.
export interface InferredSignal {
  signal: string; // "Likely ML-infrastructure deployment experience"
  basis: string; // the evidence combination that suggests it, cited
  probe: string; // what to ask on a call to confirm or kill it
}

export interface RoleVerdict {
  job_id: string;
  qualified: boolean;
  fit_score: number;
  answers: VerdictAnswer[];
  inferred_signals?: InferredSignal[]; // max 3
  scorecard?: Scorecard; // dimension scorecard + rule-derived tier
  cached: boolean;
}

// ---------- Deterministic years-question resolver ----------
// gpt-4o-mini demonstrably fumbles range arithmetic ("2.1 years" answered
// 'no' to "2-5 years?") even when instructed. Code answers what code can
// prove; the model's answer is overridden.

const YEARS_RX = /(\d+(?:\.\d+)?)\s*(?:-|–|\s*to\s*)\s*(\d+(?:\.\d+)?)\s*\+?\s*years?|at least\s+(\d+(?:\.\d+)?)\s*years?|(\d+(?:\.\d+)?)\s*\+\s*years?/i;
// Generic-experience wording the career-years number can honestly answer.
// Domain-scoped questions ("as an applied AI engineer") stay with the model.
const GENERIC_EXP_RX = /years?[^.?]*\bof\b[^.?]*\b(professional|industry|work|software|engineering|development|full[- ]?stack|hands-on)\b[^.?]*experience|years?\s+of\s+experience\s*\??$/i;

const normTerm = (s: string) =>
  s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9+#. ]/g, " ").replace(/\s+/g, " ").trim();

export function resolveYearsAnswer(
  question: string,
  facts: CandidateFacts | null | undefined
): { answer: "yes" | "no" | "unclear"; evidence: string } | null {
  if (!facts) return null;
  const m = question.match(YEARS_RX);
  if (!m) return null;
  const min = parseFloat(m[1] ?? m[3] ?? m[4]);
  if (Number.isNaN(min)) return null;

  // Skill-scoped: use that skill's dated career years.
  const q = normTerm(question);
  for (const s of facts.skills || []) {
    const term = normTerm(s.skill);
    if (term.length >= 2 && q.includes(term)) {
      if (s.listedOnly) {
        return { answer: "unclear", evidence: `${s.skill} listed on profile, no dated evidence (computed)` };
      }
      return s.years >= min
        ? { answer: "yes", evidence: `${s.years}y ${s.skill} from dated history (computed)` }
        : { answer: "no", evidence: `${s.years}y ${s.skill} from dated history (computed)` };
    }
  }

  // Generic experience: career years answers it; domain-scoped stays with the model.
  if (GENERIC_EXP_RX.test(question) && facts.careerYears !== null && facts.careerYears !== undefined) {
    return facts.careerYears >= min
      ? { answer: "yes", evidence: `${facts.careerYears}y career from dated history (computed)` }
      : { answer: "no", evidence: `${facts.careerYears}y career from dated history (computed)` };
  }
  return null;
}

function applyYearsOverrides(verdict: Omit<RoleVerdict, "cached">, facts: CandidateFacts | null | undefined) {
  let changed = false;
  const answers = verdict.answers.map((a) => {
    const resolved = resolveYearsAnswer(a.question, facts);
    if (resolved && resolved.answer !== a.answer) {
      changed = true;
      return { ...a, ...resolved };
    }
    return a;
  });
  if (!changed) return verdict;
  // An override moved the ground truth — recompute qualification consistently.
  const noCount = answers.filter((a) => a.answer === "no").length;
  const yesCount = answers.filter((a) => a.answer === "yes").length;
  return {
    ...verdict,
    answers,
    qualified: noCount === 0 && yesCount >= Math.ceil(answers.length / 2),
    fit_score: Math.round((yesCount / Math.max(1, answers.length)) * 100) / 100,
  };
}

export async function screenRolesWithCache(args: {
  candidateId: string | null;
  evidence: string; // profile summary + deterministic facts + resume excerpt
  // Cache key material: MUST be stable raw inputs (resume text, harvest
  // payload) — never LLM output, which varies run to run and defeats the cache.
  cacheKeyText: string;
  jobIds: string[];
  facts?: CandidateFacts | null;
  source?: "apply" | "precompute" | "stretch";
  // stretch channel: which inferred signal spawned each pairing (jobId -> signal)
  originByJobId?: Record<string, string>;
  // scorecard inputs (stack evidence beyond dated skills)
  resumeText?: string | null;
  profileSkills?: string[];
  // Tenant scoping: external ids are only unique per organization. When set,
  // role resolution is limited to this org; unset = legacy unscoped behavior.
  organizationId?: string | null;
}): Promise<RoleVerdict[]> {
  const jobIds = args.jobIds.slice(0, 5);
  if (!jobIds.length || !args.evidence) return [];

  // Resolve org_roles (id + questions) for hashes and storage.
  let roleRows: { id: string; external_id: string; matching_profile: MatchingProfile | null; tech_stack?: string | null }[] = [];
  try {
    const orgFilter = args.organizationId ? `organization_id=eq.${args.organizationId}&` : "";
    const res = await sbRest(
      `org_roles?${orgFilter}external_id=in.(${jobIds.map((j) => `"${j}"`).join(",")})&select=id,external_id,matching_profile,tech_stack`
    );
    if (res.ok) roleRows = await res.json();
  } catch {}

  // Tenant runs never fall back to the site's JSON profiles — those are keyed
  // by transformer-talent job ids and would collide with tenant ids.
  const profileOf = (jobId: string): MatchingProfile | undefined =>
    roleRows.find((r) => r.external_id === jobId)?.matching_profile ||
    (args.organizationId ? undefined : PROFILES[jobId]);

  // Version prefix: bumping it invalidates every cached verdict, forcing a
  // re-screen under new rules. v6 = dimension scorecards.
  const candidateHash = sha("factsv6|" + args.cacheKeyText);
  const roleMeta = jobIds
    .map((jobId) => {
      const p = profileOf(jobId);
      if (!p) return null;
      return {
        jobId,
        orgRoleId: roleRows.find((r) => r.external_id === jobId)?.id ?? null,
        profile: p,
        roleHash: sha(JSON.stringify({ m: p.must_haves, q: p.screening_questions })),
      };
    })
    .filter((r): r is NonNullable<typeof r> => !!r);
  if (!roleMeta.length) return [];

  // Cache lookup (only pairings that can be keyed: known candidate + org role).
  const verdicts: RoleVerdict[] = [];
  const cachedRoleIds = new Set<string>();
  if (args.candidateId) {
    try {
      const ids = roleMeta.filter((r) => r.orgRoleId).map((r) => r.orgRoleId);
      if (ids.length) {
        const res = await sbRest(
          `match_verdicts?candidate_id=eq.${args.candidateId}&org_role_id=in.(${ids.join(",")})&candidate_hash=eq.${candidateHash}&select=id,org_role_id,role_hash,verdict,surfaced_count`
        );
        const rows: { id: string; org_role_id: string; role_hash: string; verdict: Omit<RoleVerdict, "cached">; surfaced_count: number }[] =
          res.ok ? await res.json() : [];
        for (const row of rows) {
          const meta = roleMeta.find((r) => r.orgRoleId === row.org_role_id && r.roleHash === row.role_hash);
          if (!meta) continue;
          cachedRoleIds.add(meta.jobId);
          verdicts.push({ ...row.verdict, job_id: meta.jobId, cached: true });
          sbRest(`match_verdicts?id=eq.${row.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              surfaced_count: row.surfaced_count + 1,
              last_surfaced_at: new Date().toISOString(),
            }),
            prefer: "return=minimal",
          }).catch(() => {});
        }
      }
    } catch {}
  }

  const toScreen = roleMeta.filter((r) => !cachedRoleIds.has(r.jobId));
  if (toScreen.length) {
    // Scope evidence is per-candidate: one small cited-answers call per batch.
    const scopeSignals: ScopeSignal[] = await assessScope(args.evidence);
    const fresh = (await interrogate(args.evidence, toScreen)).map((v) => {
      const corrected = applyYearsOverrides(v, args.facts);
      const meta = toScreen.find((r) => r.jobId === corrected.job_id);
      const roleRow = roleRows.find((r) => r.external_id === corrected.job_id);
      const scorecard = buildScorecard({
        techStack: roleRow?.tech_stack ?? null,
        minYears: meta?.profile.min_years ?? null,
        facts: args.facts,
        resumeText: args.resumeText,
        profileSkills: args.profileSkills || [],
        scopeSignals,
        answers: corrected.answers,
      });
      return { ...corrected, scorecard, cached: false as const };
    });
    verdicts.push(...fresh);
    // Store fresh verdicts for reuse + audit.
    if (args.candidateId) {
      const orgId = await getOrgId();
      if (orgId) {
        const rows = fresh
          .map((v) => {
            const meta = toScreen.find((r) => r.jobId === v.job_id);
            if (!meta?.orgRoleId) return null;
            return {
              organization_id: orgId,
              candidate_id: args.candidateId,
              org_role_id: meta.orgRoleId,
              candidate_hash: candidateHash,
              role_hash: meta.roleHash,
              verdict: {
                ...v,
                cached: undefined,
                facts: args.facts ?? undefined,
                ...(args.originByJobId?.[meta.jobId] ? { origin_signal: args.originByJobId[meta.jobId] } : {}),
              },
              model: "gpt-4o-mini",
              source: args.source || "apply",
            };
          })
          .filter(Boolean);
        if (rows.length) {
          await sbRest("match_verdicts?on_conflict=candidate_id,org_role_id,candidate_hash,role_hash", {
            method: "POST",
            body: JSON.stringify(rows),
            prefer: "resolution=ignore-duplicates,return=minimal",
          }).catch(() => {});
        }
      }
    }
  }
  return verdicts;
}

async function interrogate(
  evidence: string,
  roles: { jobId: string; profile: MatchingProfile }[]
): Promise<RoleVerdict[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return [];
  const rolesBlock = roles
    .map(
      (r) =>
        `ROLE ${r.jobId}:\nMUST-HAVES: ${r.profile.must_haves.join("; ")}\nQUESTIONS:\n${r.profile.screening_questions
          .slice(0, 8)
          .map((q, i) => `${i + 1}. ${q}`)
          .join("\n")}`
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
          name: "verdicts",
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
                    answers: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          question: { type: "string" },
                          answer: { type: "string", enum: ["yes", "no", "unclear"] },
                          evidence: { type: "string" },
                        },
                        required: ["question", "answer", "evidence"],
                      },
                    },
                    inferred_signals: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          signal: { type: "string" },
                          basis: { type: "string" },
                          probe: { type: "string" },
                        },
                        required: ["signal", "basis", "probe"],
                      },
                    },
                  },
                  required: ["job_id", "qualified", "fit_score", "answers", "inferred_signals"],
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
            "You screen one candidate against several roles. Answer EVERY question for every role " +
            "with yes/no/unclear plus a short evidence citation (max 12 words, quoting the source). " +
            "The FACTS block is pre-computed from the candidate's dated position history — treat it " +
            "as ground truth over your own inference. No evidence = 'unclear', never a guess. " +
            "Numeric-range questions ('2-5 years?'): answer yes when the candidate's number falls " +
            "anywhere WITHIN the range — 2.1 years satisfies '2-5 years'. 'At least N' means >= N. " +
            "qualified = no must-have is clearly failed and most questions are yes. " +
            "fit_score = 0-1 overall judgment. " +
            "inferred_signals (0-3 per role, [] when none): capabilities the evidence SUGGESTS but does not " +
            "prove — especially from Co-occurrence lines (e.g. PyTorch + Kubernetes in one position suggests " +
            "ML-infrastructure exposure). Each needs: signal, basis (cite the exact evidence combination), " +
            "probe (what to ask on a call). Signals are leads for a recruiter — they must NEVER justify a " +
            "'yes' answer or affect qualified. Only signals relevant to that role's requirements.",
        },
        { role: "user", content: `CANDIDATE:\n${evidence.slice(0, 7000)}\n\n${rolesBlock}` },
      ],
    }),
  });
  if (!res.ok) return [];
  try {
    const data = await res.json();
    const results = JSON.parse(data.choices[0].message.content).results as Omit<RoleVerdict, "cached">[];
    return results
      // The model sometimes echoes "ROLE 76" instead of "76".
      .map((r) => ({ ...r, job_id: String(r.job_id).replace(/^role\s*/i, "").trim() }))
      .filter((r) => roles.some((x) => x.jobId === r.job_id))
      // Hard cap regardless of what the model returned.
      .map((r) => ({ ...r, inferred_signals: (r.inferred_signals || []).slice(0, 3), cached: false }));
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
