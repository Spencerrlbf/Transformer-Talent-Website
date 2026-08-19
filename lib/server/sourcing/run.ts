// Sourcing run state machine, hardened per the adversarial design review.
//
// Guarantees:
// - Single driver: a DB-clock lease (claim/renew/release RPCs) owns the run;
//   every state write is FENCED on the lease/claim id, so a superseded
//   "zombie" driver's late writes land on nothing.
// - Bounded work: sourcing LLM calls are capped (~15s vs the apply flow's
//   90s), waves/pages/sub-batches start only when they provably fit the
//   remaining budget, and pauses are persisted (next_attempt_at), never
//   slept inside a serverless invocation.
// - Exactly-once billing: page commits are one atomic RPC (cursor CAS +
//   idempotent usage inserts + counts recomputed from ground truth).
// - Honest retries: attempts are charged only on REAL failures (junk model
//   output), never on infra kills or rate limits; rate-limited rows get a
//   persisted not-before time; orphaned rows heal to 'failed' (cap intact),
//   poison rows terminate via orphan_heals; the all-fail circuit breaker is
//   persisted on the run so it survives invocation boundaries.
// - Review-all: every imported candidate is screened (screen_target = the
//   run's membership count, set when ranking completes).
import crypto from "node:crypto";
import { sbRest, sbRpc } from "../supabase";
import { embedTexts } from "../roles-pipeline";
import { computeFacts, formatFacts } from "../facts";
import { harvestToExperiences, linkedinProfileText } from "../spine";
import { screenRolesWithCache } from "../screening";
import { splitStack } from "../scorecard";
import { clientTag, clientReason, TAG_LABEL } from "../client-reason";
import { searchLeadsPage, previewLeadCount, getFullProfile, providerMode, type Lead, type LeadSearchQuery } from "./harvest";
import { profileToFields, sourcedEmbedText } from "./import";

export const MAX_IMPORT = 2500; // Harvest's own per-query ceiling; above this: refuse and ask to narrow
const PAGE_SIZE = 25;
const HARVEST_CONCURRENCY = Math.max(1, parseInt(process.env.HARVEST_CONCURRENCY || "4", 10) || 4);
const SCREEN_CONCURRENCY = Math.max(1, parseInt(process.env.SOURCING_SCREEN_CONCURRENCY || "15", 10) || 15);
// Short LLM cap so a wave (2 sequential calls/row) provably fits the window.
const SCREEN_LLM_TIMEOUT_MS = Math.max(5_000, parseInt(process.env.SOURCING_LLM_TIMEOUT_MS || "15000", 10) || 15_000);
const WAVE_NEED_MS = 2 * SCREEN_LLM_TIMEOUT_MS + 5_000;
const IMPORT_SLICE_NEED_MS = 12_000;
const LEASE_TTL_SECS = Math.max(30, parseInt(process.env.SOURCING_LEASE_TTL || "90", 10) || 90);
const MAX_ALLFAIL_STREAK = 3;
const MAX_PAGE_ATTEMPTS = 6;
const MAX_ROW_ATTEMPTS = 3;

const COST_SEARCH_PAGE = 0.1;
const COST_FULL_PROFILE = 0.004;

/** Domain-terminal failure: the ONLY error class that marks a run failed. */
export class RunFailure extends Error {}

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
  allfail_streak: number;
  page_attempts: number;
  next_attempt_at: string | null;
  provider_mode?: string;
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

