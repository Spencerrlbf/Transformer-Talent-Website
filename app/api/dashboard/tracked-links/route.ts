import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { ensureLinks } from "@/lib/server/tracked-links";

// Mint (or fetch) tracked links for a set of candidates. Idempotent: one
// link per (org, candidate), so the table's copy button and the CSV export
// always agree on the URL.
export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  let body: { keys?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const keys = Array.isArray(body.keys) ? body.keys.filter((k) => typeof k === "string") : [];
  if (!keys.length) return NextResponse.json({ error: "no_keys" }, { status: 400 });

  const links = await ensureLinks({
    orgId: member.org.id,
    candidateKeys: keys as string[],
    userId: member.userId,
  });
  return NextResponse.json({ links: Object.fromEntries(links) });
}
