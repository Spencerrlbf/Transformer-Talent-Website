// Sourcing run state machine. A run moves previewed → importing → ranking →
// screening → done, with every stage resumable: advanceRun() does as much
// work as fits its time budget and returns, so the same engine runs from a
// CLI loop, a worker, or a polled API route within serverless limits.
//
// Cost caps (AGENTS.md): imports are hard-capped at MAX_IMPORT matches —
// broader searches are refused at preview time, never silently truncated.
// Screening is capped per run by screen_target.
import { sbRest, sbRpc } from "../supabase";
import { embedTexts } from "../roles-pipeline";
import { computeFacts, formatFacts } from "../facts";
import { harvestToExperiences, linkedinProfileText } from "../spine";
import { screenRolesWithCache } from "../screening";
import { splitStack } from "../scorecard";
import { clientTag, clientReason, TAG_LABEL } from "../client-reason";
import { searchLeadsPage, previewLeadCount, getFullProfile, providerMode, type Lead, type LeadSearchQuery } from "./harvest";
import { profileToFields, sourcedEmbedText } from "./import";

export const MAX_IMPORT = 2000; // above this: refuse and ask to narrow
export const DEFAULT_SCREEN_TARGET = 50;
export const MAX_SCREEN_TARGET = 200;
const PAGE_SIZE = 25;
// Harvest caps CONCURRENT requests by plan (Free 1 … Business 40); no
// per-minute limits. Keep the default low for the basic plan.
const HARVEST_CONCURRENCY = Math.max(1, parseInt(process.env.HARVEST_CONCURRENCY || "2", 10) || 2);
// LLM screening concurrency: bursts trip OpenAI rate limits, which the
// engine surfaces as empty verdicts — keep low, tune via env once limits rise.
const SCREEN_CONCURRENCY = Math.max(1, parseInt(process.env.SOURCING_SCREEN_CONCURRENCY || "2", 10) || 2);
// Circuit breaker: consecutive batches where every screen fails mean a
// systemic problem (rate limits, outage) — stop instead of churning LLM
// spend down the ranked list.
const MAX_ALLFAIL_BATCHES = 3;

// Our unit costs (margin analysis in usage_events; client credits are Task 6).
const COST_SEARCH_PAGE = 0.1;
const COST_FULL_PROFILE = 0.004;

export interface SourcingRun {
  id: string;
  organization_id: string;
  org_role_id: string;
  search_params: LeadSearchQuery;
  status: "previewed" | "importing" | "ranking" | "screening" | "done" | "failed" | "cancelled";
  match_estimate: number | null;
  pages_fetched: number;
  imported_count: number;
  duplicate_count: number;
  screened_count: number;
  screen_target: number;
}

async function rest<T>(path: string, init: Parameters<typeof sbRest>[1] = {}): Promise<T> {
  const res = await sbRest(path, init);
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path.split("?")[0]} ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    })
  );
  return results;
}

async function recordUsage(
  organizationId: string,
  runId: string | null,
  eventType: "search_preview" | "search_page" | "profile_import" | "deep_screen",
  quantity: number,
  unitCostUsd: number | null,
  meta?: Record<string, unknown>
) {
  if (quantity <= 0) return;
  await sbRest("usage_events", {
    method: "POST",
    body: JSON.stringify({
      organization_id: organizationId,
      run_id: runId,
      event_type: eventType,
      quantity,
      unit_cost_usd: unitCostUsd,
      credits: eventType === "profile_import" ? quantity : 0,
      meta: meta ?? null,
    }),
    prefer: "return=minimal",
  }).catch(() => {}); // metering must never kill a run
}

async function patchRun(runId: string, patch: Record<string, unknown>) {
  await rest(`sourcing_runs?id=eq.${runId}`, {
    method: "PATCH",
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    prefer: "return=minimal",
  });
}

// ---------- preview + create ----------

export type PreviewResult =
  | { ok: true; total: number; sampleNames: string[] }
  | { ok: false; code: "too_broad" | "no_matches" | "unknown_total"; total: number | null };

