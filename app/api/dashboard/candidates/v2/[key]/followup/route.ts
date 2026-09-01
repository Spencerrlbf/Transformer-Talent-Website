import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { clearFollowUp, updateFollowUp, updateFollowUpDate } from "@/lib/server/candidates-unified";

// "Mark contacted": clears an open future-interest ask. The person stays in
// the pool; only the follow-up date comes off.
export async function POST(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const { key } = await ctx.params;
  if (!/^app_[0-9a-f-]{36}$/i.test(key))
    return NextResponse.json({ error: "bad_key" }, { status: 400 });

  const res = await clearFollowUp(member.org.id, key);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.error === "not_found" ? 404 : 500 });
  return NextResponse.json({ ok: true });
}

// Edit the ask: date + preferences, validated server-side, mirrored onto the
// candidate record exactly like a fresh submission.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const { key } = await ctx.params;
  if (!/^app_[0-9a-f-]{36}$/i.test(key))
    return NextResponse.json({ error: "bad_key" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }

  // dateOnly: reschedule without touching the preferences (updateFollowUp
  // is a full replace — a date-only body through it would wipe the ask).
  const res =
    body.dateOnly === true
      ? await updateFollowUpDate(member.org.id, key, body.at)
      : await updateFollowUp(member.org.id, key, body);
  if (!res.ok) {
    const status = res.error === "not_found" ? 404 : res.error === "save_failed" ? 500 : 400;
    return NextResponse.json({ error: res.error }, { status });
  }
  return NextResponse.json({ ok: true });
}
