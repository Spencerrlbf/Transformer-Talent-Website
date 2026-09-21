// A role's scorecard. GET drafts one the first time a role without it is
// opened; PUT saves the recruiter's edit; POST returns a fresh draft from the
// job description without saving it, so nothing is lost until they say so
// (it only records, on the stored card, what the drafter did).
// Works on synced roles too: the scorecard is dashboard-owned.
import { after, NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import { isScorecard, sanitizeScorecard } from "@/lib/rolecard";
import { ROLE_CARD_COLS, ensureRoleCard, saveRoleCard, type RoleForCard } from "@/lib/server/rolecard/store";
import { canDraft, draftScorecard, type DraftInput } from "@/lib/server/rolecard/draft";
import { relabelRole } from "@/lib/server/rolecard/feedback";

const roleDraftInput = (role: RoleForCard): DraftInput => ({
  title: role.title,
  yoe: role.yoe,
  jd: role.jd,
  description: role.description,
  skills: role.skills,
  techStack: role.tech_stack,
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
  // The role's call questions changed: every stored verdict for the role is
  // re-labelled from its own rows, with no model call.
  const calls = (c: { criteria: { id: string; confirmOnCall?: boolean }[] } | null) => JSON.stringify((c?.criteria || []).filter((x) => x.confirmOnCall).map((x) => x.id).sort());
  let relabelled = 0;
  if (calls(prev) !== calls(card)) relabelled = await relabelRole(member.org.id, role.id, card.criteria).catch((e) => (console.error("relabel failed", e), -1));
  return NextResponse.json({ scorecard: card, relabelled });
}

export async function POST(req: NextRequest, { params }: Params) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const role = await loadRole(member.org.id, (await params).jobId);
  if (!role) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!canDraft(roleDraftInput(role))) return NextResponse.json({ error: "nothing_to_draft_from" }, { status: 400 });
  const draft = await draftScorecard(roleDraftInput(role));
  if (!draft) return NextResponse.json({ error: "draft_failed" }, { status: 502 });
  // The redraft itself is saved only when the person presses Save. What the
  // drafter did is recorded on the stored card (never shown) so a draft that
  // went wrong can be read from the database: after the response, and onto
  // the card as it is stored THEN, not the copy read before a slow draft (a
  // save made meanwhile, such as the call flag, must not be undone).
  if (draft.draftNotes) {
    const notes = [`redraft ${new Date().toISOString()}`, ...draft.draftNotes].slice(0, 7);
    const jobId = (await params).jobId;
    after(async () => {
      const fresh = await loadRole(member.org.id, jobId).catch(() => null);
      if (fresh && isScorecard(fresh.scorecard)) await saveRoleCard(fresh.id, { ...fresh.scorecard, draftNotes: notes }).catch(() => false);
    });
  }
  return NextResponse.json({ scorecard: draft });
}