/** One metered page-1 request → match count + guardrail verdict. */
export async function previewSearch(organizationId: string, query: LeadSearchQuery): Promise<PreviewResult> {
  const { total, sample } = await previewLeadCount(query);
  await recordUsage(organizationId, null, "search_preview", 1, COST_SEARCH_PAGE, { query });
  if (total == null) return { ok: false, code: "unknown_total", total: null };
  if (total === 0) return { ok: false, code: "no_matches", total: 0 };
  if (total > MAX_IMPORT) return { ok: false, code: "too_broad", total };
  return { ok: true, total, sampleNames: sample.map((s) => s.fullName) };
}

/** Create a run in 'previewed'. Refuses too-broad searches — never truncates. */
export async function createRun(args: {
  organizationId: string;
  orgRoleId: string;
  createdBy?: string | null;
  query: LeadSearchQuery;
  matchEstimate: number; // from previewSearch — already guardrail-checked
  screenTarget?: number;
}): Promise<SourcingRun> {
  if (args.matchEstimate > MAX_IMPORT) throw new Error(`search too broad (${args.matchEstimate} > ${MAX_IMPORT})`);
  const [run] = await rest<SourcingRun[]>("sourcing_runs", {
    method: "POST",
    body: JSON.stringify({
      organization_id: args.organizationId,
      org_role_id: args.orgRoleId,
      created_by: args.createdBy ?? null,
      search_params: args.query,
      status: "previewed",
      match_estimate: args.matchEstimate,
      screen_target: Math.min(Math.max(args.screenTarget ?? DEFAULT_SCREEN_TARGET, 0), MAX_SCREEN_TARGET),
    }),
    prefer: "return=representation",
  });
  return run;
}

// ---------- stage: importing ----------

