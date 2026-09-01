import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { addAttachments } from "@/lib/server/lists";

// "Add to a job": manually attach candidates to one of the org's roles.
// They join that job's pipeline at stage New with an Added badge; no AI
// verdict is invented for them.
export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  let body: { jobId?: unknown; keys?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const keys = Array.isArray(body.keys) ? body.keys.filter((k) => typeof k === "string") : [];
  if (!keys.length) return NextResponse.json({ error: "no_keys" }, { status: 400 });

  const res = await addAttachments(member.org.id, String(body.jobId || ""), keys as string[], {
    id: member.userId,
    email: member.email,
  });
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: res.error === "not_found" ? 404 : 400 });
  }
  return NextResponse.json({ ok: true, count: res.count });
}
