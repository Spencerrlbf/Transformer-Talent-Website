// Interview stage templates: the steps between Replied and Offer. A company
// default lives on organizations; jobs may override. Stable ids survive
// renames; deleting a stage slides its candidates to the nearest earlier
// surviving stage (never out of the pipeline).
import { sbRest } from "./supabase";

export type InterviewStage = { id: string; label: string };

export const DEFAULT_STAGES: InterviewStage[] = [
  { id: "screen", label: "Recruiter screen" },
  { id: "technical", label: "Technical" },
  { id: "onsite", label: "Onsite" },
  { id: "final", label: "Final" },
];

const MAX_STAGES = 8;
const ID_RE = /^[a-z0-9_-]{1,24}$/;

function freshId(): string {
  return `s${Math.random().toString(36).slice(2, 8)}`;
}

/** Sanitize an incoming template. Returns null when unusable. */
export function sanitizeStages(input: unknown): InterviewStage[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_STAGES) return null;
  const seen = new Set<string>();
  const out: InterviewStage[] = [];
  for (const item of input) {
    const o = item as { id?: unknown; label?: unknown };
    const label = String(o.label ?? "").trim().slice(0, 30);
    if (!label) return null;
    let id = String(o.id ?? "");
    if (!ID_RE.test(id) || seen.has(id)) id = freshId();
    seen.add(id);
    out.push({ id, label });
  }
  return out;
}

function parseStages(v: unknown): InterviewStage[] | null {
  const s = sanitizeStages(v);
  return s && s.length ? s : null;
}

/** Effective template for a job: role override, else the org default. */
export async function loadJobStages(
  orgId: string,
  externalJobId: string
): Promise<{ stages: InterviewStage[]; custom: boolean }> {
  const [roleRes, orgRes] = await Promise.all([
    sbRest(
      `org_roles?organization_id=eq.${orgId}&external_id=eq.${encodeURIComponent(externalJobId)}&select=interview_stages&limit=1`
    ),
    sbRest(`organizations?id=eq.${orgId}&select=interview_stages`),
  ]);
  const [role] = roleRes.ok ? ((await roleRes.json()) as { interview_stages: unknown }[]) : [];
  const [org] = orgRes.ok ? ((await orgRes.json()) as { interview_stages: unknown }[]) : [];
  const override = role ? parseStages(role.interview_stages) : null;
  const fallback = (org && parseStages(org.interview_stages)) || DEFAULT_STAGES;
  return { stages: override || fallback, custom: !!override };
}

/**
 * Remap candidates after a template change: anyone sitting in a stage id
 * that no longer exists moves to the nearest EARLIER surviving stage from
 * the old ordering (or the first new stage when nothing earlier survived).
 * jobFilter limits the update to one job (per-job edits); without it the
 * remap covers all the org's jobs that inherit the default (org edits).
 */
export async function remapDeletedStages(args: {
  orgId: string;
  oldStages: InterviewStage[];
  newStages: InterviewStage[];
  jobId?: string;
  inheritingJobsOnly?: boolean;
}): Promise<void> {
  const surviving = new Set(args.newStages.map((s) => s.id));
  const fallbackId = args.newStages[0]?.id ?? null;
  const removed = args.oldStages.filter((s) => !surviving.has(s.id));
  if (removed.length === 0) return;

  // Jobs that inherit the org default (no override of their own).
  let inheritingIds: string[] | null = null;
  if (args.inheritingJobsOnly) {
    const res = await sbRest(
      `org_roles?organization_id=eq.${args.orgId}&interview_stages=is.null&select=external_id`
    );
    inheritingIds = res.ok
      ? ((await res.json()) as { external_id: string }[]).map((r) => r.external_id)
      : [];
    if (inheritingIds.length === 0) return;
  }

  for (const gone of removed) {
    const idx = args.oldStages.findIndex((s) => s.id === gone.id);
    let target: string | null = fallbackId;
    for (let i = idx - 1; i >= 0; i--) {
      if (surviving.has(args.oldStages[i].id)) {
        target = args.oldStages[i].id;
        break;
      }
    }
    let q = `candidate_role_statuses?organization_id=eq.${args.orgId}&interview_stage=eq.${encodeURIComponent(gone.id)}`;
    if (args.jobId) q += `&job_id=eq.${encodeURIComponent(args.jobId)}`;
    else if (inheritingIds) q += `&job_id=in.(${inheritingIds.map((j) => `"${j}"`).join(",")})`;
    await sbRest(q, {
      method: "PATCH",
      body: JSON.stringify({ interview_stage: target }),
      prefer: "return=minimal",
    }).catch(() => {});
  }
}
