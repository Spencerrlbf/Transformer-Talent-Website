// What kind of job a person does now, and whether their level fits the role.
// Spencer (2026-09-25): a Principal Engineering Manager was Contact now for
// five hands-on engineering roles because every Required row was met and
// nothing asked what their job is. The scorecard answers "does the profile
// show X"; this answers "is this the kind and level of person the role hires".
//
//   role type   Jev reads each recent position, the title AND its own
//               description, and answers one choice: builds hands-on, leads
//               the technical work and still builds, manages engineers, leads
//               an engineering organisation, or not an engineering job. Only
//               asked when a recent title carries a word that can mean either
//               (manager, head, director, lead, principal, founder, CTO...);
//               a plain engineer's history is read by code, free. Remembered
//               per person (person_role_types), not per role.
//   since when  code, from the positions' dates: the unbroken run of managing
//               positions that ends now.
//   level       code: the role's level from its title (else its years bar),
//               the person's from their current title and engineering years.
//
// The holds (lib/rolecard.ts Hold), on a hands-on engineering role:
//   managing engineers now, under two years   Contact now held at Worth a message
//   managing engineers for two years or more   Pass (dropped from the Network tab)
//   two or more levels apart, either way       Contact now held at Worth a message
// A hold never raises anyone, and no overrule of a row lifts it.

import crypto from "node:crypto";
import { sbRest } from "../supabase";
import { workKind, type CandidateFacts, type JobText } from "../facts";
import { titleFamilyOf } from "../signals/match";
import { JEV_MODEL, jevChoose, jevConfigured } from "./jev";
import type { Hold } from "@/lib/rolecard";

export type JobRole = "builder" | "tech_lead" | "manager" | "org_leader" | "other";

const CHOICES: Record<JobRole, string> = {
  builder: "Builds software hands-on as the main work: an engineer or developer who writes and ships the code",
  tech_lead: "Leads a team's technical work and still designs and builds a large share of it themselves",
  manager: "Manages engineers as the main job: hiring, people, planning and delivery, building little themselves",
  org_leader: "Leads managers or a whole engineering organisation: director, head of engineering, VP",
  other: "Not an engineering job",
};

export interface RoleType {
  v: 1;
  /** The latest position's kind of job. */
  current: JobRole;
  /** How sure the reading of the latest position is (1 when code read it). */
  p: number;
  /** Start year of the unbroken run of managing positions that ends now. */
  managingSince: number | null;
  /** Years in that run, to one decimal, when its start is dated. */
  managingYears: number | null;
  /** Each position read, newest first. */
  positions: { title: string; company: string; from: string | null; role: JobRole; p: number }[];
  by: "code" | "jev";
}

/** Positions read: the latest career positions, newest first. */
const READ = 4;
/** Title words that can mean building or managing: only then is Jev asked. */
const AMBIGUOUS = /\b(manager|management|director|head|vp|vice president|svp|evp|chief|cto|ceo|coo|founder|co-?founder|lead|leader|principal|architect)\b/i;

const positionsOf = (jobs: JobText[]) => jobs.filter((j) => j.career).slice(0, READ);
export const needsReading = (jobs: JobText[]) => positionsOf(jobs).some((j) => AMBIGUOUS.test(j.title));

const yearMonth = (text: string | null | undefined): { y: number; m: number } | null => {
  const t = text || "";
  const y = t.match(/\b(19|20)\d{2}\b/);
  if (!y) return null;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const mi = months.findIndex((mo) => new RegExp(`\\b${mo}`, "i").test(t));
  return { y: Number(y[0]), m: mi >= 0 ? mi + 1 : 1 };
};

/** Since when, by code: the unbroken run of managing positions that ends now. */
function withDates(positions: RoleType["positions"], jobs: JobText[], current: JobRole, p: number, by: RoleType["by"]): RoleType {
  const managing = (r: JobRole) => r === "manager" || r === "org_leader";
  let since: { y: number; m: number } | null = null;
  let run = 0;
  for (let i = 0; i < positions.length && managing(positions[i].role); i++) {
    run++;
    since = yearMonth(jobs[i]?.from) ?? since;
  }
  const now = new Date();
  const managingYears = run && since ? Math.round(((now.getUTCFullYear() * 12 + now.getUTCMonth() + 1 - (since.y * 12 + since.m)) / 12) * 10) / 10 : null;
  return { v: 1, current, p, managingSince: run && since ? since.y : null, managingYears, positions, by };
}

