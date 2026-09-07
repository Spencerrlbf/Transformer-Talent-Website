// Verdict comparison: the golden set behind the owner-only eval page. Builds
// one row per candidate x role from verdicts the product has already shown
// (sourcing runs and applicant scorecards), runs the proposed one-paragraph
// verdict over the same people per model, and records the owner's vote.
import { sbRest } from "./supabase";
import { computeFacts, formatFacts } from "./facts";
import { harvestToExperiences, linkedinProfileText } from "./spine";
import { splitStack, type Scorecard } from "./scorecard";
import { clientReason, clientTag, TAG_LABEL } from "./client-reason";
import { companyContextLine, companySlugFromUrl, getCompanyContexts } from "./sourcing/company-context";
import { judgeVerdict, type Verdict } from "./verdict";

/** What the product calls each stored tag today. */
const OLD_LABEL: Record<string, string> = {
  strong_yes: "Strong yes",
  yes: "Yes",
  worth_message: "Worth a message",
  not_now: "Not now",
  strong: "Strong fit",
  possible: "Worth a look",
  stretch: "Likely a stretch",
};

export type EvalPerson = {
  name: string;
  title: string | null;
  company: string | null;
  location: string | null;
  years: number | null;
  linkedinUrl: string | null;
};
export type EvalOld = {
  engine: "judge" | "checklist";
  tag: string | null;
  label: string | null;
  reason: string | null;
  scorecard: Scorecard | null;
};
export type EvalRow = {
  id: string;
  kind: "sourced" | "applicant";
  roleTitle: string;
  person: EvalPerson;
  old: EvalOld;
  runs: Record<string, Verdict>;
  votes: Record<string, string>;
};

type DbRow = {
  id: string;
  kind: "sourced" | "applicant";
  subject_id: string;
  application_id: string | null;
  org_role_id: string;
  person: EvalPerson;
  old: EvalOld;
  runs: Record<string, Verdict> | null;
  votes: Record<string, string> | null;
  created_at: string;
  org_roles?: { title: string } | null;
};

async function rest<T>(path: string, init: Parameters<typeof sbRest>[1] = {}): Promise<T> {
  const res = await sbRest(path, init);
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path.split("?")[0]} ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]);
      }
    })
  );
}

const shape = (r: DbRow): EvalRow => ({
  id: r.id,
  kind: r.kind,
  roleTitle: r.org_roles?.title || "",
  person: r.person,
  old: r.old,
  runs: r.runs || {},
  votes: r.votes || {},
});

export async function listEval(orgId: string): Promise<EvalRow[]> {
  const rows = await rest<DbRow[]>(
    `verdict_evals?organization_id=eq.${orgId}&select=*,org_roles(title)&order=kind.desc,created_at.asc`
  );
  return rows.map(shape);
}

/** The golden set: up to 30 sourced people spread across today's tags, and up
 *  to 20 applicants spread across scorecard tiers, all with a stored profile. */