async function importOnePage(run: SourcingRun): Promise<{ lastPage: boolean }> {
  const page = run.pages_fetched + 1;
  const result = await searchLeadsPage(run.search_params, page);
  await recordUsage(run.organization_id, run.id, "search_page", 1, COST_SEARCH_PAGE, { page });

  // Pool dedupe BEFORE paying for profiles: member id first, username fallback.
  const memberIds = result.leads.map((l) => l.memberId).filter((m): m is string => !!m);
  const usernames = result.leads.map((l) => l.linkedinUsername).filter((u): u is string => !!u);
  const existing = await rest<{ id: string; linkedin_member_id: string | null; linkedin_username: string | null }[]>(
    `sourced_candidates?organization_id=eq.${run.organization_id}` +
      `&or=(${[
        memberIds.length ? `linkedin_member_id.in.(${memberIds.map((m) => `"${m}"`).join(",")})` : null,
        usernames.length ? `linkedin_username.in.(${usernames.map((u) => `"${u}"`).join(",")})` : null,
      ].filter(Boolean).join(",")})&select=id,linkedin_member_id,linkedin_username`
  ).catch(() => [] as { id: string; linkedin_member_id: string | null; linkedin_username: string | null }[]);
  const byMember = new Map(existing.filter((e) => e.linkedin_member_id).map((e) => [e.linkedin_member_id!, e.id]));
  const byUsername = new Map(existing.filter((e) => e.linkedin_username).map((e) => [e.linkedin_username!, e.id]));

  const fresh: Lead[] = [];
  const dupes: { lead: Lead; existingId: string }[] = [];
  for (const lead of result.leads) {
    const existingId =
      (lead.memberId && byMember.get(lead.memberId)) ||
      (lead.linkedinUsername && byUsername.get(lead.linkedinUsername)) ||
      null;
    if (existingId) dupes.push({ lead, existingId });
    else fresh.push(lead);
  }

  // Fetch full profiles for fresh leads only (the paid part).
  const fetched = await mapLimit(fresh, HARVEST_CONCURRENCY, async (lead) => {
    const profile = await getFullProfile(lead.linkedinUrl).catch(() => null);
    return { lead, profile };
  });
  const importable = fetched.filter((f) => f.profile);
  await recordUsage(run.organization_id, run.id, "profile_import", importable.length, COST_FULL_PROFILE, { page });

  // Embed in one batch, insert candidates, then memberships.
  const texts = importable.map((f) => sourcedEmbedText(f.profile!) || `${f.lead.fullName} ${f.lead.headline ?? ""}`);
  const vectors = texts.length ? await embedTexts(texts) : [];
  const inserted = importable.length
    ? await rest<{ id: string }[]>(
        `sourced_candidates?on_conflict=organization_id,linkedin_username`,
        {
          method: "POST",
          body: JSON.stringify(
            importable.map((f, i) => ({
              organization_id: run.organization_id,
              first_run_id: run.id,
              linkedin_member_id: f.lead.memberId,
              ...profileToFields(f.profile!),
              profile: f.profile,
              embedding: JSON.stringify(vectors[i]),
            }))
          ),
          prefer: "resolution=merge-duplicates,return=representation",
        }
      )
    : [];

  const memberships = [
    ...inserted.map((row, i) => ({
      run_id: run.id,
      sourced_candidate_id: row.id,
      organization_id: run.organization_id,
      source_page: page,
      source_position: result.leads.indexOf(importable[i].lead),
    })),
    ...dupes.map((d) => ({
      run_id: run.id,
      sourced_candidate_id: d.existingId,
      organization_id: run.organization_id,
      source_page: page,
      source_position: result.leads.indexOf(d.lead),
    })),
  ];
  if (memberships.length) {
    await rest(`sourcing_run_candidates?on_conflict=run_id,sourced_candidate_id`, {
      method: "POST",
      body: JSON.stringify(memberships),
      prefer: "resolution=ignore-duplicates,return=minimal",
    });
  }

  const lastPage =
    (result.totalPages != null && page >= result.totalPages) ||
    result.leads.length < PAGE_SIZE ||
    page >= Math.ceil(MAX_IMPORT / PAGE_SIZE);
  await patchRun(run.id, {
    pages_fetched: page,
    imported_count: run.imported_count + inserted.length,
    duplicate_count: run.duplicate_count + dupes.length,
    ...(run.status === "previewed" ? {} : {}),
  });
  run.pages_fetched = page;
  run.imported_count += inserted.length;
  run.duplicate_count += dupes.length;
  return { lastPage };
}

// ---------- stage: ranking ----------

