// The applicant enrichment pipeline, shared by /api/apply (applications) and
// /api/referral (referred people). Runs AFTER the HTTP response via after():
// resume parsing (when there is one), Harvest enrichment, candidate-pool
// promotion, spine records, screening, and the Airtable mirrors. One pipeline
// for every way a person enters the system.
import { sbRest } from "./supabase";
import {
  harvestProfile,
  parseProfile,
  promoteToCandidatePool,
  matchRolesForApplicant,
  mirrorToAirtable,
  mirrorApplicationToAirtable,
  linkedinUsername,
} from "./applicants";
import { getRoles } from "@/lib/roles";
import { passesHardGates, passesProfileGates, screenRolesWithCache } from "./screening";
import { loadOrgRoles, matchOrgRolesForApplicant, type BoardRole } from "./org-board";
import { llamaParsePdf } from "./llamaparse";
import {
  recordEnrichment,
  syncExperiences,
  syncCandidateEmbeddings,
  linkedinProfileText,
  harvestToExperiences,
} from "./spine";
import { computeFacts, formatFacts } from "./facts";
import { roleLocationCompatible } from "./locations";
import { renderScorecard } from "./scorecard";

export type ApplicantPipelineInput = {
  submissionId: string;
  /** Empty string = unknown (referrals): resolved from the Harvest profile
   *  and patched onto the application row. */
  name: string;
  email: string;
  linkedin: string;
  visa: string;
  preferredLocations: string[];
  /** Roles the person explicitly applied to (empty for speculative/referral). */
  roleIds: string[];
  speculative: boolean;
  resumeBuf: Buffer | null;
  resumeSafeName: string;
  resumePath: string | null;
  /** Tenant org when the entry came through a tenant surface; null = TT site. */
  boardOrg: { id: string; slug: string; name: string } | null;
  orgId: string | null;
  applicationType: "Applied" | "Speculative" | "Referral";
};

