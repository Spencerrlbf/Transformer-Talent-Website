// Owner-only: the scorecard rows as GPT-4o judged them (stored on the role's
// latest sourcing run) beside a second opinion from TypeSafe's Jev, asked
// twice per person to see whether it answers the same way both times.
// Each ask is saved to row_judge_evals so it can be analysed; nothing in the
// product reads that table.
//   GET  ?jobId=16                 the run, its people and their stored rows
//   POST {jobId, membershipIds}    Jev's rows for up to 6 of those people
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import { computeFacts, formatFacts } from "@/lib/server/facts";
import { harvestToExperiences, linkedinProfileText } from "@/lib/server/spine";
import { splitStack } from "@/lib/server/scorecard";
import { isCareerYearsRow, isScorecard, type CardRow, type Criterion } from "@/lib/rolecard";
import { isVerdictView } from "@/lib/verdict-view";
import { JEV_USD_PER_M_INPUT, jevConfigured, jevJudgeRows } from "@/lib/server/rolecard/jev";

export const maxDuration = 60;

async function owner(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return { err: NextResponse.json({ error: "not_a_member" }, { status: 403 }) };
  if (member.memberRole !== "owner") return { err: NextResponse.json({ error: "owner_only" }, { status: 403 }) };
  return { member };
}

type Role = {
  id: string; title: string; tech_stack: string | null; scorecard: unknown;
  jd: { about?: string; doing?: string[]; needs?: string[] } | null;
};

async function roleAndRun(orgId: string, jobId: string) {
  const rr = await sbRest(
    `org_roles?organization_id=eq.${orgId}&external_id=eq.${encodeURIComponent(jobId)}&select=id,title,tech_stack,scorecard,jd&limit=1`
  );
  const [role] = rr.ok ? ((await rr.json()) as Role[]) : [];
  if (!role) return null;
  const runs = await sbRest(
    `sourcing_runs?organization_id=eq.${orgId}&org_role_id=eq.${role.id}&status=eq.done&select=id,created_at&order=created_at.desc&limit=1`
  );
  const [run] = runs.ok ? ((await runs.json()) as { id: string; created_at: string }[]) : [];
  return { role, run: run || null };
}

export async function GET(req: NextRequest) {
  const { member, err } = await owner(req);
  if (err) return err;
  const jobId = (req.nextUrl.searchParams.get("jobId") || "").slice(0, 40);
  const found = jobId ? await roleAndRun(member!.org.id, jobId) : null;
  if (!found) return NextResponse.json({ error: "role_not_found" }, { status: 404 });
  const { role, run } = found;
  if (!run) return NextResponse.json({ role: { title: role.title }, run: null, people: [], keyPresent: jevConfigured() });
  const res = await sbRest(
    `sourcing_run_candidates?run_id=eq.${run.id}&hidden=eq.false&verdict=not.is.null` +
      `&select=id,rank,verdict,sourced_candidates(full_name,current_title,current_company,linkedin_url)&order=rank.asc.nullslast&limit=60`
  );
  type Row = { id: string; rank: number | null; verdict: unknown; sourced_candidates: { full_name: string | null; current_title: string | null; current_company: string | null; linkedin_url: string | null } | null };
  const rows = res.ok ? ((await res.json()) as Row[]) : [];
  const people = rows
    .filter((r) => isVerdictView(r.verdict) && r.verdict.card?.rows.length)
    .map((r) => {
      const v = r.verdict as { label: string; card: { rows: CardRow[] } };
      return {
        membershipId: r.id,
        name: r.sourced_candidates?.full_name || "Unknown",
        title: [r.sourced_candidates?.current_title, r.sourced_candidates?.current_company].filter(Boolean).join(" at "),
        linkedinUrl: r.sourced_candidates?.linkedin_url || null,
        label: v.label,
        rows: v.card.rows.map((x) => ({ id: x.id, label: x.label, tier: x.tier, gpt: x.ai, evidence: x.evidence, byRule: isCareerYearsRow(x.label) })),
      };
    });
  return NextResponse.json({
    role: { title: role.title },
    run: { id: run.id, at: run.created_at },
    people,
    keyPresent: jevConfigured(),
    usdPerMillionInput: JEV_USD_PER_M_INPUT,
  });
}

