import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { deleteList, renameList, resolveList } from "@/lib/server/lists";

// Rename / delete one list. The built-in Shortlist accepts neither.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const { id } = await ctx.params;
  const list = await resolveList(member.org.id, id);
  if (!list) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (list.builtin) return NextResponse.json({ error: "builtin" }, { status: 400 });

  let body: { name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const res = await renameList(member.org.id, list.id, String(body.name || ""));
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: res.error === "not_found" ? 404 : 400 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const { id } = await ctx.params;
  const list = await resolveList(member.org.id, id);
  if (!list) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (list.builtin) return NextResponse.json({ error: "builtin" }, { status: 400 });

  const ok = await deleteList(member.org.id, list.id);
  return ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "delete_failed" }, { status: 500 });
}
