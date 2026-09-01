import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { deleteTemplate, updateTemplate } from "@/lib/server/email-compose";

const ID_RE = /^[0-9a-f-]{36}$/i;

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const { id } = await ctx.params;
  if (!ID_RE.test(id)) return NextResponse.json({ error: "bad_id" }, { status: 400 });

  let body: { name?: unknown; subject?: unknown; bodyHtml?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const name = String(body.name || "").trim();
  if (!name) return NextResponse.json({ error: "bad_name" }, { status: 400 });

  const ok = await updateTemplate({
    orgId: member.org.id,
    id,
    name,
    subject: String(body.subject || ""),
    bodyHtml: String(body.bodyHtml || ""),
  });
  return ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "update_failed" }, { status: 400 });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const { id } = await ctx.params;
  if (!ID_RE.test(id)) return NextResponse.json({ error: "bad_id" }, { status: 400 });
  const ok = await deleteTemplate(member.org.id, id);
  return ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "delete_failed" }, { status: 400 });
}
