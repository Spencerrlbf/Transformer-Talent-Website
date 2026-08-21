import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import {
  loadJobStages,
  sanitizeStages,
  remapDeletedStages,
} from "@/lib/server/interview-stages";

// Per-job interview stage template. GET returns the effective template
// (override or company default); PUT saves an override or resets to the
// default (stages: null). Candidates in deleted stages are remapped.

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const { id } = await params;
  const { stages, custom } = await loadJobStages(member.org.id, id);
  return NextResponse.json({ stages, custom });
}

export async function PUT(req: NextRequest, { params }: Params) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const { id } = await params;

  let body: { stages?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const { stages: oldStages } = await loadJobStages(member.org.id, id);

  let newStages;
  if (body.stages === null) {
    // Reset to the company default.
    newStages = null;
  } else {
    newStages = sanitizeStages(body.stages);
    if (!newStages) return NextResponse.json({ error: "bad_stages" }, { status: 400 });
  }

  const res = await sbRest(
    `org_roles?organization_id=eq.${member.org.id}&external_id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ interview_stages: newStages }),
      prefer: "return=minimal",
    }
  );
  if (!res.ok) return NextResponse.json({ error: "save_failed" }, { status: 502 });

  const effective = newStages ?? (await loadJobStages(member.org.id, id)).stages;
  await remapDeletedStages({
    orgId: member.org.id,
    oldStages,
    newStages: effective,
    jobId: id,
  });

  return NextResponse.json({ stages: effective, custom: newStages !== null });
}