export async function buildEvalSet(orgId: string): Promise<{ added: number; total: number }> {
  const inserts: Record<string, unknown>[] = [];

  type SRow = {
    id: string;
    tag: string | null;
    reason: string | null;
    verdict: Record<string, unknown> | null;
    sourced_candidate_id: string;
    sourced_candidates: {
      full_name: string | null; headline: string | null; location: string | null; current_title: string | null;
      current_company: string | null; years_experience: number | null; linkedin_url: string | null;
    } | null;
    sourcing_runs: { org_role_id: string } | null;
  };
  const sourced = await rest<SRow[]>(
    `sourcing_run_candidates?organization_id=eq.${orgId}&screen_status=eq.done&reason=not.is.null&tag=not.is.null` +
      `&select=id,tag,reason,verdict,sourced_candidate_id,sourced_candidates(full_name,headline,location,current_title,current_company,years_experience,linkedin_url),sourcing_runs(org_role_id)` +
      `&order=screened_at.desc&limit=500`
  ).catch(() => [] as SRow[]);
  const perTag = new Map<string, number>();
  const seen = new Set<string>();
  for (const r of sourced) {
    const roleId = r.sourcing_runs?.org_role_id;
    const c = r.sourced_candidates;
    if (!roleId || !c || !r.tag) continue;
    const key = `${r.sourced_candidate_id}|${roleId}`;
    if (seen.has(key)) continue;
    const n = perTag.get(r.tag) || 0;
    if (n >= 8) continue;
    if (inserts.length >= 30) break;
    perTag.set(r.tag, n + 1);
    seen.add(key);
    const v = r.verdict || {};
    inserts.push({
      organization_id: orgId,
      kind: "sourced",
      subject_id: r.sourced_candidate_id,
      application_id: null,
      org_role_id: roleId,
      person: {
        name: c.full_name || "Candidate",
        title: c.current_title || c.headline,
        company: c.current_company,
        location: c.location,
        years: c.years_experience,
        linkedinUrl: c.linkedin_url,
      } satisfies EvalPerson,
      old: {
        engine: typeof v.why_fit === "string" ? "judge" : "checklist",
        tag: r.tag,
        label: OLD_LABEL[r.tag] || r.tag,
        reason: r.reason,
        scorecard: (v.scorecard as Scorecard | undefined) || null,
      } satisfies EvalOld,
    });
  }

  type VRow = {
    id: string;
    candidate_id: string;
    org_role_id: string;
    verdict: { scorecard?: Scorecard; facts?: { careerYears?: number | null } } | null;
    created_at: string;
  };
  const verdicts = await rest<VRow[]>(
    `match_verdicts?organization_id=eq.${orgId}&select=id,candidate_id,org_role_id,verdict,created_at&order=created_at.desc&limit=800`
  ).catch(() => [] as VRow[]);
  const newest = new Map<string, VRow>();
  for (const v of verdicts) {
    if (!v.verdict?.scorecard) continue;
    const k = `${v.candidate_id}|${v.org_role_id}`;
    if (!newest.has(k)) newest.set(k, v);
  }
  type ARow = {
    id: string;
    candidate_id: string;
    name: string | null;
    linkedin_url: string | null;
    parsed_profile: { current_title?: string | null; current_company?: string | null; location?: string | null; total_experience_years?: number | null } | null;
  };
  const candIds = [...new Set([...newest.values()].map((v) => v.candidate_id))];
  const appByCand = new Map<string, ARow>();
  for (let i = 0; i < candIds.length; i += 80) {
    const chunk = candIds.slice(i, i + 80);
    const rows = await rest<ARow[]>(
      `website_applications?organization_id=eq.${orgId}&candidate_id=in.(${chunk.join(",")})&harvest_profile=not.is.null` +
        `&select=id,candidate_id,name,linkedin_url,parsed_profile&order=created_at.desc`
    ).catch(() => [] as ARow[]);
    for (const a of rows) if (!appByCand.has(a.candidate_id)) appByCand.set(a.candidate_id, a);
  }
  const CAP: Record<string, number> = { STRONG: 8, POSSIBLE: 8, WEAK: 9 };
  const perTier = new Map<string, number>();
  let appAdded = 0;
  for (const v of newest.values()) {
    const a = appByCand.get(v.candidate_id);
    const sc = v.verdict?.scorecard;
    if (!a || !sc) continue;
    const n = perTier.get(sc.tier) || 0;
    if (n >= (CAP[sc.tier] ?? 5)) continue;
    if (appAdded >= 20) break;
    perTier.set(sc.tier, n + 1);
    appAdded++;
    const p = a.parsed_profile || {};
    const tag = clientTag(sc);
    inserts.push({
      organization_id: orgId,
      kind: "applicant",
      subject_id: v.candidate_id,
      application_id: a.id,
      org_role_id: v.org_role_id,
      person: {
        name: a.name || "Candidate",
        title: p.current_title || null,
        company: p.current_company || null,
        location: p.location || null,
        years: v.verdict?.facts?.careerYears ?? p.total_experience_years ?? null,
        linkedinUrl: a.linkedin_url || null,
      } satisfies EvalPerson,
      old: { engine: "checklist", tag, label: TAG_LABEL[tag], reason: clientReason(sc), scorecard: sc } satisfies EvalOld,
    });
  }

  let added = 0;
  if (inserts.length) {
    const res = await sbRest(`verdict_evals?on_conflict=organization_id,kind,subject_id,org_role_id`, {
      method: "POST",
      body: JSON.stringify(inserts),
      prefer: "resolution=ignore-duplicates,return=representation",
    });
    if (!res.ok) throw new Error(`eval insert ${res.status}: ${await res.text()}`);
    added = ((await res.json()) as unknown[]).length;
  }
  const total = (await rest<{ id: string }[]>(`verdict_evals?organization_id=eq.${orgId}&select=id`)).length;
  return { added, total };
}

type RoleRow = {
  id: string;
  title: string;
  tech_stack: string | null;
  jd: { about?: string; doing?: string[]; needs?: string[]; bonus?: string[] } | null;
  skills: { skill: string; must_have?: boolean; alternates?: string[] }[] | null;
  matching_profile: { must_haves?: string[]; min_years?: number | null } | null;
  target_companies: { name?: string }[] | null;
};

