import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { snoozeAttention } from "@/lib/server/goals";
import { addDays } from "@/lib/reminders";

// Snooze one Needs-attention row for this seat: {key, today} → hidden for
// seven days. The row comes back by itself after that if it still qualifies.
export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  let body: { key?: unknown; today?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const today = typeof body.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.today) ? body.today : new Date().toISOString().slice(0, 10);
  const until = addDays(today, 7);
  const ok = await snoozeAttention(member.org.id, member.email, String(body.key || ""), until);
  if (!ok) return NextResponse.json({ error: "bad_key" }, { status: 400 });
  return NextResponse.json({ ok: true, until });
}
