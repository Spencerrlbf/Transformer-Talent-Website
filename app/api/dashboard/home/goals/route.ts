import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { clearTargets, loadTargets, saveTargets } from "@/lib/server/goals";

// Weekly targets. GET: this seat's own targets (null = using the org
// default) and the org default. PATCH: {targets} sets this seat's own,
// {useDefaults: true} drops them, {defaults} sets the org default (owner).
export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const t = await loadTargets(member.org.id);
  return NextResponse.json({
    mine: t.bySeat.get(member.email) || null,
    defaults: t.defaults,
    canEditDefaults: member.memberRole === "owner",
  });
}

export async function PATCH(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  let body: { targets?: unknown; useDefaults?: unknown; defaults?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  if (body.useDefaults === true) {
    const ok = await clearTargets(member.org.id, member.email);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "save_failed" }, { status: 502 });
  }
  if (body.defaults && typeof body.defaults === "object") {
    if (member.memberRole !== "owner") return NextResponse.json({ error: "owner_only" }, { status: 403 });
    const saved = await saveTargets(member.org.id, "", body.defaults);
    return saved ? NextResponse.json({ ok: true, defaults: saved }) : NextResponse.json({ error: "save_failed" }, { status: 502 });
  }
  if (body.targets && typeof body.targets === "object") {
    const saved = await saveTargets(member.org.id, member.email, body.targets);
    return saved ? NextResponse.json({ ok: true, targets: saved }) : NextResponse.json({ error: "save_failed" }, { status: 502 });
  }
  return NextResponse.json({ error: "nothing_to_save" }, { status: 400 });
}
