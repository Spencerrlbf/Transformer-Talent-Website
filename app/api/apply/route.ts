import { NextRequest, NextResponse } from "next/server";
import { allow } from "@/lib/server/ratelimit";
import { sbInsert, sbRest } from "@/lib/server/supabase";
import {
  harvestProfile,
  parseProfile,
  promoteToCandidatePool,
  matchRolesForApplicant,
  mirrorToAirtable,
  linkedinUsername,
} from "@/lib/server/applicants";
import { getRoles, roleSlug } from "@/lib/roles";
import { passesHardGates, screenCandidate } from "@/lib/server/screening";

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

  const name = clean(form.get("name"), 120);
  const email = clean(form.get("email"), 254).toLowerCase();
  const linkedin = clean(form.get("linkedin"), 300);
  const visa = clean(form.get("visa"), 150);
  const note = clean(form.get("note"), 2000);
  const roleIds = clean(form.get("roleIds"), 500)
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

  // Resume (optional)
  const file = form.get("resume");
  let resumePath: string | null = null;
  let resumeText: string | null = null;
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_RESUME_BYTES || (file.type && file.type !== "application/pdf")) {
      return NextResponse.json({ error: "Resume must be a PDF under 8MB." }, { status: 400 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const safeName = (file.name || "resume.pdf").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
    const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safeName}`;
    if (await uploadResume(path, buf)) resumePath = path;
    resumeText = await extractPdfText(buf);
  }

  const roles = await getRoles();
  const applied = roles.filter((r) => roleIds.includes(r.jobId));
  const roleTitles = applied.map((r) => `${r.title} (#${r.jobId})`);

  const submission = await sbInsert<{ id: string }>(
    "website_applications",
    {
      name,
      email,
      linkedin_url: linkedin,
      linkedin_username: linkedinUsername(linkedin),
      visa_status: visa || null,
      role_ids: applied.map((r) => r.jobId),
      role_titles: roleTitles,
      resume_path: resumePath,
      resume_text: resumeText,
      status: "processing",
      source: note ? `note: ${note}` : null,
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
  try {
    const username = linkedinUsername(linkedin);
    let harvest: unknown | null = null;
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    const prior = await sbRest(
      `website_applications?linkedin_username=eq.${encodeURIComponent(username || "")}&harvest_profile=not.is.null&created_at=gte.${since}&select=harvest_profile&order=created_at.desc&limit=1`
    );
    if (prior.ok) {
      const rows = await prior.json();
      if (rows.length) harvest = rows[0].harvest_profile;
    }
    if (!harvest) harvest = await harvestProfile(linkedin);
    const parsed = await parseProfile(resumeText || "", harvest);
    const { candidateId, vector } = await promoteToCandidatePool({
      name,
      email,
      linkedinUrl: linkedin,
      resumeText,
      parsed,
    });

    let matchedIds: string[] = [];
    let screening: unknown = null;
    if (vector) {
      const roleMatches = await matchRolesForApplicant(vector);
      const gated = roleMatches
        .filter((m) => m.similarity > 0.25)
        .filter((m) =>
          passesHardGates(m.job_id, {
            visa,
            years: parsed?.total_experience_years ?? null,
          })
        );
      // One bounded LLM call screens the shortlist like a recruiter would.
      const results = await screenCandidate(
        parsed?.profile_summary || resumeText?.slice(0, 3000) || "",
        gated.slice(0, 5).map((m) => m.job_id)
      );
      screening = results.length ? results : null;
      const scoreOf = (jobId: string, sim: number) => {
        const r = results.find((x) => x.job_id === jobId);
        return r ? (r.qualified ? 0.5 : 0) + 0.3 * r.fit_score + 0.2 * sim : 0.2 * sim;
      };
      const ranked = gated
        .filter((m) => {
          const r = results.find((x) => x.job_id === m.job_id);
          return !r || r.fails.length === 0;
        })
        .sort((a, b) => scoreOf(b.job_id, b.similarity) - scoreOf(a.job_id, a.similarity));
      matchedIds = ranked.map((m) => m.job_id);
      matches = ranked
        .map((m) => roles.find((r) => r.jobId === m.job_id))
        .filter((r): r is NonNullable<typeof r> => Boolean(r))
        .filter((r) => !roleIds.includes(r.jobId))
        .slice(0, 4)
        .map((r) => ({ jobId: r.jobId, title: r.title, salary: r.salary, slug: roleSlug(r) }));
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

  return NextResponse.json({ ok: true, matches });
}
