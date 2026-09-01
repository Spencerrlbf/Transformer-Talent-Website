import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { deleteNote, updateNote } from "@/lib/server/tasks";

const ID_RE = /^[0-9a-f-]{36}$/i;

// Edit or delete one note. Author-only: the queries match on the member's
// own email, so someone else's note is simply not found.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const { id } = await ctx.params;
  if (!ID_RE.test(id)) return NextResponse.json({ error: "bad_id" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }

  const res = await updateNote(member.org.id, id, member.email, {
    ...(body.kind !== undefined ? { kind: String(body.kind) } : {}),
    ...(body.body !== undefined ? { body: String(body.body) } : {}),
  });
  if ("error" in res) {
    return NextResponse.json({ error: res.error }, { status: res.error === "not_found" ? 404 : 400 });
  }
  return NextResponse.json({ ok: true, note: res });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const { id } = await ctx.params;
  if (!ID_RE.test(id)) return NextResponse.json({ error: "bad_id" }, { status: 400 });

  const ok = await deleteNote(member.org.id, id, member.email);
  return ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "not_found" }, { status: 404 });
}
