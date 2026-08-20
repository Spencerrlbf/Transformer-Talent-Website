import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { listNetworkMatches, TT_ORG_SLUG } from "@/lib/server/network";

export const maxDuration = 60;

// Internal-only: the nightly pool matches, person-first. Any org other than
// Transformer Talent gets a 404 — the surface does not exist for clients.
export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  if (member.org.slug !== TT_ORG_SLUG)
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  const jobId = req.nextUrl.searchParams.get("job") || undefined;
  const list = await listNetworkMatches(member.org.id, jobId);
  return NextResponse.json(list);
}
