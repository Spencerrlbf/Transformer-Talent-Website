import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { markInbox } from "@/lib/server/inbox";
import { candidateInOrg } from "@/lib/server/tasks";

// This seat's mark on an arrival or thread: seen (opened the drawer), done
// (cleared without acting), or reopened (handled: null). Tasks and follow-
// ups have their own routes; this never touches them. The candidate the
// mark is filed under is derived from the item id where possible and must
// belong to this org — a client can't file a mark under someone else's row.
export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  let body: { id?: unknown; seen?: unknown; handled?: unknown; kind?: unknown; label?: unknown; candidateKey?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const id = String(body.id || "");
  const mark: Parameters<typeof markInbox>[3] = {};
  if (body.seen === true) mark.seen = true;
  if (body.handled === null) mark.handled = null;
  else if (typeof body.handled === "string" && body.handled) mark.handled = body.handled.slice(0, 40);
  if (typeof body.kind === "string") mark.kind = body.kind.slice(0, 20);
  if (typeof body.label === "string") mark.label = body.label;
  if (mark.seen === undefined && mark.handled === undefined)
    return NextResponse.json({ error: "nothing_to_mark" }, { status: 400 });

  // arr:/fdue: items are applications by construction; mail: items name
  // their candidate, which must be one of ours.
  const arr = id.match(/^(?:arr|fdue):([0-9a-f-]{36})$/i);
  let candidateKey: string | null = arr ? `app_${arr[1]}` : null;
  if (!candidateKey && typeof body.candidateKey === "string" && /^(app|src)_[0-9a-f-]{36}$/i.test(body.candidateKey)) {
    candidateKey = body.candidateKey;
  }
  if (candidateKey) {
    if (!(await candidateInOrg(member.org.id, candidateKey))) return NextResponse.json({ error: "bad_item" }, { status: 400 });
    mark.candidateKey = candidateKey;
  }

  const ok = await markInbox(member.org.id, member.email, id, mark);
  if (!ok) return NextResponse.json({ error: "bad_item" }, { status: 400 });
  return NextResponse.json({ ok: true });
}
