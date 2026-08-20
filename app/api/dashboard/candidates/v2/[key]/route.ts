import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { unifiedCandidateDetail } from "@/lib/server/candidates-unified";
import { TT_ORG_SLUG } from "@/lib/server/network";

export const maxDuration = 60;

// Drawer detail for one person ("app_<id>" | "src_<id>" | "net_<id>").
export async function GET(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const { key } = await ctx.params;
  if (!/^(app|src|net)_[0-9a-f-]{36}$/i.test(key))
    return NextResponse.json({ error: "bad_key" }, { status: 400 });
  // Pool people (the internal Network page) exist only for Transformer Talent.
  if (key.startsWith("net_") && member.org.slug !== TT_ORG_SLUG)
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  const detail = await unifiedCandidateDetail(member.org.id, key);
  if (!detail) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(detail);
}
