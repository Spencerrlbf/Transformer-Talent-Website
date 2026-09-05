import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { restoreAllDefaults, restoreDefault } from "@/lib/server/quick-actions";
import { buttonByKey } from "@/lib/quick-buttons";

// Owner-only: bring back stock wording that was deleted. A quick action finds
// its template by a fixed key, so a deleted default leaves the button with
// nothing to send until one of these puts it back.
//   {restore: "<button key>"}  the wording that button needs
//   {restoreAll: true}         every stock template that is missing
export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  if (member.memberRole !== "owner") return NextResponse.json({ error: "owner_only" }, { status: 403 });

  let body: { restore?: unknown; restoreAll?: unknown };
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
    return t ? NextResponse.json({ ok: true, template: t }) : NextResponse.json({ error: "restore_failed" }, { status: 502 });
  }
  return NextResponse.json({ error: "nothing_to_do" }, { status: 400 });
}