async function rankRun(run: SourcingRun): Promise<void> {
  // Embedding channel in SQL (vectors never leave the DB).
  await sbRpc<number>("rank_sourcing_run_embed", { p_run_id: run.id });

  // Keyword channel in TS against the role's stack + must-haves.
  const [role] = await rest<{ tech_stack: string | null; matching_profile: { must_haves?: string[] } | null; title: string }[]>(
    `org_roles?id=eq.${run.org_role_id}&select=tech_stack,matching_profile,title`
  );
  const terms = [
    ...new Set(
      [...splitStack(role?.tech_stack), ...(role?.matching_profile?.must_haves || [])]
        .flatMap((t) => splitStack(t))
        .map((t) => t.toLowerCase())
        .filter((t) => t.length >= 2)
    ),
  ].slice(0, 24);

  const rows = await rest<
    { id: string; embed_score: number | null; sourced_candidate_id: string;
      sourced_candidates: { skills: string[] | null; current_title: string | null; headline: string | null } }[]
  >(
    `sourcing_run_candidates?run_id=eq.${run.id}&select=id,embed_score,sourced_candidate_id,` +
      `sourced_candidates(skills,current_title,headline)&limit=${MAX_IMPORT + 500}`
  );

  const scored = rows.map((r) => {
    const c = r.sourced_candidates;
    const haystack = [(c?.skills || []).join(" "), c?.current_title, c?.headline]
      .filter(Boolean).join(" ").toLowerCase();
    const hits = terms.filter((t) => haystack.includes(t)).length;
    const keyword = terms.length ? hits / terms.length : 0;
    const embedScore = r.embed_score ?? 0;
    return { id: r.id, keyword_score: keyword, rank_score: 0.6 * embedScore + 0.4 * keyword };
  });
  scored.sort((a, b) => b.rank_score - a.rank_score);

  // Chunked writes: rank + scores per membership row.
  for (let i = 0; i < scored.length; i += 200) {
    await Promise.all(
      scored.slice(i, i + 200).map((s, j) =>
        rest(`sourcing_run_candidates?id=eq.${s.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            keyword_score: s.keyword_score,
            rank_score: s.rank_score,
            rank: i + j + 1,
          }),
          prefer: "return=minimal",
        })
      )
    );
  }
}

// ---------- stage: screening ----------

async function screenBatch(
  run: SourcingRun,
  batchSize: number
): Promise<{ remaining: number; attempted: number; succeeded: number }> {
  const [role] = await rest<{ external_id: string; tech_stack: string | null }[]>(
    `org_roles?id=eq.${run.org_role_id}&select=external_id,tech_stack`
  );
  const limit = Math.min(batchSize, Math.max(0, run.screen_target - run.screened_count));
  if (limit <= 0) return { remaining: 0, attempted: 0, succeeded: 0 };
  // Screenable = fresh rows OR failed rows with retries left (max 3
  // attempts) — one rank-ordered query, so a flaky LLM response on the #1
  // candidate retries before rank-75 gets its first look.
  const todo = await rest<
    { id: string; screen_attempts: number; sourced_candidate_id: string;
      sourced_candidates: { profile: Record<string, unknown> | null; skills: string[] | null; full_name: string | null } }[]
  >(
    `sourcing_run_candidates?run_id=eq.${run.id}&hidden=eq.false&rank=not.is.null` +
      `&or=(screen_status.eq.none,and(screen_status.eq.failed,screen_attempts.lt.3))` +
      `&order=rank.asc&limit=${limit}` +
      `&select=id,screen_attempts,sourced_candidate_id,sourced_candidates(profile,skills,full_name)`
  );
  if (!todo.length) return { remaining: 0, attempted: 0, succeeded: 0 };

  await Promise.all(todo.map((t) =>
    rest(`sourcing_run_candidates?id=eq.${t.id}`, {
      method: "PATCH",
      body: JSON.stringify({ screen_status: "pending", screen_attempts: t.screen_attempts + 1 }),
      prefer: "return=minimal",
    })
  ));

  const stackTerms = splitStack(role?.tech_stack).slice(0, 20);
  let done = 0;
  await mapLimit(todo, SCREEN_CONCURRENCY, async (t) => {
    try {
      const profile = t.sourced_candidates?.profile;
      if (!profile) throw new Error("no stored profile");
      const skills = t.sourced_candidates?.skills || [];
      const expRows = harvestToExperiences(profile);
      const facts = computeFacts(expRows, stackTerms, skills, (profile as Record<string, unknown>).education ?? null);
      const evidence = [
        linkedinProfileText(profile).slice(0, 4000),
        `FACTS (computed from dated position history):\n${formatFacts(facts)}`,
      ].join("\n\n");
      const screenOnce = () =>
        screenRolesWithCache({
          candidateId: null, // sourced candidates live in their own pool, not the site spine
          evidence,
          cacheKeyText: JSON.stringify(profile),
          jobIds: [role.external_id],
          facts,
          source: "precompute",
          profileSkills: skills,
          organizationId: run.organization_id,
        });
      // Rate-limited LLM calls surface as empty verdicts — one paced retry.
      let [verdict] = await screenOnce();
      if (!verdict) {
        await new Promise((r) => setTimeout(r, 4000));
        [verdict] = await screenOnce();
      }
      if (!verdict) throw new Error("screening returned no verdict (after retry)");
      const sc = verdict.scorecard;
      await rest(`sourcing_run_candidates?id=eq.${t.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          screen_status: "done",
          verdict: verdict ?? null,
          tag: sc ? clientTag(sc) : null,
          reason: sc ? clientReason(sc) : null,
          screened_at: new Date().toISOString(),
        }),
        prefer: "return=minimal",
      });
      done++;
    } catch (err) {
      await rest(`sourcing_run_candidates?id=eq.${t.id}`, {
        method: "PATCH",
        body: JSON.stringify({ screen_status: "failed" }),
        prefer: "return=minimal",
      }).catch(() => {});
      console.error(`screen failed for membership ${t.id}:`, (err as Error).message);
    }
  });
  await recordUsage(run.organization_id, run.id, "deep_screen", done, null);
  run.screened_count += done;
  await patchRun(run.id, { screened_count: run.screened_count });
  const remainingTarget = Math.max(0, run.screen_target - run.screened_count);
  if (!remainingTarget) return { remaining: 0, attempted: todo.length, succeeded: done };
  // Anything still screenable? Fresh rows, or failed rows with retries left.
  const more = await rest<{ id: string }[]>(
    `sourcing_run_candidates?run_id=eq.${run.id}&hidden=eq.false&rank=not.is.null` +
      `&or=(screen_status.eq.none,and(screen_status.eq.failed,screen_attempts.lt.3))&limit=1&select=id`
  );
  return { remaining: more.length ? remainingTarget : 0, attempted: todo.length, succeeded: done };
}

