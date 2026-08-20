import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { saveUnifiedContact } from "@/lib/server/candidates-unified";
import { TT_ORG_SLUG } from "@/lib/server/network";

export const maxDuration = 30;

// Save client-edited contact details (email / phone / github) for a person.
export async function PUT(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const { key } = await ctx.params;
  if (!/^(app|src|net)_[0-9a-f-]{36}$/i.test(key))
    return NextResponse.json({ error: "bad_key" }, { status: 400 });
  // Pool people are TT-internal — no other org may touch them.
  if (key.startsWith("net_") && member.org.slug !== TT_ORG_SLUG)
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { email?: string; phone?: string; github?: string; otherEmails?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const result = await saveUnifiedContact(member.org.id, key, {
    email: body.email ?? null,
    phone: body.phone ?? null,
    github: body.github ?? null,
    otherEmails: Array.isArray(body.otherEmails)
      ? body.otherEmails.filter((e): e is string => typeof e === "string")
      : [],
  });
  if (result.error)
    return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 400 });
  return NextResponse.json({ contact: result.contact });
}
