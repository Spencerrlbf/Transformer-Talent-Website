import { after, NextRequest, NextResponse } from "next/server";
import { allow } from "@/lib/server/ratelimit";
import { sbInsert, sbRest } from "@/lib/server/supabase";
import { linkedinUsername } from "@/lib/server/applicants";
import { getOrgId } from "@/lib/server/spine";
import { runApplicantPipeline } from "@/lib/server/applicant-pipeline";
import { sendReferralConfirmation } from "@/lib/server/email";
import { leadRecipients, sendLeadNotification } from "@/lib/server/lead-notify";

export const maxDuration = 60;

// Referrals from recruiter pages. The referred person becomes a real
// pipeline citizen: a website_applications row + the full enrichment and
// screening pipeline, tagged Referral, attributed to the recruiter page.
// People already in the system are recorded as status=duplicate (not
// eligible for the bounty) but the response NEVER reveals whether we knew
// them — that would leak who is in the network.

function clean(s: unknown, max: number): string {
  return String(s ?? "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .trim()
    .slice(0, max);
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (clean(body.website, 50)) return NextResponse.json({ ok: true });

  const recruiterId = clean(body.recruiter, 40);
  const referrerName = clean(body.referrerName, 120);
  const referrerEmail = clean(body.referrerEmail, 254).toLowerCase();
  const candidateLinkedin = clean(body.candidateLinkedin, 300);
  const candidateEmail = clean(body.candidateEmail, 254).toLowerCase();

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!/^[0-9a-f-]{36}$/.test(recruiterId))
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  if (!referrerName || !emailRe.test(referrerEmail))
    return NextResponse.json(
      { error: "Please provide your name and a valid email." },
      { status: 400 }
    );
  const username = linkedinUsername(candidateLinkedin);
  if (!candidateLinkedin || !username)
    return NextResponse.json(
      { error: "Please provide their LinkedIn profile URL (linkedin.com/in/…)." },
      { status: 400 }
    );
  if (!emailRe.test(candidateEmail))
    return NextResponse.json(
      { error: "Please provide a valid email for them." },
      { status: 400 }
    );

  // The page must be real, published, and offering referrals.
  const pres = await sbRest(
    `recruiter_profiles?id=eq.${recruiterId}&published=is.true&show_referral=is.true&select=id,organization_id`
  );
  const [profile] = pres.ok
    ? ((await pres.json()) as { id: string; organization_id: string }[])
    : [];
  if (!profile) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const orgId = profile.organization_id;

  const ip =
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown";
  if (
    !(await allow(`referral:email:${referrerEmail}`, 5, 24)) ||
    !(await allow(`referral:ip:${ip}`, 10, 24)) ||
    !(await allow("referral:global", 100, 24))
  ) {
    return NextResponse.json(
      { error: "Too many referrals today — email spencer@transformertalent.com directly." },
      { status: 429 }
    );
  }

  const [orgRes, ttOrgId] = await Promise.all([
    sbRest(`organizations?id=eq.${orgId}&select=referral_amount`),
    getOrgId(),
  ]);
  const [orgRow] = orgRes.ok
    ? ((await orgRes.json()) as { referral_amount: number }[])
    : [];
  const amount = orgRow?.referral_amount ?? 5000;

  // Already in the system? Org's applications (any time), and for the TT org
  // also the global candidate pool. Recorded, not rejected — and never
  // revealed to the referrer.
  const checks = await Promise.all([
    sbRest(
      `website_applications?organization_id=eq.${orgId}&email=eq.${encodeURIComponent(candidateEmail)}&select=id&limit=1`
    ),
    sbRest(
      `website_applications?organization_id=eq.${orgId}&linkedin_username=eq.${encodeURIComponent(username)}&select=id&limit=1`
    ),
    ...(orgId === ttOrgId
      ? [
          sbRest(`candidates?email=eq.${encodeURIComponent(candidateEmail)}&select=id&limit=1`),
          sbRest(`candidates?linkedin_username=eq.${encodeURIComponent(username)}&select=id&limit=1`),
        ]
      : []),
  ]);
  let known = false;
  for (const res of checks) {
    if (res.ok && ((await res.json()) as unknown[]).length > 0) known = true;
  }

  if (known) {
    await sbInsert("referrals", {
      organization_id: orgId,
      recruiter_profile_id: profile.id,
      referrer_name: referrerName,
      referrer_email: referrerEmail,
      candidate_linkedin: candidateLinkedin,
      candidate_linkedin_username: username,
      candidate_email: candidateEmail,
      amount,
      status: "duplicate",
    }).catch((e) => console.error("duplicate referral insert failed", e));
    // Identical confirmation as the fresh path — the referrer must never be
    // able to tell we already knew the person.
    after(async () => {
      await sendReferralConfirmation({
        to: referrerEmail,
        referrerName,
        candidateLinkedin,
        amount,
      });
    });
    return NextResponse.json({ ok: true });
  }

  // Real referral: application row + the shared pipeline (name resolved from
  // the Harvest profile once enrichment runs).
  const submission = await sbInsert<{ id: string }>(
    "website_applications",
    {
      organization_id: orgId,
      recruiter_profile_id: profile.id,
      name: "",
      email: candidateEmail,
      linkedin_url: candidateLinkedin,
      linkedin_username: username,
      preferred_locations: [],
      role_ids: [],
      role_titles: [],
      resume_path: null,
      resume_text: null,
      status: "processing",
      source: `referral: by ${referrerName} <${referrerEmail}>`,
      ip: ip === "unknown" ? null : ip,
      user_agent: clean(req.headers.get("user-agent"), 500),
    },
    true
  ).catch((e) => {
    console.error("referral application insert failed", e);
    return null;
  });
  if (!submission) {
    return NextResponse.json(
      { error: "Something went wrong saving the referral. Please try again." },
      { status: 502 }
    );
  }

  await sbInsert("referrals", {
    organization_id: orgId,
    recruiter_profile_id: profile.id,
    referrer_name: referrerName,
    referrer_email: referrerEmail,
    candidate_linkedin: candidateLinkedin,
    candidate_linkedin_username: username,
    candidate_email: candidateEmail,
    amount,
    status: "new",
    application_id: submission.id,
  }).catch((e) => console.error("referral insert failed", e));

  const boardOrg =
    orgId === ttOrgId
      ? null
      : await (async () => {
          const r = await sbRest(`organizations?id=eq.${orgId}&select=id,slug,name`);
          const [o] = r.ok
            ? ((await r.json()) as { id: string; slug: string; name: string }[])
            : [];
          return o ?? null;
        })();

  after(async () => {
    await sendReferralConfirmation({
      to: referrerEmail,
      referrerName,
      candidateLinkedin,
      amount,
    });
    await runApplicantPipeline({
      submissionId: submission.id,
      name: "",
      email: candidateEmail,
      linkedin: candidateLinkedin,
      visa: "",
      preferredLocations: [],
      roleIds: [],
      speculative: false,
      resumeBuf: null,
      resumeSafeName: "resume.pdf",
      resumePath: null,
      boardOrg,
      orgId,
      applicationType: "Referral",
    });
    // Tell the page's recruiter, referrer included. After the pipeline so
    // the candidate's name is resolved from their profile.
    try {
      const nres = await sbRest(`website_applications?id=eq.${submission.id}&select=name`);
      const [nrow] = nres.ok ? ((await nres.json()) as { name: string }[]) : [];
      const to = await leadRecipients({ recruiterProfileId: profile.id, orgId });
      await sendLeadNotification({
        to,
        kind: "referral",
        name: nrow?.name || "",
        email: candidateEmail,
        linkedin: candidateLinkedin,
        roleTitles: [],
        referrerName,
        referrerEmail,
        viaPage: true,
      });
    } catch (err) {
      console.error("referral lead notification failed", err);
    }
  });

  return NextResponse.json({ ok: true });
}