function clean(s: unknown, max: number): string {
  return String(s ?? "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .trim()
    .slice(0, max);
}

async function extractPdfText(buf: Buffer): Promise<string> {
  try {
    const mod = await import("pdf-parse/lib/pdf-parse.js");
    const pdf = (mod.default || mod) as (b: Buffer) => Promise<{ text: string }>;
    const out = await pdf(buf);
    return clean(out.text, 60000);
  } catch (err) {
    console.error("pdf extraction failed", err);
    return "";
  }
}

function nameFromProfile(
  harvest: Record<string, unknown> | null,
  fallback: string
): string {
  if (!harvest) return fallback;
  const full = clean(harvest.full_name ?? harvest.name, 120);
  if (full) return full;
  const first = clean(harvest.first_name, 60);
  const last = clean(harvest.last_name, 60);
  return [first, last].filter(Boolean).join(" ") || fallback;
}

export async function runApplicantPipeline(p: ApplicantPipelineInput): Promise<void> {
  const {
    submissionId, email, linkedin, visa, preferredLocations,
    roleIds, speculative, resumeBuf, resumeSafeName, resumePath, boardOrg, orgId,
  } = p;
  let name = p.name;

  // Resume text (when a resume exists).
  let resumeText: string | null = null;
  let resumeParser: "llamaparse" | "pdf-parse" | null = null;
  if (resumeBuf) {
    resumeText = await llamaParsePdf(resumeBuf, resumeSafeName);
    if (resumeText) {
      resumeParser = "llamaparse";
    } else {
      resumeText = (await extractPdfText(resumeBuf)) || null;
      if (resumeText) resumeParser = "pdf-parse";
    }
    if (resumeText) {
      await sbRest(`website_applications?id=eq.${submissionId}`, {
        method: "PATCH",
        body: JSON.stringify({ resume_text: resumeText }),
        prefer: "return=minimal",
      }).catch(() => {});
    }
  }

  const boardRoles: BoardRole[] | null = boardOrg ? await loadOrgRoles(boardOrg.id) : null;
  const roles = boardRoles ?? (await getRoles());
  const applied = roles.filter((r) => roleIds.includes(r.jobId));
  const roleTitles = applied.map((r) => `${r.title} (#${r.jobId})`);

  let matches: { jobId: string; title: string; salary: string }[] = [];
  let screenedSummary: string | undefined;
  let applicationFit: string | undefined;
  try {
    const username = linkedinUsername(linkedin);
    let harvest: unknown | null = null;
    let harvestCache: "hit" | "miss" = "miss";
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    const prior = await sbRest(
      `website_applications?linkedin_username=eq.${encodeURIComponent(username || "")}&harvest_profile=not.is.null&created_at=gte.${since}&select=harvest_profile&order=created_at.desc&limit=1`
    );
    if (prior.ok) {
      const rows = await prior.json();
      if (rows.length) {
        harvest = rows[0].harvest_profile;
        harvestCache = "hit";
      }
    }
    if (!harvest) harvest = await harvestProfile(linkedin);
    const parsed = await parseProfile(resumeText || "", harvest);

    // Referrals arrive with no name — take it from the profile.
    if (!name) {
      name = nameFromProfile(harvest as Record<string, unknown> | null, username || email);
      await sbRest(`website_applications?id=eq.${submissionId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
        prefer: "return=minimal",
      }).catch(() => {});
    }

    // Full uncapped skill list from Harvest — richer than the parsed top 12.
    const harvestSkills = (
      ((harvest as Record<string, unknown> | null)?.skills as { name?: string }[] | undefined) || []
    )
      .map((s) => s?.name || "")
      .filter(Boolean);
    const { candidateId, vector } = await promoteToCandidatePool({
      name,
      email,
      linkedinUrl: linkedin,
      resumeText,
      parsed,
      allSkills: harvestSkills,
    });

    // V2 spine: spend ledger, per-position experiences, multi-vector embeddings.
    if (harvest) {
      await recordEnrichment({
        candidateId,
        linkedinUsername: username,
        provider: "harvest",
        operation: "full_profile",
        cacheStatus: harvestCache,
        normalized: parsed,
        raw: harvest,
        costCredits: harvestCache === "miss" ? 1 : 0,
      });
    }
    if (resumeParser) {
      await recordEnrichment({
        candidateId,
        linkedinUsername: username,
        provider: resumeParser,
        operation: "resume_parse",
        cacheStatus: "miss",
      });
    }
    if (candidateId) {
      await syncExperiences(candidateId, harvest as Record<string, unknown> | null);
      await syncCandidateEmbeddings(candidateId, {
        linkedin_profile: linkedinProfileText(harvest as Record<string, unknown> | null),
        resume: resumeText || undefined,
        summary: parsed?.profile_summary || undefined,
      });
    }

    let matchedIds: string[] = [];
    let screening: unknown = null;
    if (vector) {
      const skillTerms = harvestSkills.length ? harvestSkills : parsed?.top_skills || [];
      const expRows = harvestToExperiences(harvest as Record<string, unknown> | null);
      const eduList = (harvest as Record<string, unknown> | null)?.education ?? null;
      // Career years (post-graduation, internships excluded) is THE years
      // number everywhere — gates and screening facts can't disagree.
      const careerYears = computeFacts(expRows, [], [], eduList).careerYears;
      // Suggestions never leave the board's company: tenant boards search
      // only that org's roles; the site searches its own.
      const roleMatches = boardOrg
        ? await matchOrgRolesForApplicant(vector, boardOrg.id)
        : await matchRolesForApplicant(vector, skillTerms, orgId);
      const applicantGate = {
        visa,
        years: careerYears ?? parsed?.total_experience_years ?? null,
      };
      const gated = roleMatches
        // Vector rows need a floor; keyword rows earned their spot via ≥2 stack hits.
        .filter((m) => m.similarity > 0.25 || m.keyword_hits >= 2)
        .filter((m) =>
          boardRoles
            ? passesProfileGates(
                boardRoles.find((r) => r.jobId === m.job_id)?.matchingProfile,
                applicantGate
              )
            : passesHardGates(m.job_id, applicantGate)
        )
        // Location: stated preferences first, LinkedIn location as fallback.
        .filter((m) => {
          const role = roles.find((r) => r.jobId === m.job_id);
          return !role || roleLocationCompatible(role, preferredLocations, parsed?.location);
        });
      // Question-sheet screening: deterministic facts first, then ONE cached
      // batched LLM call answering each role's questions with evidence.
      // APPLIED roles are always screened (bypassing gates — they chose to
      // apply; shortfalls become verdict findings, never a reason to skip).
      const shortlistIds = [
        ...new Set([...roleIds, ...gated.map((m) => m.job_id)]),
      ].slice(0, 5);
      const stackTerms = [
        ...new Set(
          shortlistIds.flatMap((id) =>
            (roles.find((r) => r.jobId === id)?.techStack || "")
              .split(/[,/•]/)
              .map((s) => s.trim())
              .filter((s) => s.length >= 2)
          )
        ),
      ].slice(0, 20);
      const facts = computeFacts(expRows, stackTerms, harvestSkills, eduList);
      const evidence = [
        parsed?.profile_summary,
        `FACTS (computed from dated position history):\n${formatFacts(facts)}`,
        resumeText ? `RESUME EXCERPT:\n${resumeText.slice(0, 3000)}` : null,
      ]
        .filter(Boolean)
        .join("\n\n");
      const results = await screenRolesWithCache({
        candidateId,
        evidence,
        // Stable raw inputs only — the parsed summary is LLM output and varies.
        cacheKeyText: [resumeText || "", JSON.stringify(harvest ?? null)].join("|"),
        jobIds: shortlistIds,
        facts,
        resumeText,
        profileSkills: harvestSkills,
        organizationId: orgId,
      });
      screening = results.length ? results : null;
      screenedSummary = results.length
        ? `${results.length} screened (${results.filter((r) => r.qualified).length} qualified)`
        : undefined;
      // Hiring guidance for the roles they APPLIED to.
      applicationFit =
        roleIds
          .map((id) => {
            const r = results.find((x) => x.job_id === id);
            return r?.scorecard ? renderScorecard(id, r.scorecard) : null;
          })
          .filter(Boolean)
          .join("\n\n") || undefined;
      const scoreOf = (m: { job_id: string; similarity: number; keyword_hits: number }) => {
        const r = results.find((x) => x.job_id === m.job_id);
        const kw = 0.05 * Math.min(m.keyword_hits, 4); // exact stack hits, up to 0.2
        const base = 0.15 * m.similarity + kw;
        return r ? (r.qualified ? 0.5 : 0) + 0.3 * r.fit_score + base : base;
      };
      const ranked = gated
        .filter((m) => {
          const r = results.find((x) => x.job_id === m.job_id);
          return !r || r.qualified || r.answers.filter((a) => a.answer === "no").length === 0;
        })
        .sort((a, b) => scoreOf(b) - scoreOf(a));
      matchedIds = ranked.map((m) => m.job_id);
      matches = ranked
        .map((m) => roles.find((r) => r.jobId === m.job_id))
        .filter((r): r is NonNullable<typeof r> => Boolean(r))
        .filter((r) => !roleIds.includes(r.jobId))
        .slice(0, 4)
        .map((r) => ({ jobId: r.jobId, title: r.title, salary: r.salary }));
    }

    await sbRest(`website_applications?id=eq.${submissionId}`, {
      method: "PATCH",
      body: JSON.stringify({
        harvest_profile: harvest,
        parsed_profile: parsed,
        candidate_id: candidateId,
        matched_role_ids: matchedIds,
        screening,
        status: "processed",
      }),
      prefer: "return=minimal",
    }).catch(() => {});

    await mirrorToAirtable({
      name,
      email,
      linkedinUrl: linkedin,
      currentTitle: parsed?.current_title || null,
      currentCompany: parsed?.current_company || null,
      roleTitles,
    });
  } catch (err) {
    console.error("applicant pipeline failed", err);
    await sbRest(`website_applications?id=eq.${submissionId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "received" }),
      prefer: "return=minimal",
    }).catch(() => {});
  }

  // Review row for EVERY entry — even when enrichment failed above.
  await mirrorApplicationToAirtable({
    applicationId: submissionId,
    name: name || email,
    email,
    linkedinUrl: linkedin,
    visa: visa || null,
    roleTitles:
      p.applicationType === "Referral"
        ? ["Referral"]
        : speculative
          ? ["Speculative — resume drop"]
          : roleTitles,
    matchedTitles: matches.map((m) => `${m.title} (#${m.jobId})`),
    resumePath,
    appliedRoleIds: applied.map((r) => r.jobId),
    matchedRoleIds: matches.map((m) => m.jobId),
    applicationType: p.applicationType,
    screenedSummary,
    preferredLocations,
    applicationFit,
  });
}