async function verdictFor(row: DbRow, role: RoleRow, model: string): Promise<Verdict | null> {
  let profile: Record<string, unknown> | null = null;
  let skills: string[] = [];
  let resumeText: string | null = null;
  if (row.kind === "sourced") {
    const [c] = await rest<{ profile: Record<string, unknown> | null; skills: string[] | null }[]>(
      `sourced_candidates?id=eq.${row.subject_id}&select=profile,skills`
    );
    profile = c?.profile || null;
    skills = c?.skills || [];
  } else if (row.application_id) {
    const [a] = await rest<{ harvest_profile: Record<string, unknown> | null; resume_text: string | null }[]>(
      `website_applications?id=eq.${row.application_id}&select=harvest_profile,resume_text`
    );
    profile = a?.harvest_profile || null;
    resumeText = a?.resume_text || null;
    skills = (((profile?.skills as { name?: string }[] | undefined) || []).map((s) => s?.name || "")).filter(Boolean);
  }
  if (!profile) return null;

  const stackTerms = [...new Set([...splitStack(role.tech_stack), ...(role.skills || []).map((s) => s.skill)])]
    .filter(Boolean)
    .slice(0, 20);
  const facts = computeFacts(harvestToExperiences(profile), stackTerms, skills, profile.education ?? null);
  const exp = Array.isArray(profile.experience) ? (profile.experience as Record<string, unknown>[]) : [];
  const current = exp.find((e) => /present/i.test(String((e.endDate as Record<string, unknown>)?.text ?? ""))) || exp[0];
  const slug = companySlugFromUrl((current?.companyLinkedinUrl as string) || (current?.companyLink as string) || null);
  const ctxMap = slug ? await getCompanyContexts([slug]).catch(() => new Map()) : new Map();
  const employerContext = slug ? companyContextLine(ctxMap.get(slug)) : null;
  const jd = role.jd || {};
  const jdText =
    [
      jd.about,
      jd.doing?.length ? `Responsibilities:\n- ${jd.doing.join("\n- ")}` : null,
      jd.needs?.length ? `Requirements:\n- ${jd.needs.join("\n- ")}` : null,
      jd.bonus?.length ? `Nice to have:\n- ${jd.bonus.join("\n- ")}` : null,
    ]
      .filter(Boolean)
      .join("\n\n") || (role.matching_profile?.must_haves || []).join("; ");

  return judgeVerdict({
    roleTitle: role.title,
    jdText,
    skills: (role.skills || []).map((s) => ({ skill: s.skill, mustHave: !!s.must_have, alternates: s.alternates || [] })),
    minYears: role.matching_profile?.min_years ?? null,
    targetedCompanies: (role.target_companies || []).map((t) => t?.name || "").filter(Boolean),
    employerContext,
    candidateName: row.person?.name || "Candidate",
    profileText: linkedinProfileText(profile),
    resumeText,
    factsBlock: formatFacts(facts),
    careerYears: facts.careerYears,
    model,
    timeoutMs: 40_000,
  });
}

/** Run the proposed verdict for rows that lack one for this model, within a
 *  time budget. Call again until remaining is 0. */
export async function runEval(
  orgId: string,
  model: string,
  opts: { limit: number; deadline: number }
): Promise<{ done: number; failed: number; remaining: number }> {
  const all = await rest<DbRow[]>(
    `verdict_evals?organization_id=eq.${orgId}&select=id,kind,subject_id,application_id,org_role_id,person,old,runs,votes,created_at&order=kind.desc,created_at.asc`
  );
  const todo = all.filter((r) => !(r.runs || {})[model]);
  const batch = todo.slice(0, opts.limit);
  const roleIds = [...new Set(batch.map((r) => r.org_role_id))];
  const roles = roleIds.length
    ? await rest<RoleRow[]>(`org_roles?id=in.(${roleIds.join(",")})&select=id,title,tech_stack,jd,skills,matching_profile,target_companies`)
    : [];
  const roleOf = new Map(roles.map((r) => [r.id, r]));
  let done = 0;
  let failed = 0;
  await mapLimit(batch, 4, async (row) => {
    if (Date.now() > opts.deadline) return;
    const role = roleOf.get(row.org_role_id);
    if (!role) {
      failed++;
      return;
    }
    const v = await verdictFor(row, role, model).catch(() => null);
    if (!v) {
      failed++;
      return;
    }
    const res = await sbRest(`verdict_evals?id=eq.${row.id}`, {
      method: "PATCH",
      body: JSON.stringify({ runs: { ...(row.runs || {}), [model]: v } }),
      prefer: "return=minimal",
    });
    if (res.ok) done++;
    else failed++;
  });
  return { done, failed, remaining: todo.length - done };
}

export async function voteEval(orgId: string, id: string, model: string, vote: "new" | "old" | "neither"): Promise<boolean> {
  const [row] = await rest<{ votes: Record<string, string> | null }[]>(
    `verdict_evals?id=eq.${id}&organization_id=eq.${orgId}&select=votes`
  );
  if (!row) return false;
  const res = await sbRest(`verdict_evals?id=eq.${id}&organization_id=eq.${orgId}`, {
    method: "PATCH",
    body: JSON.stringify({ votes: { ...(row.votes || {}), [model]: vote } }),
    prefer: "return=minimal",
  });
  return res.ok;
}

/** Chat models the key can use, for the page's picker. */
export async function listModels(): Promise<string[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return [];
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const data = (await res.json()) as { data: { id: string }[] };
  return data.data
    .map((m) => m.id)
    .filter(
      (id) =>
        /^(gpt-|o\d)/.test(id) &&
        !/(realtime|audio|tts|transcribe|image|embedding|moderation|search|instruct|dall|whisper|codex|-\d{4}-\d{2}-\d{2}$|-\d{4}$)/.test(id)
    )
    .sort();
}

export const DEFAULT_MODEL = process.env.SOURCING_JUDGE_MODEL || "gpt-4o";
