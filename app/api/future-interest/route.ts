import { after, NextRequest, NextResponse } from "next/server";
import { allow } from "@/lib/server/ratelimit";
import { sbInsert, sbRest } from "@/lib/server/supabase";
import { linkedinUsername } from "@/lib/server/applicants";
import { loadOrgBySlug } from "@/lib/server/org-board";
import { getOrgId } from "@/lib/server/spine";
import { runApplicantPipeline } from "@/lib/server/applicant-pipeline";

export const maxDuration = 60;

// "Hear from me later": a candidate on a recruiter page asks to be contacted
// in N months, optionally saying what the outreach should be about. Saved as
// a website_applications row (source "future", follow_up_at set) so the whole
// existing machinery — dedupe, enrichment, candidate pool, lead emails —
// applies unchanged.

const MAX_RESUME_BYTES = 8 * 1024 * 1024;
const MONTHS = new Set(["3", "6", "9", "12"]);

function clean(s: unknown, max: number): string {
  return String(s ?? "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .trim()
    .slice(0, max);
}

function followUpDate(months: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
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

  const boardSlug = clean(form.get("board"), 60);
  let boardOrg: { id: string; slug: string; name: string } | null = null;
  if (boardSlug && boardSlug !== "transformer-talent") {
    boardOrg = await loadOrgBySlug(boardSlug);
    if (!boardOrg) return NextResponse.json({ error: "Unknown board." }, { status: 400 });
  }

  const recruiterId = clean(form.get("recruiter"), 40);
  if (recruiterId && !/^[0-9a-f-]{36}$/.test(recruiterId)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const email = clean(form.get("email"), 254).toLowerCase();
  const linkedin = clean(form.get("linkedin"), 300);
  const monthsRaw = clean(form.get("months"), 3);
  const preferredRoles = clean(form.get("prefRoles"), 200)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 6);
  const preferredLocation = clean(form.get("prefLocation"), 120) || null;
  const salaryFloor = clean(form.get("prefSalary"), 60) || null;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Please provide a valid email." }, { status: 400 });
  }
  if (!linkedin || !linkedinUsername(linkedin)) {
    return NextResponse.json(
      { error: "Please provide your LinkedIn profile URL (linkedin.com/in/…)." },
      { status: 400 }
    );
  }
  if (!MONTHS.has(monthsRaw)) {
    return NextResponse.json({ error: "Please pick when to get back to you." }, { status: 400 });
  }
  const followUpAt = followUpDate(Number(monthsRaw));

  const ip =
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown";
  if (!(await allow(`future:email:${email}`, 3, 24)) || !(await allow(`future:ip:${ip}`, 6, 24))) {
    return NextResponse.json({ error: "Too many requests today — try again tomorrow." }, { status: 429 });
  }
  if (!(await allow("future:global", 50, 24))) {
    return NextResponse.json({ error: "We're at capacity today — try again tomorrow." }, { status: 429 });
  }

  // Same person recently in this org's pipeline: update their existing entry
  // with the new date and preferences instead of creating a duplicate. The
  // "we'll be in touch later" ask is meaningful even from a recent applicant.
  const orgId = boardOrg?.id ?? (await getOrgId());
  const dupSince = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  const dupUsername = linkedinUsername(linkedin) || "";
  const [dupByEmail, dupByLinkedin] = await Promise.all([
    sbRest(
      `website_applications?organization_id=eq.${orgId}&email=eq.${encodeURIComponent(email)}&created_at=gte.${dupSince}&select=id,candidate_id&limit=1`
    ),
    sbRest(
      `website_applications?organization_id=eq.${orgId}&linkedin_username=eq.${encodeURIComponent(dupUsername)}&created_at=gte.${dupSince}&select=id,candidate_id&limit=1`
    ),
  ]);
  const dupRows = [
    ...(dupByEmail.ok ? ((await dupByEmail.json()) as { id: string; candidate_id: string | null }[]) : []),
    ...(dupByLinkedin.ok ? ((await dupByLinkedin.json()) as { id: string; candidate_id: string | null }[]) : []),
  ];
  if (dupRows.length > 0) {
    const dup = dupRows[0];
    const prefs = {
      follow_up_at: followUpAt,
      preferred_roles: preferredRoles,
      location: preferredLocation,
      comp_expectation: salaryFloor,
    };
    await sbRest(`website_applications?id=eq.${dup.id}`, {
      method: "PATCH",
      body: JSON.stringify(prefs),
      prefer: "return=minimal",
    }).catch(() => {});
    if (dup.candidate_id) {
      await sbRest(`candidates?id=eq.${dup.candidate_id}`, {
        method: "PATCH",
        body: JSON.stringify({
          follow_up_at: followUpAt,
          role_preferences: { roles: preferredRoles, location: preferredLocation, salary: salaryFloor },
        }),
        prefer: "return=minimal",
      }).catch(() => {});
    }
    return NextResponse.json({ ok: true, followUpAt });
  }

  // Resume is optional here — the whole point is catching people who aren't
  // ready to formally apply yet.
  const file = form.get("resume");
  let resumePath: string | null = null;
  let resumeBuf: Buffer | null = null;
  let resumeSafeName = "resume.pdf";
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_RESUME_BYTES || (file.type && file.type !== "application/pdf")) {
      return NextResponse.json({ error: "Resume must be a PDF under 8MB." }, { status: 400 });
    }
    resumeBuf = Buffer.from(await file.arrayBuffer());
    resumeSafeName = (file.name || "resume.pdf").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
    const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${resumeSafeName}`;
    if (await uploadResume(path, resumeBuf)) resumePath = path;
  }

  // Attribution only when the profile is real, published, and belongs to the
  // org — anything else is silently dropped, never a block.
  let recruiterProfileId: string | null = null;
  if (recruiterId) {
    const rres = await sbRest(
      `recruiter_profiles?id=eq.${recruiterId}&published=is.true&select=id,organization_id`
    );
    const [rp] = rres.ok
      ? ((await rres.json()) as { id: string; organization_id: string }[])
      : [];
    if (rp && rp.organization_id === orgId) recruiterProfileId = rp.id;
  }

  const submission = await sbInsert<{ id: string }>(
    "website_applications",
    {
      organization_id: orgId,
      recruiter_profile_id: recruiterProfileId,
      // Name resolved from the LinkedIn profile by the pipeline (same as
      // referrals) — one less field between the candidate and "done".
      name: "",
      email,
      linkedin_url: linkedin,
      linkedin_username: linkedinUsername(linkedin),
      follow_up_at: followUpAt,
      preferred_roles: preferredRoles,
      location: preferredLocation,
      comp_expectation: salaryFloor,
      role_ids: [],
      role_titles: [],
      resume_path: resumePath,
      resume_text: null,
      status: "processing",
      source: "future",
      ip: ip === "unknown" ? null : ip,
      user_agent: clean(req.headers.get("user-agent"), 500),
    },
    true
  ).catch((e) => {
    console.error("future-interest insert failed", e);
    return null;
  });

  if (!submission) {
    return NextResponse.json(
      { error: "Something went wrong saving your request. Please try again." },
      { status: 502 }
    );
  }

  after(async () => {
    await runApplicantPipeline({
      submissionId: submission.id,
      name: "",
      email,
      linkedin,
      visa: "",
      preferredLocations: [],
      roleIds: [],
      speculative: true,
      resumeBuf,
      resumeSafeName,
      resumePath,
      boardOrg,
      orgId,
      applicationType: "Speculative",
      followUpAt,
      preferredRoles,
      preferredLocation,
      salaryFloor,
    });
  });
  return NextResponse.json({ ok: true, followUpAt });
}
