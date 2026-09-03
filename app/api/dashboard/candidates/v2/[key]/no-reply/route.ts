import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { candidateContact } from "@/lib/server/email-compose";
import { markNoReply } from "@/lib/server/no-reply";
import { noteNoReply, noteStageMoved } from "@/lib/server/inbox";

const KEY_RE = /^(app|src)_[0-9a-f-]{36}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// "No reply": stop chasing this person. Never sends anything. Body:
// { threadId?, jobId?, subject?, checkBack?: "YYYY-MM-DD" | null }.
export async function POST(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const { key } = await ctx.params;
  if (!KEY_RE.test(key)) return NextResponse.json({ error: "bad_key" }, { status: 400 });

  let body: { threadId?: unknown; jobId?: unknown; subject?: unknown; checkBack?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const checkBack = typeof body.checkBack === "string" && DATE_RE.test(body.checkBack) ? body.checkBack : null;
  if (body.checkBack && !checkBack) return NextResponse.json({ error: "bad_date" }, { status: 400 });

  const contact = await candidateContact(member.org.id, key);
  if (!contact) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const jobId = typeof body.jobId === "string" && body.jobId ? body.jobId.slice(0, 64) : null;
  const res = await markNoReply({
    orgId: member.org.id,
    memberEmail: member.email,
    userId: member.userId,
    candidateKey: key,
    candidateName: contact.name || "",
    threadId: typeof body.threadId === "string" && body.threadId ? body.threadId.slice(0, 300) : null,
    jobId,
    subject: typeof body.subject === "string" ? body.subject.slice(0, 300) : null,
    checkBack,
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.error === "save_failed" ? 502 : 400 });
  // The conversation and the person's arrival are dealt with by this too.
  const threadId = typeof body.threadId === "string" && body.threadId ? body.threadId.slice(0, 300) : null;
  await noteNoReply(member.org.id, member.email, key, threadId, typeof body.subject === "string" ? body.subject : null).catch(() => {});
  if (res.staged && jobId) await noteStageMoved(member.org.id, member.email, key, "No reply", jobId).catch(() => {});
  return NextResponse.json({ ok: true, staged: res.staged, checkBack });
}
