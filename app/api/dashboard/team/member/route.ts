import { NextRequest, NextResponse } from "next/server";
import { sbRest } from "@/lib/server/supabase";
import { loadMembers, requireAdmin } from "@/lib/server/team";

export const maxDuration = 30;

// Role changes and removals. Guards: never your own row, and an org can
// never end up without an admin.

export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { userId?: unknown; role?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const userId = String(body.userId || "");
  const role = body.role === "admin" ? "owner" : body.role === "recruiter" ? "member" : null;
  if (!role) return NextResponse.json({ error: "bad_role" }, { status: 400 });
  if (userId === admin.userId)
    return NextResponse.json({ error: "cannot_change_self" }, { status: 400 });

  const members = await loadMembers(admin.org.id);
  const target = members.find((m) => m.user_id === userId);
  if (!target) return NextResponse.json({ error: "not_a_member" }, { status: 404 });
  const admins = members.filter((m) => m.member_role === "owner");
  if (target.member_role === "owner" && role === "member" && admins.length <= 1)
    return NextResponse.json({ error: "last_admin" }, { status: 400 });

  const up = await sbRest(`org_members?id=eq.${target.id}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({ member_role: role }),
  });
  if (!up.ok) return NextResponse.json({ error: "update_failed" }, { status: 502 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const userId = String(new URL(req.url).searchParams.get("userId") || "");
  if (userId === admin.userId)
    return NextResponse.json({ error: "cannot_remove_self" }, { status: 400 });

  const members = await loadMembers(admin.org.id);
  const target = members.find((m) => m.user_id === userId);
  if (!target) return NextResponse.json({ error: "not_a_member" }, { status: 404 });
  const admins = members.filter((m) => m.member_role === "owner");
  if (target.member_role === "owner" && admins.length <= 1)
    return NextResponse.json({ error: "last_admin" }, { status: 400 });

  // Their page comes down immediately (it carries the org's brand), but the
  // profile row — and every candidate, application, and stat they produced —
  // stays with the organization.
  await sbRest(
    `recruiter_profiles?organization_id=eq.${admin.org.id}&user_id=eq.${userId}`,
    {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({ published: false, updated_at: new Date().toISOString() }),
    }
  ).catch(() => {});

  const del = await sbRest(`org_members?id=eq.${target.id}`, {
    method: "DELETE",
    prefer: "return=minimal",
  });
  if (!del.ok) return NextResponse.json({ error: "remove_failed" }, { status: 502 });
  return NextResponse.json({ ok: true });
}
