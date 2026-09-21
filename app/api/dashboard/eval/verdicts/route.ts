import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { buildEvalSet, DEFAULT_MODEL, listEval, listModels, runEval, voteEval } from "@/lib/server/verdict-eval";

export const maxDuration = 60;

// Owner-only verdict comparison. GET lists the golden set with today's
// verdict, the proposed one per model, and the owner's votes. POST:
//   {action:"build"}                      assemble the golden set (idempotent)
//   {action:"run", model}                 judge up to 12 rows lacking this model
//   {action:"vote", id, model, vote}      'new' | 'old' | 'neither'
async function owner(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return { err: NextResponse.json({ error: "not_a_member" }, { status: 403 }) };
  if (member.memberRole !== "owner") return { err: NextResponse.json({ error: "owner_only" }, { status: 403 }) };
  return { member };
}

export async function GET(req: NextRequest) {
  const { member, err } = await owner(req);
  if (err) return err;
  const [rows, models] = await Promise.all([listEval(member!.org.id), listModels()]);
  return NextResponse.json({ rows, models, defaultModel: DEFAULT_MODEL });
}

export async function POST(req: NextRequest) {
  const { member, err } = await owner(req);
  if (err) return err;
  let body: { action?: unknown; model?: unknown; id?: unknown; vote?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const orgId = member!.org.id;
  if (body.action === "build") {
    const r = await buildEvalSet(orgId).catch((e: Error) => ({ error: e.message }));
    return "error" in r ? NextResponse.json(r, { status: 502 }) : NextResponse.json({ ok: true, ...r });
  }
  const model = typeof body.model === "string" && /^[a-z0-9.\-]{2,60}$/i.test(body.model) ? body.model : DEFAULT_MODEL;
  if (body.action === "run") {
    const r = await runEval(orgId, model, { limit: 12, deadline: Date.now() + 45_000 }).catch((e: Error) => ({ error: e.message }));
    return "error" in r ? NextResponse.json(r, { status: 502 }) : NextResponse.json({ ok: true, model, ...r });
  }
  if (body.action === "vote") {
    const vote = body.vote === "new" || body.vote === "old" || body.vote === "neither" ? body.vote : null;
    if (typeof body.id !== "string" || !vote) return NextResponse.json({ error: "bad_body" }, { status: 400 });
    const ok = await voteEval(orgId, body.id, model, vote);
    return NextResponse.json({ ok });
  }
  return NextResponse.json({ error: "bad_action" }, { status: 400 });
}
