import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { createTask, listTasks } from "@/lib/server/tasks";

// Tasks page data: open tasks, recent done, and candidate-requested
// follow-ups folded in as request rows (completed via the followup endpoint,
// not here).
export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  return NextResponse.json(await listTasks(member.org.id));
}

export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }

  const res = await createTask({
    orgId: member.org.id,
    candidateKey: String(body.candidateKey || ""),
    candidateName: String(body.candidateName || ""),
    kind: String(body.kind || "task"),
    title: String(body.title || ""),
    dueDate: String(body.dueDate || ""),
    dueTime: body.dueTime ? String(body.dueTime) : null,
    userId: member.userId,
    userEmail: member.email,
  });
  if ("error" in res) {
    return NextResponse.json({ error: res.error }, { status: res.error === "not_found" ? 404 : 400 });
  }
  return NextResponse.json({ ok: true, task: res });
}
