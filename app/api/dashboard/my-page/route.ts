import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import {
  BOOKING_RE,
  EMAIL_RE,
  LINKEDIN_RE,
  SLUG_RE,
  loadProfile,
  profileView,
} from "@/lib/server/recruiter-profile";

// The signed-in user's recruiter page settings. GET returns the profile (or
// null plus a suggested slug), PUT upserts it. Publishing requires the page
// to be complete: name, slug, bio, and LinkedIn.

export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const [profile, orgRes] = await Promise.all([
    loadProfile(member.org.id, member.userId),
    sbRest(`organizations?id=eq.${member.org.id}&select=website,referral_amount`),
  ]);
  const [orgRow] = orgRes.ok
    ? ((await orgRes.json()) as { website: string | null; referral_amount: number | null }[])
    : [];

  const suggestedSlug = (member.email.split("@")[0] || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  // Page analytics: one RPC returns event counts, per-role engagement, and
  // the application/referral tallies. Null (not an error) when unavailable.
  let stats: unknown = null;
  if (profile) {
    try {
      const sres = await sbRest("rpc/recruiter_page_stats", {
        method: "POST",
        body: JSON.stringify({ profile: profile.id }),
      });
      if (sres.ok) stats = await sres.json();
    } catch {
      stats = null;
    }
  }

  return NextResponse.json({
    profile: profile ? profileView(profile) : null,
    stats,
    suggestedSlug,
    org: {
      website: orgRow?.website || "",
      referralAmount: orgRow?.referral_amount ?? 5000,
      canEditWebsite: member.memberRole === "owner",
    },
  });
}

export async function PUT(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  let body: {
    displayName?: string;
    slug?: string;
    linkedinUrl?: string;
    bio?: string;
    showAllRoles?: boolean;
    showReferral?: boolean;
    published?: boolean;
    bookingUrl?: string;
    contactEmail?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const displayName = String(body.displayName || "").trim().slice(0, 120);
  const slug = String(body.slug || "").trim().toLowerCase();
  const linkedinUrl = String(body.linkedinUrl || "").trim().slice(0, 300);
  const bio = String(body.bio || "").trim().slice(0, 1200);
  const showAllRoles = body.showAllRoles !== false;
  const showReferral = body.showReferral !== false;
  const published = body.published === true;
  const bookingUrl = String(body.bookingUrl || "").trim().slice(0, 500);
  const contactEmail = String(body.contactEmail || "").trim().toLowerCase().slice(0, 200);

  if (!SLUG_RE.test(slug))
    return NextResponse.json({ error: "bad_slug" }, { status: 400 });
  if (linkedinUrl && !LINKEDIN_RE.test(linkedinUrl))
    return NextResponse.json({ error: "bad_linkedin" }, { status: 400 });
  if (bookingUrl && !BOOKING_RE.test(bookingUrl))
    return NextResponse.json({ error: "bad_booking_url" }, { status: 400 });
  if (contactEmail && !EMAIL_RE.test(contactEmail))
    return NextResponse.json({ error: "bad_contact_email" }, { status: 400 });
  if (published && (!displayName || !bio || !linkedinUrl))
    return NextResponse.json({ error: "incomplete_for_publish" }, { status: 400 });

  const res = await sbRest("recruiter_profiles?on_conflict=organization_id,user_id", {
    method: "POST",
    body: JSON.stringify({
      organization_id: member.org.id,
      user_id: member.userId,
      slug,
      display_name: displayName,
      linkedin_url: linkedinUrl || null,
      bio,
      show_all_roles: showAllRoles,
      show_referral: showReferral,
      published,
      booking_url: bookingUrl || null,
      contact_email: contactEmail || null,
      updated_at: new Date().toISOString(),
    }),
    prefer: "resolution=merge-duplicates,return=representation",
  });
  if (res.status === 409)
    return NextResponse.json({ error: "slug_taken" }, { status: 409 });
  if (!res.ok) {
    // Postgres unique_violation on the slug surfaces as a 409 from PostgREST,
    // but some proxies rewrap it — check the body too.
    const text = await res.text();
    if (text.includes("recruiter_profiles_slug_key"))
      return NextResponse.json({ error: "slug_taken" }, { status: 409 });
    console.error("my-page upsert failed", res.status, text);
    return NextResponse.json({ error: "save_failed" }, { status: 502 });
  }

  const [row] = await res.json();
  return NextResponse.json({ profile: profileView(row) });
}
