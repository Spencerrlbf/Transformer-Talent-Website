// Drafts a scorecard from a job form that has not been saved yet. Saves
// nothing: the draft rides along with the form and is stored on publish.
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { draftScorecard } from "@/lib/server/rolecard/draft";

export const maxDuration = 60;

const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const list = (v: unknown, max: number) =>
  (Array.isArray(v) ? v : []).map((x) => str(x, 300)).filter(Boolean).slice(0, max);

export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const title = str(body?.title, 120);
  const about = str(body?.about, 4000);
  const needs = list(body?.needs, 15);
  if (!title || (!about && !needs.length)) return NextResponse.json({ error: "not_enough_to_draft" }, { status: 400 });
  const yoeMin = Number(body?.yoeMin);
  const skills = (Array.isArray(body?.skills) ? (body!.skills as Record<string, unknown>[]) : []).slice(0, 20).map((s) => ({
    skill: str(s?.skill, 60),
    must_have: !!s?.must_have,
    alternates: list(s?.alternates, 5),
  })).filter((s) => s.skill);
  const draft = await draftScorecard({
    title,
    jd: { about, doing: list(body?.doing, 15), needs, bonus: list(body?.bonus, 8) },
    skills,
    minYears: Number.isFinite(yoeMin) && yoeMin > 0 ? Math.round(yoeMin) : null,
  });
  if (!draft) return NextResponse.json({ error: "draft_failed" }, { status: 502 });
  return NextResponse.json({ scorecard: draft });
}