/** A plain engineer's history, read by code. */
function byCode(jobs: JobText[]): RoleType {
  const read = positionsOf(jobs);
  const positions = read.map((j) => ({ title: j.title, company: j.company, from: j.from ?? null, role: (workKind(j.title, j.text) === "other" ? "other" : "builder") as JobRole, p: 1 }));
  return withDates(positions, read, positions[0]?.role ?? "other", 1, "code");
}

export function roleTypeHash(jobs: JobText[], headline: string | null | undefined): string {
  const read = positionsOf(jobs).map((j) => [j.title, j.company, j.from ?? null, j.to ?? null, j.text.slice(0, 1200)]);
  return crypto.createHash("sha256").update(JSON.stringify(["role-type-v1", JEV_MODEL, read, headline || ""])).digest("hex").slice(0, 32);
}

/** Jev reads each position; code turns the answers into the role type. */
async function byJev(jobs: JobText[], headline: string | null | undefined): Promise<RoleType | null> {
  const read = positionsOf(jobs);
  const questions: Record<string, { instructions: string; criteria: Record<string, string> }> = {};
  read.forEach((j, i) => {
    questions[`p${i}`] = {
      instructions:
        `Position ${i + 1} of this person: "${j.title}"${j.company ? ` at ${j.company}` : ""}. From what this position says about the work, ` +
        `its title and its own description, which best describes the person's job in it? Judge this position only. ` +
        `A title can say more or less than the work does, so read the description as well as the title.`,
      criteria: CHOICES,
    };
  });
  const state = {
    person: {
      headline: headline || "",
      positions: read.map((j, i) => ({ position: i + 1, title: j.title, company: j.company, dates: [j.from, j.to].filter(Boolean).join(" to "), description: j.text.slice(0, 900) })),
    },
  };
  const res = await jevChoose({ state, questions, timeoutMs: 20_000 });
  if ("error" in res) return null;
  const positions = read.map((j, i) => {
    const a = res.answers[`p${i}`];
    const ranked = a ? (Object.entries(a.probabilities) as [JobRole, number][]).sort((x, y) => y[1] - x[1]) : [];
    const [role, p] = ranked[0] ?? [(workKind(j.title, j.text) === "other" ? "other" : "builder") as JobRole, 0];
    return { title: j.title, company: j.company, from: j.from ?? null, role, p };
  });
  return withDates(positions, read, positions[0]?.role ?? "other", positions[0]?.p ?? 0, "jev");
}

/** The role type, remembered per person under a hash of what was read. */
export async function roleTypeFor(personKey: string, jobs: JobText[], headline: string | null | undefined): Promise<{ roleType: RoleType | null; called: boolean }> {
  if (!positionsOf(jobs).length) return { roleType: null, called: false };
  if (!needsReading(jobs) || !jevConfigured()) return { roleType: byCode(jobs), called: false };
  const hash = roleTypeHash(jobs, headline);
  const known = await sbRest(`person_role_types?candidate_key=eq.${encodeURIComponent(personKey)}&input_hash=eq.${hash}&select=result&limit=1`, { signal: AbortSignal.timeout(5_000) })
    .then(async (r) => (r.ok ? ((await r.json()) as { result: RoleType }[]) : []))
    .catch(() => []);
  if (known[0]?.result?.v === 1) return { roleType: known[0].result, called: false };
  const read = await byJev(jobs, headline);
  if (!read) return { roleType: null, called: true };
  await sbRest("person_role_types?on_conflict=candidate_key,input_hash", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=minimal",
    signal: AbortSignal.timeout(5_000),
    body: JSON.stringify([{ candidate_key: personKey, input_hash: hash, result: read, model: JEV_MODEL }]),
  }).catch(() => null);
  return { roleType: read, called: true };
}

// ---------- the holds ----------

/** A hands-on engineering role: an engineering or data title that is not
 *  itself a manager's. Other roles (product, design, a manager's role) get no
 *  role-type hold. */
