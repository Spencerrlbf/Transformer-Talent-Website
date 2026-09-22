// One way to judge a person for a role, on every path (sourcing, applicants):
// the role's scorecard and what recruiters confirmed about the person on
// other roles go to the judge, what the judge learned is remembered ROW BY
// ROW so the same person on the same row is never asked twice, and the
// recruiter's overrules on this role are laid back over it so judging again
// never flips a row they confirmed.
//
// Memory lives in verdict_cache (unique on org_role_id, candidate_key,
// input_hash): one record per remembered judgment row (judge_version
// "v14-row", keyed on the row's wording, its ladder, the judge and the
// person's material) and one per remembered note ("v14-note", keyed on the
// rows and facts it was written from). Nothing is keyed on the id, the tier,
// the call flag or the rung the row counts from: the row shown is rebuilt
// from the current criterion and the record on every read, so none of that
// can go stale, and a changed "met from" re-labels without a re-judge. The
// v13 whole-verdict records stay in the table as unread history.

import { sbRest } from "../supabase";
import { buildVerdictView, judgeVerdict, type VerdictInput } from "../verdict";
import type { CandidateFacts } from "../facts";
import { applyOverrides, rowKind, type Criterion } from "@/lib/rolecard";
import type { VerdictView } from "@/lib/verdict-view";
import { isMemory, materialOf, rowHash, NOTE_MODEL, type Memory, type MemoryWrite } from "./scorecard-judge";
import { JEV_MODEL } from "./jev";
import { factLine, loadPersonContext, type PersonContext } from "./store";

const CACHE_TIMEOUT_MS = 5_000;
/** The judge reads the newest few; the hash covers exactly what it reads. */
const MAX_FACTS = 12;
/** Notes pile up (one per distinct rows-and-facts state, and tenure moves
 *  monthly): only the newest few are read back. */
const MAX_NOTES = 20;
const ROW_VERSION = "v14-row";
const NOTE_VERSION = "v14-note";

export interface JudgeForRoleArgs {
  orgId: string;
  orgRoleId: string;
  /** "src_<sourced id>" | "cand_<candidates.id>" (see store.personKey). */
  personKey: string;
  criteria: Criterion[];
  input: Omit<VerdictInput, "criteria" | "confirmedFacts" | "memory">;
  /** Role-level target companies: part of what makes a verdict reusable.
   *  Companies one search happened to target are not, or the same person
   *  would read differently from one search to the next. */
  roleTargets: string[];
  factsFor: (terms: string[]) => CandidateFacts | null;
  roleSkills: string[];
}

export interface JudgedForRole {
  view: VerdictView | null;
  /** True when everything came from memory and no model was called. */
  saved: boolean;
}

/** What is already known about this person on this card: the judgment rows
 *  by their exact hashes (at most ten), and the newest notes written for them
 *  on this role (the note's hash is only known once the rows are). Two reads
 *  at once, so the notes, which pile up, can never crowd a row out and have
 *  the person asked again. */
async function readMemory(a: JudgeForRoleArgs, input: VerdictInput): Promise<Map<string, Memory>> {
  const memory = new Map<string, Memory>();
  if (!a.criteria.length) return memory;
  const material = materialOf(input, a.criteria);
  const hashes = a.criteria.filter((c) => rowKind(c) === "judgment").map((c) => rowHash(c, material.materialHash));
  type Rec = { input_hash: string; verdict: unknown };
  const base = `verdict_cache?org_role_id=eq.${a.orgRoleId}&candidate_key=eq.${encodeURIComponent(a.personKey)}&select=input_hash,verdict`;
  const read = async (query: string): Promise<Rec[]> => {
    const res = await sbRest(`${base}&${query}`, { signal: AbortSignal.timeout(CACHE_TIMEOUT_MS) }).catch(() => null);
    return res?.ok ? ((await res.json().catch(() => [])) as Rec[]) : [];
  };
  const [rows, notes] = await Promise.all([
    hashes.length ? read(`judge_version=eq.${ROW_VERSION}&input_hash=in.(${hashes.join(",")})&limit=${hashes.length}`) : Promise.resolve([] as Rec[]),
    read(`judge_version=eq.${NOTE_VERSION}&order=created_at.desc&limit=${MAX_NOTES}`),
  ]);
  for (const r of [...rows, ...notes]) if (r?.input_hash && isMemory(r.verdict)) memory.set(r.input_hash, r.verdict);
  return memory;
}

/** One bulk write of what this pass learned. A record already there (a
 *  parallel review of the same person) is left as it is. */
async function writeMemory(a: JudgeForRoleArgs, writes: MemoryWrite[]): Promise<void> {
  if (!writes.length) return;
  await sbRest("verdict_cache?on_conflict=org_role_id,candidate_key,input_hash", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=minimal",
    signal: AbortSignal.timeout(CACHE_TIMEOUT_MS),
    body: JSON.stringify(
      writes.map((w) => ({
        organization_id: a.orgId,
        org_role_id: a.orgRoleId,
        candidate_key: a.personKey,
        input_hash: w.hash,
        judge_version: w.record.kind === "row" ? ROW_VERSION : NOTE_VERSION,
        model: w.record.kind === "row" ? JEV_MODEL : NOTE_MODEL,
        verdict: w.record,
      }))
    ),
  }).catch(() => null);
}

export async function judgeForRole(a: JudgeForRoleArgs): Promise<JudgedForRole> {
  // The recruiter's word first. If it cannot be read, no verdict is written:
  // one written without their rows would quietly undo them. Reported as a
  // transient failure so a run pauses and retries rather than blaming the row.
  let ctx: PersonContext;
  try {
    ctx = await loadPersonContext(a.orgId, a.orgRoleId, a.personKey).catch(() => loadPersonContext(a.orgId, a.orgRoleId, a.personKey));
  } catch {
    a.input.onError?.({ status: 0, code: "feedback_read_failed" });
    return { view: null, saved: false };
  }
  // What the scorecard judge may read as true: the facts confirmed yes or
  // equivalent, picked by their status, never by their wording (a confirmed
  // "no" names the requirement too). The newest few; the material hash
  // covers exactly these. The single-call judge of a role with no scorecard
  // still sees every fact, a "no" included, as it always did.
  const facts = a.criteria.length ? ctx.facts.filter((f) => f.status === "yes" || f.status === "equivalent") : ctx.facts;
  const factLines = facts.slice(-MAX_FACTS).map(factLine);
  const input: VerdictInput = { ...a.input, criteria: a.criteria, confirmedFacts: factLines };
  const memory = await readMemory(a, input);

  const judged = await judgeVerdict({ ...input, memory });
  if (!judged) return { view: null, saved: false };
  const view = buildVerdictView(judged, a.factsFor, a.roleSkills);
  await writeMemory(a, judged.memoryWrites);
  const saved = judged.calls === 0;

  // A model call takes seconds: a row checked off meanwhile must not be
  // written over, so the recruiter's word is read again before it is laid on.
  const now = saved ? ctx : await loadPersonContext(a.orgId, a.orgRoleId, a.personKey).catch(() => ctx);
  return { view: applyOverrides(view, now.overrides, now.wrongRole, a.criteria), saved };
}
