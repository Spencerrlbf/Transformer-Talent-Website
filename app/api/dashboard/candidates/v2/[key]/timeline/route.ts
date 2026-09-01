import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { addNote, candidateTimeline } from "@/lib/server/tasks";

const KEY_RE = /^(app|src)_[0-9a-f-]{36}$/i;

// The drawer's Notes tab: notes + this candidate's tasks + their own
// follow-up ask, merged client-side into one timeline.
export async function GET(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const { key } = await ctx.params;
  if (!KEY_RE.test(key)) return NextResponse.json({ error: "bad_key" }, { status: 400 });

  const data = await candidateTimeline(member.org.id, key);
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const { key } = await ctx.params;
  if (!KEY_RE.test(key)) return NextResponse.json({ error: "bad_key" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }

  const res = await addNote({
    orgId: member.org.id,
    candidateKey: key,
    kind: String(body.kind || "note"),
    body: String(body.body || ""),
    userId: member.userId,
    userEmail: member.email,
  });
  if ("error" in res) {
    return NextResponse.json({ error: res.error }, { status: res.error === "not_found" ? 404 : 400 });
  }
  return NextResponse.json({ ok: true, note: res });
}
