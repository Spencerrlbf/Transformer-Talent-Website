import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { accountFor, listThreadsFor } from "@/lib/server/email-compose";
import { openReminders } from "@/lib/server/reminders";
import { noReplyMarkFor } from "@/lib/server/no-reply-marks";

const KEY_RE = /^(app|src)_[0-9a-f-]{36}$/i;

// The Email tab's data: this candidate's conversations (grouped by provider
// thread) as this viewer may see them, plus the seat's sending state.
// ?summary=1 returns just the counts for the drawer's tab badge. Under the
// org's "private" setting a teammate's threads are absent here — only their
// count is reported, so the tab can say they exist.
export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const url = new URL(req.url);
  const key = url.searchParams.get("key") || "";
  if (!KEY_RE.test(key)) return NextResponse.json({ error: "bad_key" }, { status: 400 });

  const { threads, hiddenThreads, visibility } = await listThreadsFor(member.org.id, key, member.email);
  const awaiting = threads.filter((t) => t.awaiting).length;
  if (url.searchParams.get("summary")) {
    return NextResponse.json({ awaiting, total: threads.length, hiddenThreads });
  }
  const [account, reminders, noReply] = await Promise.all([
    accountFor(member.org.id, member.email),
    openReminders(member.org.id, key, member.email).catch(() => []),
    noReplyMarkFor(member.org.id, key).catch(() => null),
  ]);
  return NextResponse.json({
    connected: Boolean(account),
    address: account?.address || "",
    awaiting,
    threads,
    hiddenThreads,
    visibility,
    reminders,
    noReply,
  });
}