// ---------- the advance loop ----------

export interface AdvanceResult {
  status: SourcingRun["status"];
  done: boolean;
  pagesFetched: number;
  imported: number;
  duplicates: number;
  screened: number;
}

/**
 * Advance a run within a time budget. Callers loop (CLI/worker) or poll
 * (API route) until done:true. Safe to call concurrently-ish: stages are
 * idempotent (page cursor, upserts, screen_status flags).
 */
export async function advanceRun(runId: string, budgetMs = 45_000): Promise<AdvanceResult> {
  const deadline = Date.now() + budgetMs;
  const [run] = await rest<SourcingRun[]>(`sourcing_runs?id=eq.${runId}&select=*`);
  if (!run) throw new Error(`run ${runId} not found`);

  try {
    if (run.status === "previewed") {
      await patchRun(run.id, { status: "importing", started_at: new Date().toISOString() });
      run.status = "importing";
    }

    if (run.status === "importing") {
      while (Date.now() < deadline) {
        const { lastPage } = await importOnePage(run);
        if (lastPage) {
          await patchRun(run.id, { status: "ranking" });
          run.status = "ranking";
          break;
        }
      }
    }

    if (run.status === "ranking" && Date.now() < deadline) {
      await rankRun(run);
      await patchRun(run.id, { status: "screening" });
      run.status = "screening";
    }

    if (run.status === "screening" && Date.now() < deadline) {
      let allFailBatches = 0;
      while (Date.now() < deadline) {
        const { remaining, attempted, succeeded } = await screenBatch(run, SCREEN_CONCURRENCY * 2);
        allFailBatches = attempted > 0 && succeeded === 0 ? allFailBatches + 1 : 0;
        if (allFailBatches >= MAX_ALLFAIL_BATCHES) {
          throw new Error(`screening circuit breaker: ${allFailBatches} consecutive all-fail batches`);
        }
        if (!remaining) {
          await patchRun(run.id, { status: "done", finished_at: new Date().toISOString() });
          run.status = "done";
          break;
        }
      }
    }
  } catch (err) {
    await patchRun(run.id, { status: "failed", error: String((err as Error).message).slice(0, 500) }).catch(() => {});
    throw err;
  }

  return {
    status: run.status,
    done: run.status === "done" || run.status === "failed" || run.status === "cancelled",
    pagesFetched: run.pages_fetched,
    imported: run.imported_count,
    duplicates: run.duplicate_count,
    screened: run.screened_count,
  };
}

export { providerMode, TAG_LABEL };
