import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { applicantsForOrg, sourcedForOrg } from "@/lib/server/dashboard-candidates";

export const maxDuration = 60;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const { id } = await params;
  const [applicants, sourced] = await Promise.all([
    applicantsForOrg(member.org.id, id),
    sourcedForOrg(member.org.id, id),
  ]);
  return NextResponse.json({ applicants, sourced });
}
