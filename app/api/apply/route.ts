import { after, NextRequest, NextResponse } from "next/server";
import { allow } from "@/lib/server/ratelimit";
import { sbInsert, sbRest } from "@/lib/server/supabase";
import { linkedinUsername } from "@/lib/server/applicants";
import { getRoles } from "@/lib/roles";
import { loadOrgBySlug, loadOrgRoles, type BoardRole } from "@/lib/server/org-board";
import { getOrgId } from "@/lib/server/spine";
import { sanitizeLocationOptions } from "@/lib/server/locations";
import { runApplicantPipeline } from "@/lib/server/applicant-pipeline";

export const maxDuration = 60;

const MAX_RESUME_BYTES = 8 * 1024 * 1024;

function clean(s: unknown, max: number): string {
  return String(s ?? "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .trim()
    .slice(0, max);
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

  // Recruiter pages post their profile id so outreach conversion is
  // attributable. Everything on a recruiter page is mandatory, resume included.
  const recruiterId = clean(form.get("recruiter"), 40);
  if (recruiterId && !/^[0-9a-f-]{36}$/.test(recruiterId)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
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

  // Same person again within 14 days (same org, matched by email OR LinkedIn
  // username): no duplicate row, no pipeline — their existing application is
  // already being reviewed against every role. Friendly response instead.
  const orgId = boardOrg?.id ?? (await getOrgId());
  const dupSince = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  const dupUsername = linkedinUsername(linkedin) || "";
  const [dupByEmail, dupByLinkedin] = await Promise.all([
    sbRest(
      `website_applications?organization_id=eq.${orgId}&email=eq.${encodeURIComponent(email)}&created_at=gte.${dupSince}&select=id&limit=1`
    ),
    sbRest(
      `website_applications?organization_id=eq.${orgId}&linkedin_username=eq.${encodeURIComponent(dupUsername)}&created_at=gte.${dupSince}&select=id&limit=1`
    ),
  ]);
  const dupRows = [
    ...(dupByEmail.ok ? ((await dupByEmail.json()) as { id: string }[]) : []),
    ...(dupByLinkedin.ok ? ((await dupByLinkedin.json()) as { id: string }[]) : []),
  ];
  if (dupRows.length > 0) {
    return NextResponse.json({ ok: true, alreadyApplied: true });
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

  // Resume (optional; required for speculative — it's what we match with —
  // and always required on recruiter pages)
  const file = form.get("resume");
  if ((speculative || recruiterId) && !(file instanceof File && file.size > 0)) {
    return NextResponse.json({ error: "A resume is required." }, { status: 400 });
  }
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

  // Tenant boards: roles come from that org's org_roles rows, shaped like
  // site roles so everything downstream is identical.
  const boardRoles: BoardRole[] | null = boardOrg ? await loadOrgRoles(boardOrg.id) : null;
  const roles = boardRoles ?? (await getRoles());
  const applied = roles.filter((r) => roleIds.includes(r.jobId));
  const roleTitles = applied.map((r) => `${r.title} (#${r.jobId})`);

  // Attribution only when the profile is real, published, and belongs to the
  // org being applied to — anything else is silently dropped, never a block.
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
      name,
      email,
      linkedin_url: linkedin,
      linkedin_username: linkedinUsername(linkedin),
      visa_status: visa || null,
      preferred_locations: preferredLocations,
      role_ids: applied.map((r) => r.jobId),
      role_titles: roleTitles,
      resume_path: resumePath,
      resume_text: null,
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

  if (!submission) {
    return NextResponse.json(
      { error: "Something went wrong saving your application. Please try again." },
      { status: 502 }
    );
  }

  // Everything slow (resume parsing, profile enrichment, screening, the
  // Airtable mirrors) happens AFTER the response — the applicant gets an
  // instant thank-you; nothing backend-shaped ever reaches them.
  after(async () => {
    await runApplicantPipeline({
      submissionId: submission.id,
      name,
      email,
      linkedin,
      visa,
      preferredLocations,
      roleIds,
      speculative,
      resumeBuf,
      resumeSafeName,
      resumePath,
      boardOrg,
      orgId,
      applicationType: roleIds.length ? "Applied" : "Speculative",
    });
  });
  return NextResponse.json({ ok: true, applicationId: submission.id });
}
