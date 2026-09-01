import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { createList, listLists } from "@/lib/server/lists";

// Candidate lists: enumerate (with counts; the built-in Shortlist is seeded
// on first touch) and create. Creating an existing name returns that list.
export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  return NextResponse.json({ lists: await listLists(member.org.id) });
}

export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  let body: { name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const res = await createList(member.org.id, String(body.name || ""), {
    id: member.userId,
    email: member.email,
  });
  if ("error" in res) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, list: res });
}
