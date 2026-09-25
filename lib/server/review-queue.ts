// The review queue: applications that arrived after their company's daily
// allowance was used up (status "queued", see review-budget.ts). Companies
// take turns, oldest first within each company, each within its own
// allowance; a company whose allowance is used up waits for the next run,
// and never holds up another.
// Runs nightly from .github/workflows/review-queue.yml through the worker
// bundle, with the same pipeline the apply, referral and future-interest
// routes use. The lead email already went out when each one arrived.
import { sbRest } from "./supabase";
import { getOrgId } from "./spine";
import { reviewRoom, takeReview } from "./review-budget";
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
  created_at: string;
};

const COLS =
  "id,organization_id,name,email,linkedin_url,visa_status,preferred_locations,role_ids,resume_path,source," +
  "follow_up_at,preferred_roles,preferred_workplace,comp_expectation,created_at";

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

type Company = { id: string; slug: string; name: string };

// PostgREST returns at most 1000 rows per response, whatever limit is asked
// for. Each company's list is one read, so a company gets at most this many
// reviews a night however much room it has; the rest wait for the next run.
const PAGE_CAP = 1000;

/** The companies the queue serves: `orgIds` when given (tests, or a targeted
 *  run), otherwise every organization. One read, so it assumes fewer than
 *  1000 companies. */
async function queueCompanies(orgIds?: string[]): Promise<Company[]> {
  let filter = "";
  if (orgIds) {
    const only = orgIds.filter((o) => /^[0-9a-f-]{36}$/i.test(o));
    if (!only.length) return [];
    filter = `id=in.(${only.join(",")})&`;
  }
  const res = await sbRest(`organizations?${filter}select=id,slug,name&order=id.asc`);
  if (!res.ok) throw new Error(`review queue: company list read failed ${res.status}`);
  return (await res.json()) as Company[];
}

/** Review queued applications until `max` are done or the deadline passes.
 *  Companies take turns: each one with room in its allowance puts up its
 *  oldest queued applications (no more than it has room for), and the queue
 *  takes one from each company in turn. A company with a long backlog or no
 *  room left never holds up another, and an error with one company or one
 *  application skips just that one. dryRun: count what would be reviewed,
 *  spend nothing. orgIds: only these companies (tests, or a targeted run). */
export async function reviewQueued(opts: {
  max: number;
  deadline: number;
  dryRun?: boolean;
  orgIds?: string[];
}): Promise<{ reviewed: number; failed: number; waiting: number }> {
  // Without knowing which company is Transformer Talent, a TT application
  // could be reviewed as a client's (or the other way round), so stop before
  // anything is spent. The workflow run shows red.
  const ttOrgId = await getOrgId();
  if (!ttOrgId) throw new Error("review queue: Transformer Talent organization not found");

  const lists: { company: Company; rows: QueuedRow[] }[] = [];
  for (const company of await queueCompanies(opts.orgIds)) {
    if (Date.now() > opts.deadline) break;
    try {
      // Read-only: nothing is spent until takeReview below.
      const room = await reviewRoom(company.id);
      const limit = Math.min(room, opts.max, PAGE_CAP);
      if (limit <= 0) continue;
      // Applications from before they were stamped with a company
      // (organization_id null) were always Transformer Talent's.
      const whose =
        company.id === ttOrgId
          ? `or=(organization_id.eq.${company.id},organization_id.is.null)`
          : `organization_id=eq.${company.id}`;
      const res = await sbRest(
        `website_applications?status=eq.queued&${whose}&select=${COLS}&order=created_at.asc&limit=${limit}`
      );
      if (!res.ok) throw new Error(`queued read failed ${res.status}`);
      const rows = (await res.json()) as QueuedRow[];
      if (rows.length) lists.push({ company, rows });
    } catch (err) {
      console.error(`review queue: skipped company ${company.id} tonight`, err);
    }
  }

  // Round-robin: the first application of every company, then the second of
  // every company, and so on. The company that has waited longest goes first
  // in each round, so a cut by max or the deadline falls on the companies
  // that have waited least.
  lists.sort((x, y) => Date.parse(x.rows[0].created_at) - Date.parse(y.rows[0].created_at));
  const turns: { company: Company; row: QueuedRow }[] = [];
  const rounds = Math.max(0, ...lists.map((l) => l.rows.length));
  for (let i = 0; i < rounds; i++)
    for (const l of lists) if (l.rows[i]) turns.push({ company: l.company, row: l.rows[i] });

  const seen = new Set<string>();
  const full = new Set<string>();
  let reviewed = 0;
  let failed = 0;

  for (const { company, row: a } of turns) {
    if (reviewed + failed >= opts.max || Date.now() > opts.deadline) break;
    if (seen.has(a.id) || full.has(company.id)) continue;
    seen.add(a.id);
    // Each list is already no longer than the company's room, so the dry run
    // counts min(room, queued) per company without taking anything.
    if (opts.dryRun) {
      reviewed++;
      continue;
    }
    try {
      // The room read above is a snapshot; live applications may have used
      // some since. takeReview is the check that actually spends.
      if (!(await takeReview(company.id))) {
        full.add(company.id);
        continue;
      }
      const isReferral = (a.source || "").startsWith("referral:");
      const isFuture = a.source === "future";
      const roleIds = a.role_ids || [];
      const resumeBuf = a.resume_path ? await resumeFile(a.resume_path) : null;
      const resumeSafeName =
        (a.resume_path || "").split("/").pop()?.replace(/^[0-9a-f-]{36}-/i, "") || "resume.pdf";
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
        boardOrg: company.id === ttOrgId ? null : company,
        orgId: company.id,
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
