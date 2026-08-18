import { NextRequest, NextResponse } from "next/server";
import { allow } from "@/lib/server/ratelimit";
import { sbInsert, sbRest } from "@/lib/server/supabase";
import {
  harvestProfile,
  parseProfile,
  promoteToCandidatePool,
  matchRolesForApplicant,
  mirrorToAirtable,
  mirrorApplicationToAirtable,
  linkedinUsername,
} from "@/lib/server/applicants";
import { getRoles, roleSlug } from "@/lib/roles";
import { passesHardGates, passesProfileGates, screenRolesWithCache } from "@/lib/server/screening";
import { loadOrgBySlug, loadOrgRoles, matchOrgRolesForApplicant, type BoardRole } from "@/lib/server/org-board";
import { llamaParsePdf } from "@/lib/server/llamaparse";
import {
  getOrgId,
  recordEnrichment,
  syncExperiences,
  syncCandidateEmbeddings,
  linkedinProfileText,
  harvestToExperiences,
} from "@/lib/server/spine";
import { computeFacts, formatFacts } from "@/lib/server/facts";
import { sanitizeLocationOptions, roleLocationCompatible } from "@/lib/server/locations";
import { renderScorecard } from "@/lib/server/scorecard";

export const maxDuration = 60;

const MAX_RESUME_BYTES = 8 * 1024 * 1024;

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

async function uploadResume(path: string, buf: Buffer): Promise<boolean> {
  const key = process.env.SUPABASE_STORAGE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.SUPABASE_URL;
  if (!key || !url) return false;
  const res = await fetch(`${url}/storage/v1/object/resumes/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      "Content-Type": "application/pdf",
    },
    body: new Uint8Array(buf),
  });
  if (!res.ok) console.error("resume upload failed", res.status, await res.text());
  return res.ok;
}

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (clean(form.get("website"), 50)) return NextResponse.json({ ok: true });

  // Tenant boards post their org slug; absent/own slug = the site's own flow.
  const boardSlug = clean(form.get("board"), 60);
  let boardOrg: { id: string; slug: string; name: string } | null = null;
  if (boardSlug && boardSlug !== "transformer-talent") {
    boardOrg = await loadOrgBySlug(boardSlug);
    if (!boardOrg) return NextResponse.json({ error: "Unknown board." }, { status: 400 });
  }

  const name = clean(form.get("name"), 120);
  const email = clean(form.get("email"), 254).toLowerCase();
  const linkedin = clean(form.get("linkedin"), 300);
  const visa = clean(form.get("visa"), 150);
  const note = clean(form.get("note"), 2000);
  const speculative = clean(form.get("speculative"), 5) === "1";
  const preferredLocations = sanitizeLocationOptions(
    form.getAll("preferredLocations").map((v) => clean(v, 30))
  );
  const roleIds = speculative
    ? []
    : clean(form.get("roleIds"), 500)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 3);

  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Please provide your name and a valid email." }, { status: 400 });
  }
  if (!linkedin || !linkedinUsername(linkedin)) {
    return NextResponse.json(
      { error: "Please provide your LinkedIn profile URL (linkedin.com/in/…)." },
      { status: 400 }
    );
  }

  const ip =
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown";
  if (!(await allow(`apply:email:${email}`, 4, 24)) || !(await allow(`apply:ip:${ip}`, 8, 24))) {
    return NextResponse.json(
      { error: "Too many applications today — email spencer@transformertalent.com directly." },
      { status: 429 }
    );
  }
  if (!(await allow("apply:global", 100, 24))) {
    return NextResponse.json(
      { error: "We're at capacity today — email spencer@transformertalent.com with your resume and we'll take it from there." },
      { status: 429 }
    );
  }

  // Resume (optional; required for speculative — it's what we match with)
  const file = form.get("resume");
  if (speculative && !(file instanceof File && file.size > 0)) {
    return NextResponse.json(
      { error: "A resume is required for a speculative application." },
      { status: 400 }
    );
  }
  let resumePath: string | null = null;
  let resumeText: string | null = null;
  let resumeParser: "llamaparse" | "pdf-parse" | null = null;
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_RESUME_BYTES || (file.type && file.type !== "application/pdf")) {
      return NextResponse.json({ error: "Resume must be a PDF under 8MB." }, { status: 400 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const safeName = (file.name || "resume.pdf").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
    const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safeName}`;
    if (await uploadResume(path, buf)) resumePath = path;
    resumeText = await llamaParsePdf(buf, safeName);
    if (resumeText) {
      resumeParser = "llamaparse";
    } else {
      resumeText = (await extractPdfText(buf)) || null;
      if (resumeText) resumeParser = "pdf-parse";
    }
  }

  // Tenant boards: roles come from that org's org_roles rows, shaped like
  // site roles so everything downstream is identical.
  const boardRoles: BoardRole[] | null = boardOrg ? await loadOrgRoles(boardOrg.id) : null;
  const roles = boardRoles ?? (await getRoles());
  const applied = roles.filter((r) => roleIds.includes(r.jobId));
  const roleTitles = applied.map((r) => `${r.title} (#${r.jobId})`);

  const orgId = boardOrg?.id ?? (await getOrgId());
  const submission = await sbInsert<{ id: string }>(
    "website_applications",
    {
      organization_id: orgId,
      name,
      email,
      linkedin_url: linkedin,
      linkedin_username: linkedinUsername(linkedin),
      visa_status: visa || null,
      preferred_locations: preferredLocations,
      role_ids: applied.map((r) => r.jobId),
      role_titles: roleTitles,
      resume_path: resumePath,
      resume_text: resumeText,
      status: "processing",
      source: [speculative ? "speculative" : null, note ? `note: ${note}` : null]
        .filter(Boolean)
        .join("; ") || null,
      ip: ip === "unknown" ? null : ip,
      user_agent: clean(req.headers.get("user-agent"), 500),
    },
    true
  ).catch((e) => {
    console.error("application insert failed", e);
    return null;
  });

  // Enrichment pipeline — best-effort; the application is already saved.
  let matches: { jobId: string; title: string; salary: string; slug: string }[] = [];
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
        // Tenant roles have no site detail pages — empty slug renders unlinked.
        .map((r) => ({
          jobId: r.jobId,
          title: r.title,
          salary: r.salary,
          slug: boardOrg ? "" : roleSlug(r),
        }));
    }

    if (submission) {
      await sbRest(`website_applications?id=eq.${submission.id}`, {
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
    }

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
    if (submission) {
      await sbRest(`website_applications?id=eq.${submission.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "received" }),
        prefer: "return=minimal",
      }).catch(() => {});
    }
  }

  // Review row for EVERY application — even when enrichment failed above.
  if (submission) {
    await mirrorApplicationToAirtable({
      applicationId: submission.id,
      name,
      email,
      linkedinUrl: linkedin,
      visa: visa || null,
      roleTitles: speculative ? ["Speculative — resume drop"] : roleTitles,
      matchedTitles: matches.map((m) => `${m.title} (#${m.jobId})`),
      resumePath,
      appliedRoleIds: applied.map((r) => r.jobId),
      matchedRoleIds: matches.map((m) => m.jobId),
      applicationType: roleIds.length ? "Applied" : "Speculative",
      screenedSummary,
      preferredLocations,
      applicationFit,
    });
  }

  // applicationId lets the thank-you page add suggested roles for 1 hour.
  return NextResponse.json({ ok: true, matches, applicationId: submission?.id ?? null });
}
