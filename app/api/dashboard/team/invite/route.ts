import { NextRequest, NextResponse } from "next/server";
import { sbRest, sbInsert } from "@/lib/server/supabase";
import { EMAIL_RE } from "@/lib/server/recruiter-profile";
import { sendTeamInvite } from "@/lib/server/email";
import { loadMembers, mintSignInLink, requireAdmin } from "@/lib/server/team";

export const maxDuration = 30;

// Invite by email: seat check, create the auth user if needed, add the
// membership as Recruiter, send the branded sign-in link.
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { email?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
  if (!EMAIL_RE.test(email))
    return NextResponse.json({ error: "bad_email" }, { status: 400 });

  const [members, ores] = await Promise.all([
    loadMembers(admin.org.id),
    sbRest(`organizations?id=eq.${admin.org.id}&select=seat_limit`),
  ]);
  if (members.some((m) => m.email.toLowerCase() === email))
    return NextResponse.json({ error: "already_member" }, { status: 409 });
  const [orgRow] = ores.ok ? ((await ores.json()) as { seat_limit: number | null }[]) : [];
  if (orgRow?.seat_limit != null && members.length >= orgRow.seat_limit)
    return NextResponse.json({ error: "no_seats" }, { status: 409 });

  const link = await mintSignInLink(email);
  if (!link) return NextResponse.json({ error: "invite_failed" }, { status: 502 });

  try {
    await sbInsert("org_members", {
      organization_id: admin.org.id,
      user_id: link.userId,
      email,
      member_role: "member",
      invited_at: new Date().toISOString(),
      invited_by: admin.userId,
    });
  } catch (err) {
    // A unique-violation means they're already in an org (possibly this one
    // under a different email casing) — surface it rather than emailing.
    const check = await sbRest(`org_members?user_id=eq.${link.userId}&select=id&limit=1`);
    if (check.ok && ((await check.json()) as unknown[]).length > 0)
      return NextResponse.json({ error: "already_member" }, { status: 409 });
    console.error("invite insert failed", err);
    return NextResponse.json({ error: "invite_failed" }, { status: 502 });
  }

  const sent = await sendTeamInvite({
    to: email,
    orgName: admin.org.name,
    inviterEmail: admin.email,
    actionLink: link.actionLink,
  });
  if (!sent) return NextResponse.json({ error: "email_failed" }, { status: 502 });

  return NextResponse.json({ ok: true });
}
