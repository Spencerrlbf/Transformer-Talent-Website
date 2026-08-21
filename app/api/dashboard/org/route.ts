import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";

// Org-level settings. Owner-only: today just the company website, shown on
// recruiter pages and (later) the public company page.
export async function PATCH(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  if (member.memberRole !== "owner")
    return NextResponse.json({ error: "owner_only" }, { status: 403 });

  let body: { website?: string; referralAmount?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if ("website" in body) {
    const website = String(body.website || "").trim().slice(0, 300);
    if (website && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(website))
      return NextResponse.json({ error: "bad_website" }, { status: 400 });
    patch.website = website || null;
  }
  if ("referralAmount" in body) {
    const amount = Math.round(Number(body.referralAmount));
    if (!Number.isFinite(amount) || amount < 0 || amount > 1000000)
      return NextResponse.json({ error: "bad_amount" }, { status: 400 });
    patch.referral_amount = amount;
  }
  if (Object.keys(patch).length === 0)
    return NextResponse.json({ error: "nothing_to_save" }, { status: 400 });

  const res = await sbRest(`organizations?id=eq.${member.org.id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
    prefer: "return=minimal",
  });
  if (!res.ok) return NextResponse.json({ error: "save_failed" }, { status: 502 });
  return NextResponse.json({ ok: true });
}