export async function POST(req: NextRequest) {
  const { member, err } = await owner(req);
  if (err) return err;
  const body = (await req.json().catch(() => null)) as { jobId?: unknown; membershipIds?: unknown } | null;
  const jobId = String(body?.jobId || "").slice(0, 40);
  const ids = (Array.isArray(body?.membershipIds) ? body!.membershipIds : [])
    .map(String)
    .filter((x) => /^[0-9a-f-]{36}$/.test(x))
    .slice(0, 6);
  if (!jevConfigured()) return NextResponse.json({ error: "no_key" }, { status: 400 });
  const found = jobId ? await roleAndRun(member!.org.id, jobId) : null;
  if (!found?.run || !ids.length) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const { role, run } = found;
  const current = isScorecard(role.scorecard) ? role.scorecard.criteria : [];

  const res = await sbRest(
    `sourcing_run_candidates?run_id=eq.${run.id}&organization_id=eq.${member!.org.id}&id=in.(${ids.join(",")})` +
      `&select=id,sourced_candidate_id,verdict,sourced_candidates(full_name,skills,profile)`
  );
  type Row = { id: string; sourced_candidate_id: string; verdict: unknown; sourced_candidates: { full_name: string | null; skills: string[] | null; profile: Record<string, unknown> | null } | null };
  const rows = res.ok ? ((await res.json()) as Row[]) : [];
  const stackTerms = splitStack(role.tech_stack).slice(0, 20);

  const results = await Promise.all(
    rows.map(async (r) => {
      const profile = r.sourced_candidates?.profile;
      if (!profile) return { membershipId: r.id, error: "no_profile" };
      // Jev is asked the very rows GPT-4o answered for this person (a
      // scorecard edited since would not line up), with today's "what counts
      // as evidence" note where the row still exists.
      const stored = isVerdictView(r.verdict) ? r.verdict.card?.rows || [] : [];
      if (!stored.length) return { membershipId: r.id, error: "no_scorecard" };
      const criteria: Criterion[] = stored.map((x) => ({ id: x.id, label: x.label, tier: x.tier, good: current.find((c) => c.id === x.id)?.good }));
      const facts = computeFacts(harvestToExperiences(profile), stackTerms, r.sourced_candidates?.skills || [], profile.education ?? null);
      const ask = () =>
        jevJudgeRows({
          roleTitle: role.title,
          jd: role.jd,
          criteria,
          candidateName: r.sourced_candidates?.full_name || "Candidate",
          profileText: linkedinProfileText(profile),
          factsBlock: formatFacts(facts),
        });
      // Twice, at the same time: the same input should give the same answer.
      const [a, b] = await Promise.all([ask(), ask()]);
      if ("error" in a) return { membershipId: r.id, error: a.error, detail: a.detail };
      const out = a.rows.map((x) => {
        const again = "error" in b ? null : b.rows.find((y) => y.id === x.id) || null;
        return { ...x, again: again ? { status: again.status, confidence: again.confidence } : null };
      });
      // Saved for analysis (and, later, to be measured against the
      // recruiter's check-offs). Best effort: the page works without it.
      await sbRest("row_judge_evals", {
        method: "POST",
        prefer: "return=minimal",
        body: JSON.stringify({
          organization_id: member!.org.id,
          org_role_id: role.id,
          run_id: run.id,
          membership_id: r.id,
          candidate_key: `src_${r.sourced_candidate_id}`,
          judge: a.model,
          baseline: isVerdictView(r.verdict) ? r.verdict.model : null,
          rows: out.map((x) => {
            const base = stored.find((y) => y.id === x.id);
            return { ...x, label: base?.label, tier: base?.tier, baseline: base?.ai, baselineEvidence: base?.evidence };
          }),
          ms: a.ms,
          input_tokens: a.inputTokens,
        }),
      }).catch(() => null);
      return { membershipId: r.id, ms: a.ms, inputTokens: a.inputTokens, model: a.model, rows: out };
    })
  );
  return NextResponse.json({ results });
}
