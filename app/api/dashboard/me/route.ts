import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { loadProfile } from "@/lib/server/recruiter-profile";

export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const profile = await loadProfile(member.org.id, member.userId);
  return NextResponse.json({
    email: member.email,
    memberRole: member.memberRole,
    org: member.org,
    // Drives the "set up" nudge on the My page nav item.
    myPage: profile ? { published: profile.published, slug: profile.slug } : null,
  });
}
