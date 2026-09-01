import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { addMembers, removeMembers, resolveList } from "@/lib/server/lists";

// Bulk membership. `id` may be a list uuid or the alias "shortlist", so the
// star toggle never has to look the built-in list up first.
function keysFrom(body: { keys?: unknown }): string[] {
  return Array.isArray(body.keys) ? body.keys.filter((k) => typeof k === "string") : [];
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const { id } = await ctx.params;
  const list = await resolveList(member.org.id, id);
  if (!list) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { keys?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const keys = keysFrom(body);
  if (!keys.length) return NextResponse.json({ error: "no_keys" }, { status: 400 });

  const count = await addMembers(member.org.id, list.id, keys, {
    id: member.userId,
    email: member.email,
  });
  return NextResponse.json({ ok: true, count });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const { id } = await ctx.params;
  const list = await resolveList(member.org.id, id);
  if (!list) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { keys?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const keys = keysFrom(body);
  if (!keys.length) return NextResponse.json({ error: "no_keys" }, { status: 400 });

  const ok = await removeMembers(member.org.id, list.id, keys);
  return ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "save_failed" }, { status: 500 });
}
