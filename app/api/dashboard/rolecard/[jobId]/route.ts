// A role's scorecard. GET drafts one the first time a role without it is
// opened; PUT saves the recruiter's edit; POST returns a fresh draft from the
// job description without saving it, so nothing is lost until they say so.
// Works on synced roles too: the scorecard is dashboard-owned.
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import { isScorecard, sanitizeScorecard } from "@/lib/rolecard";
import { ROLE_CARD_COLS, ensureRoleCard, saveRoleCard, type RoleForCard } from "@/lib/server/rolecard/store";
import { canDraft, draftScorecard, type DraftInput } from "@/lib/server/rolecard/draft";

const roleDraftInput = (role: RoleForCard): DraftInput => ({
  title: role.title,
  yoe: role.yoe,
  jd: role.jd,
  description: role.description,
  skills: role.skills,
  minYears: role.matching_profile?.min_years ?? null,
});

export const maxDuration = 60;

type Params = { params: Promise<{ jobId: string }> };

async function loadRole(orgId: string, jobId: string): Promise<RoleForCard | null> {
  const res = await sbRest(
    `org_roles?organization_id=eq.${orgId}&external_id=eq.${encodeURIComponent(jobId)}&select=${ROLE_CARD_COLS}&limit=1`
  );
  const [row] = res.ok ? ((await res.json()) as RoleForCard[]) : [];
  return row || null;
}

export async function GET(req: NextRequest, { params }: Params) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const role = await loadRole(member.org.id, (await params).jobId);
  if (!role) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { card } = await ensureRoleCard(role).catch(() => ({ card: null }));
  // canDraft tells the page why there is none: nothing written to draft from.
  return NextResponse.json({ scorecard: card, canDraft: canDraft(roleDraftInput(role)) });
}

export async function PUT(req: NextRequest, { params }: Params) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const role = await loadRole(member.org.id, (await params).jobId);
  if (!role) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await req.json().catch(() => null);
  const prev = isScorecard(role.scorecard) ? role.scorecard : null;
  const card = sanitizeScorecard(body?.scorecard, "user", prev);
  if (!card) return NextResponse.json({ error: "empty_scorecard" }, { status: 400 });
  if (!card.criteria.some((c) => c.tier === "required"))
    return NextResponse.json({ error: "no_required_row" }, { status: 400 });
  // "Edited" means a person changed it; saving it untouched does not.
  if (!prev || JSON.stringify(prev.criteria) !== JSON.stringify(card.criteria)) {
    card.editedBy = member.email;
    card.editedAt = new Date().toISOString();
  } else {
    card.editedBy = prev.editedBy;
    card.editedAt = prev.editedAt;
  }
  if (!(await saveRoleCard(role.id, card))) return NextResponse.json({ error: "save_failed" }, { status: 502 });
  return NextResponse.json({ scorecard: card });
}

export async function POST(req: NextRequest, { params }: Params) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const role = await loadRole(member.org.id, (await params).jobId);
  if (!role) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!canDraft(roleDraftInput(role))) return NextResponse.json({ error: "nothing_to_draft_from" }, { status: 400 });
  const draft = await draftScorecard(roleDraftInput(role));
  if (!draft) return NextResponse.json({ error: "draft_failed" }, { status: 502 });
  return NextResponse.json({ scorecard: draft });
}
