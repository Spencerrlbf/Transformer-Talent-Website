import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { homeMetrics, type Period } from "@/lib/server/home-metrics";
import type { InboxScope } from "@/lib/server/inbox";

// The Home page's numbers. ?scope=me|team, ?period=week|month,
// ?today=YYYY-MM-DD and ?tz=<Date#getTimezoneOffset()> so day buckets and
// "today" follow the viewer's clock.
export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const url = new URL(req.url);
  const scope: InboxScope = url.searchParams.get("scope") === "team" ? "team" : "me";
  const period: Period = url.searchParams.get("period") === "month" ? "month" : "week";
  const today = url.searchParams.get("today");
  const tz = Number(url.searchParams.get("tz") || 0);
  const data = await homeMetrics(
    { orgId: member.org.id, email: member.email, userId: member.userId, memberRole: member.memberRole, orgSlug: member.org.slug },
    scope,
    period,
    today,
    Number.isFinite(tz) && Math.abs(tz) <= 14 * 60 ? tz : 0
  );
  return NextResponse.json(data);
}