/** Lease-fenced run PATCH. Returns false when the lease was lost (0 rows). */
async function leasePatch(runId: string, leaseId: string, patch: Record<string, unknown>): Promise<boolean> {
  const rows = await rest<unknown[]>(
    `sourcing_runs?id=eq.${runId}&lease_id=eq.${leaseId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
      prefer: "return=representation",
    }
  );
  return rows.length > 0;
}

async function countRows(path: string): Promise<number> {
  const res = await sbRest(path, { method: "HEAD", headers: { Prefer: "count=exact", Range: "0-0" } });
  return parseInt((res.headers.get("content-range") || "/0").split("/")[1], 10) || 0;
}

async function recordUsage(
  organizationId: string,
  runId: string | null,
  eventType: "search_preview" | "deep_screen",
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
      credits: 0,
      meta: meta ?? null,
    }),
    prefer: "return=minimal",
  }).catch(() => {}); // metering must never kill a run
}

// ---------- preview + create ----------

export type PreviewResult =
  | { ok: true; total: number; sampleNames: string[] }
  | { ok: false; code: "too_broad" | "no_matches" | "unknown_total"; total: number | null };

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
  matchEstimate: number;
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
      screen_target: 0, // review-all: set to the membership count when ranking completes
      provider_mode: providerMode(),
    }),
    prefer: "return=representation",
  });
  return run;
}

// ---------- stage: importing ----------

type ImportResult = { lastPage: boolean; leaseLost: boolean; partial: boolean };

async function importOnePage(
  run: SourcingRun,
  leaseId: string,
  deadline: number
): Promise<ImportResult> {
  const page = run.pages_fetched + 1;

  // Stall detector: same page failing over and over is a doomed run, not
  // an infinite retry loop that re-pays Harvest every ~60s.
  const attempts = run.page_attempts + 1;
  if (attempts > MAX_PAGE_ATTEMPTS) {
    throw new RunFailure(`import stuck on page ${page} after ${run.page_attempts} attempts`);
  }
  if (!(await leasePatch(run.id, leaseId, { page_attempts: attempts }))) {
    return { lastPage: false, leaseLost: true, partial: false };
  }
  run.page_attempts = attempts;

  const result = await searchLeadsPage(run.search_params, page);

  // Pool dedupe BEFORE paying for profiles: member id first, username fallback.
  const memberIds = result.leads.map((l) => l.memberId).filter((m): m is string => !!m);
  const usernames = result.leads.map((l) => l.linkedinUsername).filter((u): u is string => !!u);
  const existing = result.leads.length
    ? await rest<{ id: string; linkedin_member_id: string | null; linkedin_username: string | null }[]>(
        `sourced_candidates?organization_id=eq.${run.organization_id}` +
          `&or=(${[
            memberIds.length ? `linkedin_member_id.in.(${memberIds.map((m) => `"${m}"`).join(",")})` : null,
            usernames.length ? `linkedin_username.in.(${usernames.map((u) => `"${u}"`).join(",")})` : null,
          ].filter(Boolean).join(",")})&select=id,linkedin_member_id,linkedin_username`
      ).catch(() => [] as { id: string; linkedin_member_id: string | null; linkedin_username: string | null }[])
    : [];
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

  // Dupes cost nothing — link them to the run immediately.
  if (dupes.length) {
    await rest(`sourcing_run_candidates?on_conflict=run_id,sourced_candidate_id`, {
      method: "POST",
      body: JSON.stringify(
        dupes.map((d) => ({
          run_id: run.id,
          sourced_candidate_id: d.existingId,
          organization_id: run.organization_id,
          source_page: page,
          source_position: result.leads.indexOf(d.lead),
        }))
      ),
      prefer: "resolution=ignore-duplicates,return=minimal",
    });
  }

  // Fresh leads in small sub-batches: fetch → embed → upsert, checkpointed,
  // so a killed invocation loses at most one sub-batch (already-inserted
  // rows become free dupes on the retry — never re-paid).
  const SLICE = Math.max(HARVEST_CONCURRENCY * 2, 6);
  for (let i = 0; i < fresh.length; i += SLICE) {
    if (Date.now() + IMPORT_SLICE_NEED_MS > deadline) {
      return { lastPage: false, leaseLost: false, partial: true };
    }
    const slice = fresh.slice(i, i + SLICE);
    const fetched = await mapLimit(slice, HARVEST_CONCURRENCY, async (lead) => ({
      lead,
      profile: await getFullProfile(lead.linkedinUrl).catch(() => null),
    }));
    const importable = fetched.filter((f) => f.profile);
    if (!importable.length) continue;
    const texts = importable.map((f) => sourcedEmbedText(f.profile!) || `${f.lead.fullName} ${f.lead.headline ?? ""}`);
    const vectors = await embedTexts(texts);
    const inserted = await rest<{ id: string }[]>(
      `sourced_candidates?on_conflict=organization_id,linkedin_username`,
      {
        method: "POST",
        body: JSON.stringify(
          importable.map((f, j) => ({
            organization_id: run.organization_id,
            first_run_id: run.id,
            linkedin_member_id: f.lead.memberId,
            ...profileToFields(f.profile!),
            profile: f.profile,
            embedding: JSON.stringify(vectors[j]),
          }))
        ),
        prefer: "resolution=merge-duplicates,return=representation",
      }
    );
    await rest(`sourcing_run_candidates?on_conflict=run_id,sourced_candidate_id`, {
      method: "POST",
      body: JSON.stringify(
        inserted.map((row, j) => ({
          run_id: run.id,
          sourced_candidate_id: row.id,
          organization_id: run.organization_id,
          source_page: page,
          source_position: result.leads.indexOf(importable[j].lead),
        }))
      ),
      prefer: "resolution=ignore-duplicates,return=minimal",
    });
  }

  // Billable imports for this page, from ground truth (covers partial-page
  // retries: rows inserted by an earlier killed attempt still belong to
  // this page and this run, and are billed exactly once by the commit RPC's
  // idempotent insert). PostgREST can't subquery, so count via the ids.
  const pageMembers = await rest<{ sourced_candidate_id: string }[]>(
    `sourcing_run_candidates?run_id=eq.${run.id}&source_page=eq.${page}&select=sourced_candidate_id`
  );
  let billable = 0;
  for (let i = 0; i < pageMembers.length; i += 100) {
    const ids = pageMembers.slice(i, i + 100).map((m) => m.sourced_candidate_id);
    billable += await countRows(
      `sourced_candidates?id=in.(${ids.join(",")})&first_run_id=eq.${run.id}`
    );
  }

  // Atomic commit: cursor CAS + idempotent usage rows + counts from truth.
  const committed = await sbRpc<boolean>("commit_import_page", {
    p_run_id: run.id,
    p_lease_id: leaseId,
    p_page: page,
    p_org: run.organization_id,
    p_import_qty: billable,
    p_search_cost: COST_SEARCH_PAGE,
    p_import_unit_cost: COST_FULL_PROFILE,
  });
  if (!committed) return { lastPage: false, leaseLost: true, partial: false };
  run.pages_fetched = page;
  run.page_attempts = 0;

  const lastPage =
    (result.totalPages != null && page >= result.totalPages) ||
    result.leads.length < PAGE_SIZE ||
    page >= Math.ceil(MAX_IMPORT / PAGE_SIZE);
  return { lastPage, leaseLost: false, partial: false };
}

// ---------- stage: ranking ----------

async function rankRun(run: SourcingRun): Promise<void> {
  // Embedding channel in SQL (vectors never leave the DB).
  await sbRpc<number>("rank_sourcing_run_embed", { p_run_id: run.id });

  const [role] = await rest<{ tech_stack: string | null; matching_profile: { must_haves?: string[] } | null }[]>(
    `org_roles?id=eq.${run.org_role_id}&select=tech_stack,matching_profile`
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
    { id: string; embed_score: number | null;
      sourced_candidates: { skills: string[] | null; current_title: string | null; headline: string | null } }[]
  >(
    `sourcing_run_candidates?run_id=eq.${run.id}&select=id,embed_score,` +
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

  // One set-based write instead of one PATCH per row.
  await sbRpc<number>("apply_ranks", {
    p_run_id: run.id,
    p_ranks: scored.map((s, i) => ({ id: s.id, rank: i + 1, keyword_score: s.keyword_score, rank_score: s.rank_score })),
  });
}

// ---------- stage: screening ----------

type RowOutcome = "ok" | "transient" | "junk" | "lost" | "fatal";
type ClaimedRow = {
  id: string; screen_attempts: number; sourced_candidate_id: string;
};

/** Fenced row completion. Returns false if the claim no longer holds. */
async function fencedRowPatch(rowId: string, claimId: string, patch: Record<string, unknown>): Promise<boolean> {
  const rows = await rest<unknown[]>(
    `sourcing_run_candidates?id=eq.${rowId}&screen_claim_id=eq.${claimId}&screen_status=eq.pending`,
    { method: "PATCH", body: JSON.stringify(patch), prefer: "return=representation" }
  );
  return rows.length > 0;
}

const jitter = (baseMs: number) => baseMs + Math.floor(Math.random() * baseMs * 0.5);

async function screenOneRow(
  row: ClaimedRow,
  role: { external_id: string; tech_stack: string | null },
  run: SourcingRun,
  leaseId: string
): Promise<{ outcome: RowOutcome; retryAfterMs?: number }> {
  let llmErr: { status: number; code?: string; retryAfter?: string } | null = null;
  try {
    const [cand] = await rest<{ profile: Record<string, unknown> | null; skills: string[] | null }[]>(
      `sourced_candidates?id=eq.${row.sourced_candidate_id}&select=profile,skills`
    );
    const profile = cand?.profile;
    if (!profile) {
      // No stored profile = nothing to review, ever. Terminal, honestly.
      await fencedRowPatch(row.id, leaseId, {
        screen_status: "failed", screen_attempts: MAX_ROW_ATTEMPTS, screen_claim_id: null,
      });
      return { outcome: "junk" };
    }
    const skills = cand?.skills || [];
    const stackTerms = splitStack(role.tech_stack).slice(0, 20);
    const expRows = harvestToExperiences(profile);
    const facts = computeFacts(expRows, stackTerms, skills, (profile as Record<string, unknown>).education ?? null);
    const evidence = [
      linkedinProfileText(profile).slice(0, 4000),
      `FACTS (computed from dated position history):\n${formatFacts(facts)}`,
    ].join("\n\n");

    const [verdict] = await screenRolesWithCache({
      candidateId: null,
      evidence,
      cacheKeyText: JSON.stringify(profile),
      jobIds: [role.external_id],
      facts,
      source: "precompute",
      profileSkills: skills,
      organizationId: run.organization_id,
      llmTimeoutMs: SCREEN_LLM_TIMEOUT_MS,
      onLLMError: (info) => { llmErr = info; },
    });

    if (verdict) {
      const sc = verdict.scorecard;
      const landed = await fencedRowPatch(row.id, leaseId, {
        screen_status: "done",
        verdict,
        tag: sc ? clientTag(sc) : null,
        reason: sc ? clientReason(sc) : null,
        screened_at: new Date().toISOString(),
        screen_claim_id: null,
      });
      return { outcome: landed ? "ok" : "lost" };
    }

    const err = llmErr as { status: number; code?: string; retryAfter?: string } | null;
    // Quota-dead / auth-dead: grinding 2500 rows x 3 attempts helps no one.
    if (err && (err.status === 401 || err.status === 403 || err.code === "insufficient_quota")) {
      throw new RunFailure(`LLM key rejected (${err.status}${err.code ? ` ${err.code}` : ""})`);
    }
    if (err && (err.status === 429 || err.status >= 500)) {
      // Rate limit / upstream blip: NOT the row's fault — no attempt charged.
      const retryMs = err.retryAfter ? Math.min(parseInt(err.retryAfter, 10) * 1000 || 30_000, 120_000) : jitter(30_000);
      await fencedRowPatch(row.id, leaseId, {
        screen_status: "failed",
        screen_next_attempt_at: new Date(Date.now() + retryMs).toISOString(),
        screen_claim_id: null,
      });
      return { outcome: "transient", retryAfterMs: retryMs };
    }
    // Junk model output: charge the attempt, brief pause before retry.
    await fencedRowPatch(row.id, leaseId, {
      screen_status: "failed",
      screen_attempts: row.screen_attempts + 1,
      screen_next_attempt_at: new Date(Date.now() + jitter(8_000)).toISOString(),
      screen_claim_id: null,
    });
    return { outcome: "junk" };
  } catch (err) {
    if (err instanceof RunFailure) throw err;
    // Timeouts / aborts / transport errors: transient, no attempt charged.
    await fencedRowPatch(row.id, leaseId, {
      screen_status: "failed",
      screen_next_attempt_at: new Date(Date.now() + jitter(20_000)).toISOString(),
      screen_claim_id: null,
    }).catch(() => {});
    return { outcome: "transient" };
  }
}

// ---------- the advance loop ----------

export interface AdvanceResult {
  status: SourcingRun["status"] | "busy";
  done: boolean;
  busy?: boolean;
  retryAfterMs?: number;
  pagesFetched: number;
  imported: number;
  duplicates: number;
  screened: number;
  screenTarget: number;
  error?: string;
}

function resultFrom(run: SourcingRun, extra: Partial<AdvanceResult> = {}): AdvanceResult {
  return {
    status: run.status,
    done: run.status === "done" || run.status === "failed" || run.status === "cancelled",
    pagesFetched: run.pages_fetched,
    imported: run.imported_count,
    duplicates: run.duplicate_count,
    screened: run.screened_count,
    screenTarget: run.screen_target,
    ...extra,
  };
}

/**
 * Advance a run within a time budget. Drivers (browser poll, resumer, CLI)
 * loop until done. Claim-or-busy, fenced writes throughout; transient
 * errors leave the run active and rethrow — ONLY RunFailure marks it failed.
 */
export async function advanceRun(runId: string, budgetMs = 50_000): Promise<AdvanceResult> {
  const deadline = Date.now() + budgetMs;
  const leaseId = crypto.randomUUID();

  const claimed = await sbRpc<SourcingRun[]>("claim_run_lease", {
    p_run_id: runId, p_lease_id: leaseId, p_ttl_secs: LEASE_TTL_SECS,
  });
  if (!claimed.length) {
    // Someone else is driving. Report their progress.
    const [run] = await rest<SourcingRun[]>(`sourcing_runs?id=eq.${runId}&select=*`);
    if (!run) throw new Error(`run ${runId} not found`);
    return resultFrom(run, { busy: true, status: "busy" });
  }
  const run = claimed[0];

  const release = () =>
    sbRpc<boolean>("release_run_lease", { p_run_id: runId, p_lease_id: leaseId }).catch(() => {});

  if (run.status === "done" || run.status === "failed" || run.status === "cancelled") {
    await release();
    return resultFrom(run);
  }
  // Mode fence: a mock-created run (preview/CLI test) must never be driven
  // by a live-mode process — that would turn a demo into real spend.
  if ((run.provider_mode ?? "live") !== providerMode()) {
    await release();
    return resultFrom(run, { busy: true, error: `provider mode mismatch (run: ${run.provider_mode}, driver: ${providerMode()})` });
  }
  if (run.next_attempt_at && new Date(run.next_attempt_at).getTime() > Date.now()) {
    await release();
    return resultFrom(run, {
      busy: true,
      retryAfterMs: new Date(run.next_attempt_at).getTime() - Date.now(),
    });
  }

  // Renew the lease continuously so a live driver can never be superseded
  // mid-work; a failed renewal flips leaseLost and everything stops cleanly.
  // The renewer has a LIFESPAN (2x budget): a driver whose main work hangs
  // (e.g. a socket killed by machine sleep) must eventually lose its lease
  // instead of heartbeating as a zombie while making no progress.
  let leaseLost = false;
  const renewerDies = Date.now() + budgetMs * 2;
  const renewer = setInterval(() => {
    if (Date.now() > renewerDies) { leaseLost = true; clearInterval(renewer); return; }
    sbRpc<boolean>("renew_run_lease", { p_run_id: runId, p_lease_id: leaseId, p_ttl_secs: LEASE_TTL_SECS })
      .then((ok) => { if (!ok) leaseLost = true; })
      .catch(() => {});
  }, Math.min(20_000, (LEASE_TTL_SECS * 1000) / 3));

  try {
    if (run.status === "previewed") {
      if (!(await leasePatch(run.id, leaseId, { status: "importing", started_at: new Date().toISOString() }))) {
        return resultFrom(run, { busy: true });
      }
      run.status = "importing";
    }

    if (run.status === "importing") {
      while (!leaseLost && Date.now() + IMPORT_SLICE_NEED_MS < deadline) {
        const r = await importOnePage(run, leaseId, deadline);
        if (r.leaseLost) { leaseLost = true; break; }
        if (r.partial) break; // durable progress made; next invocation resumes the page
        if (r.lastPage) {
          await leasePatch(run.id, leaseId, { status: "ranking" });
          run.status = "ranking";
          // Fresh invocation for ranking — full budget for the big rank write.
          return resultFrom(run);
        }
      }
    }

    if (run.status === "ranking" && !leaseLost && Date.now() + 10_000 < deadline) {
      await rankRun(run);
      const total = await countRows(`sourcing_run_candidates?run_id=eq.${run.id}&select=id`);
      if (await leasePatch(run.id, leaseId, { status: "screening", screen_target: total })) {
        run.status = "screening";
        run.screen_target = total;
      }
      return resultFrom(run);
    }

    if (run.status === "screening" && !leaseLost) {
      // Heal rows orphaned by dead drivers (fenced: never touches our claims).
      await sbRpc<number>("heal_orphan_rows", { p_run_id: run.id, p_lease_id: leaseId });

      const [role] = await rest<{ external_id: string; tech_stack: string | null }[]>(
        `org_roles?id=eq.${run.org_role_id}&select=external_id,tech_stack`
      );
      if (!role) throw new RunFailure("role vanished");

      // The FIRST wave always runs regardless of budget — a caller with a
      // budget smaller than a wave must make progress, not silently no-op
      // forever. (The Vercel route's budget exceeds a wave, so this only
      // matters for CLI/worker callers and misconfiguration.)
      let firstWave = true;
      while (!leaseLost && (firstWave || Date.now() + WAVE_NEED_MS < deadline)) {
        firstWave = false;
        const rows = await sbRpc<ClaimedRow[]>("claim_screen_rows", {
          p_run_id: run.id, p_lease_id: leaseId, p_limit: SCREEN_CONCURRENCY,
        });

        if (!rows.length) {
          const screenableEver = await countRows(
            `sourcing_run_candidates?run_id=eq.${run.id}&hidden=eq.false&rank=not.is.null` +
              `&screen_status=in.(none,failed)&screen_attempts=lt.${MAX_ROW_ATTEMPTS}&select=id`
          );
          const stillPending = await countRows(
            `sourcing_run_candidates?run_id=eq.${run.id}&screen_status=eq.pending&select=id`
          );
          if (screenableEver === 0 && stillPending === 0) {
            const screened = await countRows(
              `sourcing_run_candidates?run_id=eq.${run.id}&screen_status=eq.done&select=id`
            );
            await leasePatch(run.id, leaseId, {
              status: "done", finished_at: new Date().toISOString(), screened_count: screened,
            });
            run.status = "done";
            run.screened_count = screened;
            return resultFrom(run);
          }
          // Everything screenable is paced into the future — come back then.
          return resultFrom(run, { busy: true, retryAfterMs: 15_000 });
        }

        const outcomes = await mapLimit(rows, SCREEN_CONCURRENCY, (row) =>
          screenOneRow(row, role, run, leaseId)
        );
        const ok = outcomes.filter((o) => o.outcome === "ok").length;
        const transient = outcomes.filter((o) => o.outcome === "transient").length;
        await recordUsage(run.organization_id, run.id, "deep_screen", ok, null);

        const screened = await countRows(
          `sourcing_run_candidates?run_id=eq.${run.id}&screen_status=eq.done&select=id`
        );
        run.screened_count = screened;

        // Persisted circuit breaker: survives invocation boundaries.
        const streak = ok === 0 && rows.length > 0 ? run.allfail_streak + 1 : 0;
        if (!(await leasePatch(run.id, leaseId, { screened_count: screened, allfail_streak: streak }))) {
          leaseLost = true; break;
        }
        run.allfail_streak = streak;
        if (streak >= MAX_ALLFAIL_STREAK) {
          throw new RunFailure(`screening circuit breaker: ${streak} consecutive all-fail waves`);
        }

        // Systemic rate limiting: persist the pause, never sleep in-function.
        if (transient > rows.length / 2) {
          const retryMs = Math.max(...outcomes.map((o) => o.retryAfterMs ?? 0), 30_000);
          await leasePatch(run.id, leaseId, {
            next_attempt_at: new Date(Date.now() + retryMs).toISOString(),
          });
          return resultFrom(run, { busy: true, retryAfterMs: retryMs });
        }
      }
    }
  } catch (err) {
    if (err instanceof RunFailure) {
      await leasePatch(run.id, leaseId, {
        status: "failed", error: String(err.message).slice(0, 500),
      }).catch(() => {});
      run.status = "failed";
      return resultFrom(run, { error: err.message });
    }
    // Transient: leave the run in its active stage — a driver will retry.
    throw err;
  } finally {
    clearInterval(renewer);
    await release();
  }

  return resultFrom(run);
}

export { providerMode, TAG_LABEL };
