import crypto from "node:crypto";
import profilesJson from "@/data/matching-profiles.json";
import { sbRest } from "./supabase";
import { getOrgId } from "./spine";
import type { CandidateFacts } from "./facts";

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

export interface RoleVerdict {
  job_id: string;
  qualified: boolean;
  fit_score: number;
  answers: VerdictAnswer[];
  cached: boolean;
}

export async function screenRolesWithCache(args: {
  candidateId: string | null;
  evidence: string; // profile summary + deterministic facts + resume excerpt
  // Cache key material: MUST be stable raw inputs (resume text, harvest
  // payload) — never LLM output, which varies run to run and defeats the cache.
  cacheKeyText: string;
  jobIds: string[];
  facts?: CandidateFacts | null;
}): Promise<RoleVerdict[]> {
  const jobIds = args.jobIds.slice(0, 5);
  if (!jobIds.length || !args.evidence) return [];

  // Resolve org_roles (id + questions) for hashes and storage.
  let roleRows: { id: string; external_id: string; matching_profile: MatchingProfile | null }[] = [];
  try {
    const res = await sbRest(
      `org_roles?external_id=in.(${jobIds.map((j) => `"${j}"`).join(",")})&select=id,external_id,matching_profile`
    );
    if (res.ok) roleRows = await res.json();
  } catch {}

  const profileOf = (jobId: string): MatchingProfile | undefined =>
    roleRows.find((r) => r.external_id === jobId)?.matching_profile || PROFILES[jobId];

  const candidateHash = sha(args.cacheKeyText);
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
    const fresh = await interrogate(args.evidence, toScreen);
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
              verdict: { ...v, cached: undefined, facts: args.facts ?? undefined },
              model: "gpt-4o-mini",
              source: "apply",
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
                  },
                  required: ["job_id", "qualified", "fit_score", "answers"],
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
            "qualified = no must-have is clearly failed and most questions are yes. " +
            "fit_score = 0-1 overall judgment.",
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
      .filter((r) => roles.some((x) => x.jobId === r.job_id))
      .map((r) => ({ ...r, cached: false }));
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
