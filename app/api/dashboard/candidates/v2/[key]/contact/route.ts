import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { saveUnifiedContact } from "@/lib/server/candidates-unified";

export const maxDuration = 30;

// Save client-edited contact details (email / phone / github) for a person.
export async function PUT(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const { key } = await ctx.params;
  if (!/^(app|src)_[0-9a-f-]{36}$/i.test(key))
    return NextResponse.json({ error: "bad_key" }, { status: 400 });

  let body: { email?: string; phone?: string; github?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const result = await saveUnifiedContact(member.org.id, key, {
    email: body.email ?? null,
    phone: body.phone ?? null,
    github: body.github ?? null,
  });
  if (result.error)
    return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 400 });
  return NextResponse.json({ contact: result.contact });
}
