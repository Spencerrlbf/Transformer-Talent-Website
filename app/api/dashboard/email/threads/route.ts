import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { accountFor, listThreads } from "@/lib/server/email-compose";

const KEY_RE = /^(app|src)_[0-9a-f-]{36}$/i;

// The Email tab's data: this candidate's conversations (grouped by provider
// thread) plus the seat's sending state. ?summary=1 returns just the counts
// for the drawer's tab badge.
export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const url = new URL(req.url);
  const key = url.searchParams.get("key") || "";
  if (!KEY_RE.test(key)) return NextResponse.json({ error: "bad_key" }, { status: 400 });

  const threads = await listThreads(member.org.id, key);
  const awaiting = threads.filter((t) => t.awaiting).length;
  if (url.searchParams.get("summary")) {
    return NextResponse.json({ awaiting, total: threads.length });
  }
  const account = await accountFor(member.org.id, member.email);
  return NextResponse.json({
    connected: Boolean(account),
    address: account?.address || "",
    awaiting,
    threads,
  });
}
