import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { createTemplate, listTemplates } from "@/lib/server/email-compose";
import { ensureDefaultTemplates, resolveButtons } from "@/lib/server/quick-actions";

// The org's templates, plus which one each quick-action button sends.
export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  await ensureDefaultTemplates(member.org.id, member.email).catch(() => {});
  const templates = await listTemplates(member.org.id);
  const buttons = await resolveButtons(member.org.id, templates);
  return NextResponse.json({ templates, buttons, canMap: member.memberRole === "owner" });
}

export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  let body: { name?: unknown; subject?: unknown; bodyHtml?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const res = await createTemplate({
    orgId: member.org.id,
    name: String(body.name || ""),
    subject: String(body.subject || ""),
    bodyHtml: String(body.bodyHtml || ""),
    byEmail: member.email,
  });
  if ("error" in res) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, template: res });
}
