import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { clearFollowUp } from "@/lib/server/candidates-unified";

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
