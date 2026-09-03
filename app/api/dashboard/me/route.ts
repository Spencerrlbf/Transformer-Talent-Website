import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { loadProfile } from "@/lib/server/recruiter-profile";
import { sbRest } from "@/lib/server/supabase";
import { REMIND_DAYS } from "@/lib/reminders";

/** The seat's "remind me if no reply" default (0 = off). */
async function seatReminderDays(orgId: string, userId: string): Promise<number> {
  const res = await sbRest(`org_members?organization_id=eq.${orgId}&user_id=eq.${userId}&select=reply_reminder_days&limit=1`);
  const [row] = res.ok ? ((await res.json()) as { reply_reminder_days: number | null }[]) : [];
  return typeof row?.reply_reminder_days === "number" ? row.reply_reminder_days : 3;
}

export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const [profile, reminderDays] = await Promise.all([
    loadProfile(member.org.id, member.userId),
    seatReminderDays(member.org.id, member.userId).catch(() => 3),
  ]);
  return NextResponse.json({
    email: member.email,
    memberRole: member.memberRole,
    org: member.org,
    // Drives the "set up" nudge on the My page nav item.
    myPage: profile ? { published: profile.published, slug: profile.slug, displayName: profile.display_name } : null,
    reminderDays,
  });
}

// Per-seat preferences. Today: the reply-reminder default.
export async function PATCH(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  let body: { reminderDays?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const days = body.reminderDays;
  if (typeof days !== "number" || !(days === 0 || (REMIND_DAYS as readonly number[]).includes(days))) {
    return NextResponse.json({ error: "bad_days" }, { status: 400 });
  }
  const res = await sbRest(`org_members?organization_id=eq.${member.org.id}&user_id=eq.${member.userId}`, {
    method: "PATCH",
    body: JSON.stringify({ reply_reminder_days: days }),
    prefer: "return=minimal",
  });
  if (!res.ok) return NextResponse.json({ error: "save_failed" }, { status: 500 });
  return NextResponse.json({ ok: true, reminderDays: days });
}
