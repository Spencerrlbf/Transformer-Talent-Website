import { NextRequest, NextResponse } from "next/server";
import { sendTeamInvite } from "@/lib/server/email";
import { loadMembers, mintSignInLink, requireAdmin } from "@/lib/server/team";

export const maxDuration = 30;

// Re-send an invitation: mint a fresh sign-in link for an existing member
// and email it again. Works for pending and active members alike (links
// expire; people lose emails).
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { userId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const userId = String(body.userId || "");
  const members = await loadMembers(admin.org.id);
  const target = members.find((m) => m.user_id === userId);
  if (!target) return NextResponse.json({ error: "not_a_member" }, { status: 404 });

  const link = await mintSignInLink(target.email);
  if (!link) return NextResponse.json({ error: "resend_failed" }, { status: 502 });

  const sent = await sendTeamInvite({
    to: target.email,
    orgName: admin.org.name,
    inviterEmail: admin.email,
    actionLink: link.actionLink,
  });
  if (!sent) return NextResponse.json({ error: "email_failed" }, { status: 502 });

  return NextResponse.json({ ok: true });
}
