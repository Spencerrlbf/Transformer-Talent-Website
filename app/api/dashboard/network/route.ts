import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { listNetworkMatches, TT_ORG_SLUG } from "@/lib/server/network";

export const maxDuration = 60;

// Internal-only: the nightly pool matches, person-first. Any org other than
// Transformer Talent gets a 404 — the surface does not exist for clients.
export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  if (member.org.slug !== TT_ORG_SLUG)
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  const q = req.nextUrl.searchParams;
  // A failed page answers with an error the tab shows as "Couldn't load",
  // never as an empty list.
  const list = await listNetworkMatches(member.org.id, {
    job: q.get("job") || undefined,
    label: q.get("label") || undefined,
    company: q.get("company") || undefined,
    q: q.get("q") || undefined,
    newDays: q.get("new") ? Math.max(1, parseInt(q.get("new") || "7", 10) || 7) : undefined,
    page: Math.max(1, parseInt(q.get("page") || "1", 10) || 1),
  }).catch((err: unknown) => {
    console.error("network list failed", err instanceof Error ? err.message : err);
    return null;
  });
  if (!list) return NextResponse.json({ error: "load_failed" }, { status: 502 });
  return NextResponse.json(list);
}
