// The review queue: applications that arrived after their company's daily
// allowance was used up (status "queued", see review-budget.ts). Reviewed
// oldest first, each company within its own allowance; a company whose
// allowance is used up waits for the next run, and never holds up another.
// Runs nightly from .github/workflows/review-queue.yml through the worker
// bundle, with the same pipeline the apply, referral and future-interest
// routes use. The lead email already went out when each one arrived.
import { sbRest } from "./supabase";
import { getOrgId } from "./spine";
import { takeReview } from "./review-budget";
import { runApplicantPipeline } from "./applicant-pipeline";

type QueuedRow = {
  id: string;
  organization_id: string | null;
  name: string | null;
  email: string;
  linkedin_url: string | null;
  visa_status: string | null;
  preferred_locations: string[] | null;
  role_ids: string[] | null;
  resume_path: string | null;
  source: string | null;
  follow_up_at: string | null;
  preferred_roles: string[] | null;
  preferred_workplace: string[] | null;
  comp_expectation: string | null;
};

const COLS =
  "id,organization_id,name,email,linkedin_url,visa_status,preferred_locations,role_ids,resume_path,source," +
  "follow_up_at,preferred_roles,preferred_workplace,comp_expectation";

async function resumeFile(path: string): Promise<Buffer | null> {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  const res = await fetch(`${base}/storage/v1/object/resumes/${path.split("/").map(encodeURIComponent).join("/")}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!res?.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

export async function queuedCount(): Promise<number> {
  const res = await sbRest(`website_applications?status=eq.queued&select=id`, {
    prefer: "count=exact",
    headers: { Range: "0-0" },
  });
  const range = res.headers.get("content-range") || "0-0/0";
  return parseInt(range.split("/")[1] || "0", 10) || 0;
}

/** Review queued applications until `max` are done or the deadline passes.
 *  dryRun: count what would be reviewed, spend nothing. orgIds: only these
 *  companies (tests, or a targeted run). */
export async function reviewQueued(opts: {
  max: number;
  deadline: number;
  dryRun?: boolean;
  orgIds?: string[];
}): Promise<{ reviewed: number; failed: number; waiting: number }> {
  const only = (opts.orgIds || []).filter((o) => /^[0-9a-f-]{36}$/i.test(o));
  const res = await sbRest(
    `website_applications?status=eq.queued${only.length ? `&organization_id=in.(${only.join(",")})` : ""}` +
      `&select=${COLS}&order=created_at.asc&limit=1000`
  );
  const rows = (res.ok ? await res.json() : []) as QueuedRow[];
  const ttOrgId = await getOrgId();
  const full = new Set<string>();
  const boards = new Map<string, { id: string; slug: string; name: string } | null>();
  let reviewed = 0;
  let failed = 0;

  for (const a of rows) {
    if (reviewed + failed >= opts.max || Date.now() > opts.deadline) break;
    const orgId = a.organization_id || ttOrgId;
    if (!orgId || full.has(orgId)) continue;
    if (opts.dryRun) {
      reviewed++;
      continue;
    }
    if (!(await takeReview(orgId))) {
      full.add(orgId);
      continue;
    }
    if (orgId !== ttOrgId && !boards.has(orgId)) {
      const o = await sbRest(`organizations?id=eq.${orgId}&select=id,slug,name`);
      const [row] = o.ok ? ((await o.json()) as { id: string; slug: string; name: string }[]) : [];
      boards.set(orgId, row ?? null);
    }
    const isReferral = (a.source || "").startsWith("referral:");
    const isFuture = a.source === "future";
    const roleIds = a.role_ids || [];
    const resumeBuf = a.resume_path ? await resumeFile(a.resume_path) : null;
    const resumeSafeName =
      (a.resume_path || "").split("/").pop()?.replace(/^[0-9a-f-]{36}-/i, "") || "resume.pdf";
    try {
      await runApplicantPipeline({
        submissionId: a.id,
        name: a.name || "",
        email: a.email,
        linkedin: a.linkedin_url || "",
        visa: a.visa_status || "",
        preferredLocations: a.preferred_locations || [],
        roleIds,
        speculative: !isReferral && (isFuture || roleIds.length === 0),
        resumeBuf,
        resumeSafeName,
        resumePath: a.resume_path,
        boardOrg: orgId === ttOrgId ? null : boards.get(orgId) ?? null,
        orgId,
        applicationType: isReferral ? "Referral" : roleIds.length ? "Applied" : "Speculative",
        followUpAt: isFuture ? a.follow_up_at : null,
        preferredRoles: isFuture ? a.preferred_roles || [] : undefined,
        preferredWorkplace: isFuture ? a.preferred_workplace || [] : undefined,
        salaryFloor: isFuture ? a.comp_expectation : null,
        fromQueue: true,
      });
      reviewed++;
    } catch (err) {
      failed++;
      console.error(`queued review failed for application ${a.id}`, err);
    }
  }
  return { reviewed, failed, waiting: await queuedCount() };
}
