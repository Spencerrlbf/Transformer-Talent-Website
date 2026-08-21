import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import {
  DEFAULT_STAGES,
  sanitizeStages,
  remapDeletedStages,
  type InterviewStage,
} from "@/lib/server/interview-stages";

// Org-level settings: company website, referral amount, and the default
// interview stage template. GET for any member; PATCH owner-only.
export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const res = await sbRest(
    `organizations?id=eq.${member.org.id}&select=website,referral_amount,interview_stages`
  );
  const [row] = res.ok
    ? ((await res.json()) as {
        website: string | null;
        referral_amount: number | null;
        interview_stages: unknown;
      }[])
    : [];
  return NextResponse.json({
    website: row?.website || "",
    referralAmount: row?.referral_amount ?? 5000,
    interviewStages: (row && sanitizeStages(row.interview_stages)) || DEFAULT_STAGES,
    canEdit: member.memberRole === "owner",
  });
}

export async function PATCH(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  if (member.memberRole !== "owner")
    return NextResponse.json({ error: "owner_only" }, { status: 403 });

  let body: { website?: string; referralAmount?: number; interviewStages?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  let stagesUpdate: InterviewStage[] | null = null;
  if ("interviewStages" in body) {
    stagesUpdate = sanitizeStages(body.interviewStages);
    if (!stagesUpdate) return NextResponse.json({ error: "bad_stages" }, { status: 400 });
    patch.interview_stages = stagesUpdate;
  }
  if ("website" in body) {
    const website = String(body.website || "").trim().slice(0, 300);
    if (website && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(website))
      return NextResponse.json({ error: "bad_website" }, { status: 400 });
    patch.website = website || null;
  }
  if ("referralAmount" in body) {
    const amount = Math.round(Number(body.referralAmount));
    if (!Number.isFinite(amount) || amount < 0 || amount > 1000000)
      return NextResponse.json({ error: "bad_amount" }, { status: 400 });
    patch.referral_amount = amount;
  }
  if (Object.keys(patch).length === 0)
    return NextResponse.json({ error: "nothing_to_save" }, { status: 400 });

  // For stage edits: read the old template first so candidates in deleted
  // stages can be remapped across every job that inherits the default.
  let oldStages: InterviewStage[] = DEFAULT_STAGES;
  if (stagesUpdate) {
    const ores = await sbRest(`organizations?id=eq.${member.org.id}&select=interview_stages`);
    const [row] = ores.ok ? ((await ores.json()) as { interview_stages: unknown }[]) : [];
    oldStages = (row && sanitizeStages(row.interview_stages)) || DEFAULT_STAGES;
  }

  const res = await sbRest(`organizations?id=eq.${member.org.id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
    prefer: "return=minimal",
  });
  if (!res.ok) return NextResponse.json({ error: "save_failed" }, { status: 502 });

  if (stagesUpdate) {
    await remapDeletedStages({
      orgId: member.org.id,
      oldStages,
      newStages: stagesUpdate,
      inheritingJobsOnly: true,
    });
  }
  return NextResponse.json({ ok: true });
}
