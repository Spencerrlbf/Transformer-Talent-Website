import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { applicantsForOrg, sourcedForOrg } from "@/lib/server/dashboard-candidates";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const [applicants, sourced] = await Promise.all([
    applicantsForOrg(member.org.id),
    sourcedForOrg(member.org.id),
  ]);
  return NextResponse.json({ applicants, sourced });
}
