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

  let body: { website?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const website = String(body.website || "").trim().slice(0, 300);
  if (website && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(website))
    return NextResponse.json({ error: "bad_website" }, { status: 400 });

  const res = await sbRest(`organizations?id=eq.${member.org.id}`, {
    method: "PATCH",
    body: JSON.stringify({ website: website || null }),
    prefer: "return=minimal",
  });
  if (!res.ok) return NextResponse.json({ error: "save_failed" }, { status: 502 });
  return NextResponse.json({ website });
}