export function isHandsOnRole(roleTitle: string): boolean {
  const fam = titleFamilyOf(roleTitle);
  if (!fam.includes("engineering") && !fam.includes("data")) return false;
  return !/\b(manager|director|head of|vp|vice president|chief|cto)\b/i.test(roleTitle);
}

const fmtYears = (n: number) => (n === 1 ? "1 year" : `${Number.isInteger(n) ? n : n.toFixed(1)} years`);

export function managerHold(roleTitle: string, rt: RoleType | null | undefined): Hold | null {
  if (!rt || !isHandsOnRole(roleTitle)) return null;
  if (rt.current !== "manager" && rt.current !== "org_leader") return null;
  const what = rt.current === "org_leader" ? "Leads an engineering organisation" : "Manages engineers";
  const since = rt.managingSince ? ` since ${rt.managingSince}` : "";
  if (rt.managingYears != null && rt.managingYears >= 2)
    return { kind: "manager", label: "pass", note: `${what}${since} (${fmtYears(rt.managingYears)}); this role is hands-on.` };
  const builtBefore = rt.positions.slice(1).some((x) => x.role === "builder" || x.role === "tech_lead");
  return { kind: "manager", label: "message", note: `${what}${since}${builtBefore ? ", hands-on before that" : ""}. Confirm they want to build hands-on again.` };
}

/** Levels: junior 0, mid 1, senior 2, lead 2.5, staff or principal 3. */
const LEVEL_NAME = (n: number) => (n <= 0 ? "junior" : n < 2 ? "mid-level" : n < 2.5 ? "senior" : n < 3 ? "lead" : "staff or principal");
const titleLevel = (title: string): number | null => {
  const t = title.replace(/member of (the )?technical staff|chief of staff/gi, " ");
  if (/\b(junior|jr|intern|graduate|entry[- ]level|new grad)\b/i.test(t)) return 0;
  if (/\b(staff|principal|distinguished|architect)\b/i.test(t)) return 3;
  if (/\b(head of|director|vp|vice president|cto|chief technology)\b/i.test(t)) return 3;
  if (/\b(lead|tech lead)\b/i.test(t)) return 2.5;
  if (/\b(senior|sr)\b/i.test(t)) return 2;
  return null;
};
/** The role's level: its title's word, else its years bar. */
export function roleLevel(roleTitle: string, minYears: number | null): number {
  const t = titleLevel(roleTitle);
  if (t != null) return t;
  if (minYears != null && minYears >= 8) return 3;
  if (minYears != null && minYears >= 5) return 2;
  return 1;
}
/** The person's level: their current title's word, else their engineering years. */
export function personLevel(facts: CandidateFacts | null | undefined): number | null {
  const title = facts?.currentTitle || "";
  if (!title) return null;
  const t = titleLevel(title);
  if (t != null) return t;
  const eng = facts?.engineeringYears ?? null;
  return eng != null && eng >= 8 ? 2 : 1;
}

export function levelHold(roleTitle: string, minYears: number | null, facts: CandidateFacts | null | undefined): Hold | null {
  const person = personLevel(facts);
  if (person == null) return null;
  const role = roleLevel(roleTitle, minYears);
  const title = facts?.currentTitle || "";
  const eng = facts?.engineeringYears;
  const yrs = eng != null ? ` with ${fmtYears(Math.round(eng * 10) / 10)} in engineering` : "";
  if (role - person >= 2)
    return { kind: "level", label: "message", note: `The role reads ${LEVEL_NAME(role)}; "${title}"${yrs} reads ${LEVEL_NAME(person)}.` };
  if (person - role >= 2)
    return { kind: "level", label: "message", note: `"${title}"${yrs} reads ${LEVEL_NAME(person)} for a ${LEVEL_NAME(role)} role; check the level and pay suit them.` };
  return null;
}

/** Every hold on this person for this role. The manager hold, when there is
 *  one, says more than the level hold, so the level hold is left out then. */
export function holdsFor(args: { roleTitle: string; minYears: number | null; facts: CandidateFacts | null | undefined; roleType: RoleType | null | undefined }): Hold[] {
  const manager = managerHold(args.roleTitle, args.roleType);
  if (manager) return [manager];
  const level = levelHold(args.roleTitle, args.minYears, args.facts);
  return level ? [level] : [];
}
