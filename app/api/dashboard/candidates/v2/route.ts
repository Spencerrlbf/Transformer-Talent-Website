import { jobInOrg } from "@/lib/server/organization-access";
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { listUnifiedCandidates } from "@/lib/server/candidates-unified";

export const maxDuration = 60;

// Unified candidates list (Candidates v2): applicants + sourced, filtered,
// fit-sorted, paginated server-side.
export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const q = req.nextUrl.searchParams;
  const job = q.get("job"), jobAlias = q.get("jobId");
  if (job && jobAlias && job !== jobAlias) return NextResponse.json({ error: "conflicting_job" }, { status: 400 });
  const jobId = job || jobAlias || undefined;
  if (jobId && !(await jobInOrg(member.org.id, jobId))) return NextResponse.json({ error: "job_not_found" }, { status: 404 });
  const source = q.get("source");
  const sort = q.get("sort");
  const list = await listUnifiedCandidates({
    orgId: member.org.id,
    source: source === "applied" || source === "sourced" ? source : undefined,
    jobId,
    fit: q.get("fit") || undefined,
    q: q.get("q") || undefined,
    hideNotNow: q.get("hideNotNow") === "1",
    past: q.get("past") === "1",
    followups: q.get("followups") === "1",
    loc: q.get("loc") || undefined,
    stage: q.get("stage") || undefined,
    yoe: q.get("yoe") || undefined,
    skill: q.get("skill") || undefined,
    visa: q.get("visa") || undefined,
    opened: q.get("opened") || undefined,
    list: q.get("list") || undefined,
    sort:
      sort === "added" || sort === "name" || sort === "years" || sort === "followup"
        ? sort
        : "fit",
    dir: q.get("dir") === "asc" ? "asc" : "desc",
    page: Number(q.get("page")) || 1,
    pageSize: Number(q.get("pageSize")) || 25,
  });
  return NextResponse.json(list);
}
