import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { deleteTask, updateTask } from "@/lib/server/tasks";

const ID_RE = /^[0-9a-f-]{36}$/i;

// Edit one task: reschedule (dueDate/dueTime), retitle, retype, or flip
// status (done sets completed_at; open clears it).
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

  const res = await updateTask(member.org.id, id, {
    ...(body.title !== undefined ? { title: String(body.title) } : {}),
    ...(body.kind !== undefined ? { kind: String(body.kind) } : {}),
    ...(body.dueDate !== undefined ? { dueDate: String(body.dueDate) } : {}),
    ...(body.dueTime !== undefined ? { dueTime: body.dueTime ? String(body.dueTime) : null } : {}),
    ...(body.status !== undefined ? { status: String(body.status) } : {}),
    ...(body.endedReason !== undefined ? { endedReason: String(body.endedReason) } : {}),
  });
  if ("error" in res) {
    return NextResponse.json({ error: res.error }, { status: res.error === "not_found" ? 404 : 400 });
  }
  return NextResponse.json({ ok: true, task: res });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const { id } = await ctx.params;
  if (!ID_RE.test(id)) return NextResponse.json({ error: "bad_id" }, { status: 400 });

  const ok = await deleteTask(member.org.id, id);
  return ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "delete_failed" }, { status: 500 });
}
