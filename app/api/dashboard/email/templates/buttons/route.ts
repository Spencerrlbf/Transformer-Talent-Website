import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { restoreAllDefaults, restoreDefault, setButtonTemplate } from "@/lib/server/quick-actions";
import { buttonByKey } from "@/lib/quick-buttons";

const ID_RE = /^[0-9a-f-]{36}$/i;

// Owner-only: which template a quick-action button sends.
//   {button, templateId}   point the button at a template
//   {button, reset: true}  back to the stock wording for that button
//   {restore: button}      bring the button's deleted stock template back
//   {restoreAll: true}     bring every missing stock template back
export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  if (member.memberRole !== "owner") return NextResponse.json({ error: "owner_only" }, { status: 403 });

  let body: { button?: unknown; templateId?: unknown; reset?: unknown; restore?: unknown; restoreAll?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }

  if (body.restoreAll === true) {
    const n = await restoreAllDefaults(member.org.id, member.email);
    return NextResponse.json({ ok: true, restored: n });
  }
  if (typeof body.restore === "string") {
    const b = buttonByKey(body.restore);
    if (!b) return NextResponse.json({ error: "bad_button" }, { status: 400 });
    const t = await restoreDefault(member.org.id, member.email, b.defaultKey);
    if (!t) return NextResponse.json({ error: "restore_failed" }, { status: 502 });
    // The button goes back to the stock copy, whatever it pointed at before.
    await setButtonTemplate(member.org.id, member.email, b.key, null);
    return NextResponse.json({ ok: true, template: t });
  }
  const button = String(body.button || "");
  if (!buttonByKey(button)) return NextResponse.json({ error: "bad_button" }, { status: 400 });
  if (body.reset === true) {
    const ok = await setButtonTemplate(member.org.id, member.email, button, null);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "save_failed" }, { status: 502 });
  }
  const templateId = String(body.templateId || "");
  if (!ID_RE.test(templateId)) return NextResponse.json({ error: "bad_template" }, { status: 400 });
  const ok = await setButtonTemplate(member.org.id, member.email, button, templateId);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "save_failed" }, { status: 400 });
}
