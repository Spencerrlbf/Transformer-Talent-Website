import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { inboxCounts, listInbox, type InboxScope } from "@/lib/server/inbox";

// The Inbox page's data. ?scope=me|team, ?today=YYYY-MM-DD (the viewer's
// local date — the server can't know their timezone), ?count=1 for the
// nav badge only.
export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const url = new URL(req.url);
  const scope: InboxScope = url.searchParams.get("scope") === "team" ? "team" : "me";
  const today = url.searchParams.get("today");
  const m = { orgId: member.org.id, email: member.email, userId: member.userId, memberRole: member.memberRole };
  if (url.searchParams.get("count")) {
    return NextResponse.json(await inboxCounts(m, scope, today));
  }
  return NextResponse.json(await listInbox(m, scope, today));
}
