// Judging a person against a role's scorecard, v14: code decides wherever it
// can, a probability judge reads the rest on the card's own ladders, and no
// model ever writes a "no".
//
//   years rows     careerYearsStatus, by rule, from dated positions. The only
//                  row that can make someone a Pass. Within a year of the
//                  bar reads "short" (numbers shown): never a Pass, never a
//                  yes.
//   tech rows      where the technology reaches on the material (the current
//                  job, a career job or the resume, a stand-in the row
//                  accepts, the profile only, nowhere), on a fixed ladder.
//                  Code writes the evidence and quotes the tag itself.
//   judgment rows  ONE request to Jev (jev.ts) with every unremembered row of
//                  the person: each row is a question over its ladder, rung 1
//                  first, answered as a probability spread. routeLevel turns
//                  the spread into the rung reached; the status follows from
//                  the rung the role counts from. The evidence shown is the
//                  rung's own words.
//   references     ONE small call finds the lines (up to three) behind each
//                  rung reached (references.ts). It can never change a
//                  status; a met row with no quotable line keeps its tick
//                  and says so.
//   review         ONE small call writes the review beside the rows: a bottom
//                  line, why-they-fit bullets that cite met rows, gap bullets
//                  that cite unmet rows, and questions for a call. It reads
//                  FACTS, ROWS (with their verified lines) and, for phrasing
//                  only, the role's own words; guarded in code
//                  (lib/rolecard.ts guardReview), with a code-written
//                  fallback (fallbackReview). Never the judge's input.
//
// Memory: a judgment row is remembered by a hash of its wording, its ladder,
// the judge and the person's material, so a person is read again only for
// the rows that changed (judge.ts stores it). The review is remembered by
// the rows, facts and role words it was written from, under REVIEW_VERSION.
//
// Measured before this (same person, same card, five runs): the rows that
// moved were caused by a regex and a retry reacting to the model's choice of
// verb, and the paragraph differed in 25 of 25. Jev was 97% repeatable and,
// routed through the label rules with "no" never counted, matched the
// recruiter 15/17 against 14/17 for the text judge.

import crypto from "node:crypto";
import type { Verdict, VerdictInput } from "../verdict";
import { profileFacts, sameCompany, workKind, type CandidateFacts, type JobText } from "../facts";
import type { RequirementRead, VerdictLabel } from "@/lib/verdict-view";
import { sentences } from "@/lib/verdict-view";
import { namesAny, technologiesNamed } from "@/lib/tech-terms";
import {
  NO_LINE_SOURCE, REVIEW_LIMITS, careerYearsStatus, fallbackReview, guardReview, isCareerYearsRow, labelFromRows, ladderOf, metAtOf, rowKind, routeLevel,
  statusFromLevel, stripExamples, techLadder, techLevel, techSpec, techStatus, yearsBar,
  type CardRow, type Criterion, type Review, type ReviewBullet, type RowStatus, type TechReach,
} from "@/lib/rolecard";
import { isJevError, jevJudgeLadders, JEV_MODEL } from "./jev";
import { askOpenAI, findReferences, jobSource, quoteCheck, REF_MODEL } from "./references";

export const SCORECARD_JUDGE_VERSION = "v14";
/** The review is versioned on its own: a change to how it is written goes
 *  into the note hash, so every remembered note is written once more, and
 *  no row is touched (rows, Jev and the row hashes stay v14). */
export const REVIEW_VERSION = "v14.1";
/** Pinned, like the reference model: the review is remembered under it. */
export const NOTE_MODEL = "gpt-4o-mini-2024-07-18";
export { REF_MODEL };
/** Profile and resume together are read whole up to this; past it the resume's tail is cut. */
export const MAX_MATERIAL_CHARS = 100_000;

// ---------- memory ----------

/** A judgment row as the judge read it, kept so the same person on the same
 *  row is never asked twice. The row shown is REBUILT from the current
 *  criterion (id, label, tier, call) and this record, so nothing here can go
 *  stale. */
export interface RowMemory {
  kind: "row";
  criterionId: string;
  level: number;
  levels: number;
  p: number[];
  confidence: number;
  /** The first verified line and where it was found (older records carry only these). */
  quote?: string;
  source?: string;
  /** Every verified line, at most three. */
  quotes?: { text: string; source: string }[];
  at: string;
}
/** The review as remembered. `paragraph` is the bottom line and the first
 *  fit, for older readers; `review` is what the card shows. A v14 record
 *  has no review and is never read back: REVIEW_VERSION is in its hash. */
export interface NoteMemory {
  kind: "note";
  paragraph: string;
  missing: string[];
  ask: string[];
  betterSuited: string;
  review?: Review;
  at: string;
}
export type Memory = RowMemory | NoteMemory;
export interface MemoryWrite {
  hash: string;
  record: Memory;
}
export const isReview = (x: unknown): x is Review => {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  const bullets = (list: unknown) => Array.isArray(list) && list.every((b) => !!b && typeof b === "object" && typeof (b as ReviewBullet).text === "string" && Array.isArray((b as ReviewBullet).rowIds));
  return r.v === 1 && typeof r.bottomLine === "string" && bullets(r.fits) && bullets(r.gaps) && Array.isArray(r.ask);
};
export const isMemory = (x: unknown): x is Memory => {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  if (r.kind === "row") return typeof r.criterionId === "string" && typeof r.level === "number" && typeof r.levels === "number" && Array.isArray(r.p) && typeof r.confidence === "number";
  if (r.kind === "note") return typeof r.paragraph === "string" && Array.isArray(r.ask) && Array.isArray(r.missing) && typeof r.betterSuited === "string" && (r.review === undefined || isReview(r.review));
  return false;
};

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const years = (n: number) => `${n} ${n === 1 ? "year" : "years"}`;

/** Everything the judge reads about the person, assembled once so the judge
 *  and the memory that keys on it (judge.ts) can never disagree. */
export interface JudgeMaterial {
  profileText: string;
  resumeText: string;
  /** What a recruiter confirmed as TRUE. A confirmed "no" names the
   *  requirement too, and must never be read as evidence for it. */
  confirmedTrue: string[];
  basis: "engineering" | "career";
  yearsLine: string;
  materialHash: string;
}

/** A years bar is about engineering years on an engineering role, and about
 *  the career on any other (a data science or product role). Decided once. */
export const basisOf = (roleTitle: string, criteria: Criterion[]): "engineering" | "career" =>
  workKind(roleTitle) === "engineering" || criteria.some((c) => isCareerYearsRow(c.label) && /\b(engineer|developer|software)/i.test(c.label)) ? "engineering" : "career";

/** The one line of years the judge is given, in whole years: the months
 *  move with the calendar, and a remembered row must not expire monthly. */
export function yearsLine(facts: CandidateFacts | null, basis: "engineering" | "career"): string {
  if (!facts || facts.engineeringYears == null) return "No dated positions on the profile.";
  const career = Math.floor(facts.careerYears ?? facts.engineeringYears);
  if (basis === "career") return `${years(career)} of career, from dated positions.`;
  const eng = Math.floor(facts.engineeringYears);
  return career > eng
    ? `${years(eng)} in engineering roles; ${years(career)} of career in all, from dated positions.`
    : `${years(eng)} in engineering roles, from dated positions.`;
}

export function materialOf(input: VerdictInput, criteria: Criterion[]): JudgeMaterial {
  const profileText = input.profileText || "";
  let resumeText = input.resumeText || "";
  if (profileText.length + resumeText.length > MAX_MATERIAL_CHARS) {
    const keep = Math.max(0, MAX_MATERIAL_CHARS - profileText.length);
    console.warn(`verdict: ${profileText.length + resumeText.length} chars of material; the resume is cut to ${keep}`);
    resumeText = resumeText.slice(0, keep);
  }
  const confirmedTrue = (input.confirmedFacts || []).filter((f) => !/:\s*no\b/i.test(f));
  const basis = basisOf(input.roleTitle, criteria);
  const line = yearsLine(input.facts ?? null, basis);
  return { profileText, resumeText, confirmedTrue, basis, yearsLine: line, materialHash: sha(JSON.stringify([profileText, resumeText, confirmedTrue, line])) };
}

/** What decides a judgment row's answer, and nothing else: its wording, its
 *  ladder, the judge and the reference model, and the person's material.
 *  NOT the id, the tier, the call flag, the rung it counts from, the other
 *  rows or the role: none of those change how the row reads. */
export const rowHash = (c: Pick<Criterion, "label"> & Partial<Pick<Criterion, "kind" | "ladder" | "good" | "metAt">>, materialHash: string): string =>
  sha(JSON.stringify(["v14", JEV_MODEL, REF_MODEL, c.label, ladderOf(c), materialHash]));

/** The role's own words, as the review call reads them: its summary, what it
 *  needs, what the person will do, and its stack. Bounded, so a long job
 *  description cannot crowd the rows out. */
export type RoleWords = NonNullable<VerdictInput["roleWords"]>;
const MAX_ROLE_ABOUT = 1_500;
const MAX_ROLE_LINES = 12;
const MAX_ROLE_LINE = 240;
export function roleWordsOf(words: RoleWords | null | undefined): { about: string; needs: string[]; doing: string[]; techStack: string } {
  const line = (x: unknown) => String(x ?? "").replace(/\s+/g, " ").trim();
  const lines = (xs: unknown) => (Array.isArray(xs) ? xs : []).map((x) => line(x).slice(0, MAX_ROLE_LINE)).filter(Boolean).slice(0, MAX_ROLE_LINES);
  return { about: line(words?.about).slice(0, MAX_ROLE_ABOUT), needs: lines(words?.needs), doing: lines(words?.doing), techStack: line(words?.techStack).slice(0, 300) };
}

/** The review is written from the rows (with their verified lines), the
 *  facts and the role's own words: the same of each gets the same review
 *  back without a call. REVIEW_VERSION is part of it, so a change to how the
 *  review is written rewrites every remembered note once. */
export const noteHash = (rows: CardRow[], label: VerdictLabel, factItems: string[], roleWords?: RoleWords | null): string =>
  sha(JSON.stringify(["v14-note", REVIEW_VERSION, NOTE_MODEL, rows.map((r) => [r.id, r.status, r.level ?? null, r.evidence, r.quote ?? "", (r.quotes || []).map((q) => q.text)]), label, factItems, roleWordsOf(roleWords)]));

// ---------- the review ----------

const REVIEW_SYSTEM = `You write the review a recruiter reads in ten seconds beside a candidate's scorecard: short bullets and one bottom line. Everything you may say about the person is in the message: FACTS, computed in code from dated positions, and ROWS, already decided, each with the lines copied from the profile or resume that decided it. You have not seen the profile. Add nothing to what is there. THE ROLE'S OWN WORDS are there only so that each fit is said in the role's terms; they are not evidence about the person.

Return:
- fits: why this person fits THIS role. One bullet per reason, at most 6, each resting on the rows it cites (row_ids: rows marked YES or EQUIVALENT only, at least one per bullet). Required rows first, then Exceptional, then Bonus. Say what the rows found and what it means for this role, in the role's own terms. Never restate a copied line: the recruiter sees the lines beside the bullet. For an EQUIVALENT, say what stands in for what. When no row is YES or EQUIVALENT, return no fits.
- gaps: what is short or not shown, at most 4 bullets, Required rows first: what the profile does not show, and the question to ask on a first call. row_ids: rows marked SHORT, UNKNOWN or NO only, or none. A years row is never "not shown": say its numbers. When the label is Pass, say which Required row is against and its numbers.
- bottom_line: ONE sentence of at most 20 words: the verdict, and the one thing to confirm.
- ask: 0 to 3 short questions for a first call, one per open Required row first.

Each bullet is one or two sentences and at most 36 words. Plain English: no headings, no quotation marks, no dashes as punctuation. Never state or imply experience for a row marked UNKNOWN or SHORT. Never name a technology, product, duty or employer that is not in FACTS or ROWS. Never write suggests, implies or likely: the rows are decided, say what they show. Use the candidate's name once at most, exactly as given, then "they" and "their", never he or she.`;

/** The strict shape of the review, with the card's own ids as the only
 *  rows a bullet can cite. */
const reviewSchema = (ids: string[]) => {
  const rowId = ids.length ? { type: "string", enum: ids } : { type: "string" };
  const bullet = { type: "object", additionalProperties: false, properties: { text: { type: "string" }, row_ids: { type: "array", items: rowId } }, required: ["text", "row_ids"] };
  return {
    type: "object",
    additionalProperties: false,
    properties: { bottom_line: { type: "string" }, fits: { type: "array", items: bullet }, gaps: { type: "array", items: bullet }, ask: { type: "array", items: { type: "string" } } },
    required: ["bottom_line", "fits", "gaps", "ask"],
  };
};

/** Facts about the person, written by code from dated positions. Where they
 *  work and what that company does appears here, once, as a fact: never as a
 *  tick on a row. */
export function factLine(input: VerdictInput, facts: CandidateFacts | null, jobs: JobText[], basis: "engineering" | "career" = "engineering"): string[] {
  const out: string[] = [];
  if (facts?.currentTitle) {
    const tenure = facts.currentTenureYears != null ? (facts.currentTenureYears < 1 ? `${Math.max(1, Math.round(facts.currentTenureYears * 12))} months there` : `${years(facts.currentTenureYears)} there`) : "";
    out.push(`${facts.currentTitle}${facts.currentCompany ? ` at ${facts.currentCompany}` : ""}${tenure ? `, ${tenure}` : ""}`);
  }
  if (facts?.engineeringYears != null) {
    const career = facts.careerYears ?? facts.engineeringYears;
    out.push(
      basis === "career"
        ? `${years(career)} of career`
        : career - facts.engineeringYears >= 0.5
          ? `${years(facts.engineeringYears)} in engineering roles; ${years(career)} of career in all${facts.otherWork[0] ? ` (${facts.otherWork[0]})` : ""}`
          : `${years(facts.engineeringYears)} in engineering roles`
    );
  }
  const current = (facts?.currentCompany || "").toLowerCase();
  const before = [...new Set(jobs.filter((j) => j.career && j.company && j.company.toLowerCase() !== current).map((j) => j.company))].slice(0, 3);
  if (before.length) out.push(`Before: ${before.join(", ")}`);
  for (const target of input.targetedCompanies.slice(0, 6)) {
    const at = jobs.filter((j) => j.company && sameCompany(j.company, target));
    const job = at.find((j) => j.career) || at[0];
    if (job) out.push(job.career ? `Worked at ${target}, a company this role targets (${job.title})` : `Interned at ${target}, a company this role targets`);
  }
  if (input.employerContext) {
    // The company's own page, tidied: no dash, cut at a word, never mid-word.
    const clean = input.employerContext.replace(/\s+/g, " ").replace(/\s+[—–-]\s+/, ": ").trim();
    const cut = clean.length <= 150 ? clean : `${clean.slice(0, 150).replace(/\s+\S*$/, "")}…`;
    out.push(`Current employer, from its company page: ${cut}`);
  }
  return out;
}

const NEGATION = /\b(not|no|never|without|isn't|aren't|unconfirmed|missing|absent|lacks?|silent)\b/i;
/** Words that make a clause something other than a claim: a negation, or a
 *  thing still to confirm ("Confirm TypeScript depth on a call"). */
const NOT_A_CLAIM = /\b(not|no|never|without|isn't|aren't|unconfirmed|missing|absent|lacks?|silent|confirm|confirms|confirmed|ask|check|verify|whether)\b/i;
/** No dash in anything a recruiter reads: an em or en dash becomes a comma,
 *  and one between two numbers ("2020–2024") reads "to". */
export const noDashes = (text: string) =>
  text.replace(/(\d)\s*\u2013\s*(?=\d)/g, "$1 to ").replace(/\s*[\u2014\u2013]+\s*/g, ", ").replace(/\s*--+\s*/g, ", ").replace(/,\s*,/g, ",").replace(/^,\s*|,\s*$/g, "");
const PRONOUNS: [RegExp, string][] = [
  [/\b(He|She) is\b/g, "They are"], [/\b(he|she) is\b/g, "they are"],
  [/\b(He|She) was\b/g, "They were"], [/\b(he|she) was\b/g, "they were"],
  [/\b(He|She) has\b/g, "They have"], [/\b(he|she) has\b/g, "they have"],
  [/\bHis /g, "Their "], [/\bhis /g, "their "],
  [/\b(He|She)\b/g, "They"], [/\b(he|she)\b/g, "they"],
];

/** Keep only sentences that name nothing outside what the rows and facts
 *  carry, and that do not claim a technology whose row is not met. `names`
 *  are words that are people or companies here, whatever else they may be
 *  elsewhere (a candidate called Ray, an employer called Temporal). The
 *  model's choice of verb is not judged here: what it may say is decided by
 *  the rows, and a hedge is not a claim. Run on every bullet of the review
 *  before guardReview checks what each bullet rests on. */
export function guardNote(paragraph: string, rows: CardRow[], allowedText: string, material: string, questions = false, names: string[] = []): string {
  const isName = (group: string[]) => group.some((n) => names.some((x) => x.toLowerCase() === n.toLowerCase()));
  const unmetTech = rows.filter((r) => r.status === "unknown" || r.status === "no").flatMap((r) => technologiesNamed(stripExamples(r.label)));
  const kept = sentences(paragraph).filter((s) => {
    for (const group of technologiesNamed(s)) {
      if (isName(group)) continue;
      const inAllowed = namesAny(allowedText, [group]) || namesAny(material, [group]);
      if (!inAllowed) return false;
      if (questions) continue; // a question may name what is not shown; it claims nothing
      const unmet = unmetTech.some((g) => g[0] === group[0]);
      const metElsewhere = rows.some((r) => (r.status === "yes" || r.status === "equivalent") && namesAny(`${r.label} ${r.evidence} ${r.quote || ""} ${(r.quotes || []).map((q) => q.text).join(" ")}`, [group]));
      if (unmet && !metElsewhere) {
        // The negation (or the thing to confirm) must sit with the claim, in
        // the same clause: "has TypeScript experience, though not at scale"
        // still claims it; "confirm TypeScript depth on a call" does not.
        const clause = s.split(/[,;:]| but | though | although /i).find((part) => namesAny(part, [group])) || s;
        if (!NOT_A_CLAIM.test(clause)) return false;
      }
    }
    return true;
  });
  let text = kept.join(" ").trim();
  // A person whose name is He or She keeps it: the pronoun fix is skipped for them.
  if (!names.some((n) => /^(he|she)$/i.test(n))) for (const [re, to] of PRONOUNS) text = text.replace(re, to);
  return text;
}

/** The name a note uses: the person's name as they write it, without what is
 *  not a name (a title, an initial, a credential, an emoji). Guessing the
 *  given name goes wrong both ways ("Young" for Young Jean Han, "Maria del"
 *  for Maria del Carmen Lopez); the whole name is always right. No full stop
 *  survives, so a name never ends a sentence early. */
export function noteName(full: string | null | undefined): string {
  const NOT_A_NAME = /^(dr|mr|mrs|ms|miss|mx|prof|sir|jr|sr|ii|iii|iv|phd|md|mba|msc|bsc|cpa|cfa|pmp|esq)$/i;
  const parts = (full || "")
    .split(/[,|·•]/)[0]
    .split(/\s+/)
    .map((t) => t.replace(/\./g, ""))
    .filter((t) => /\p{L}/u.test(t) && t.replace(/[^\p{L}]/gu, "").length > 1 && !NOT_A_NAME.test(t));
  return parts.slice(0, 5).join(" ") || "The candidate";
}

/** A Pass says why. The reason is a Required row that reads "no"; when the
 *  note does not carry that row's numbers, the row's own evidence (written by
 *  code for a years row) is added as the last sentence. The sentence never
 *  names the label: the note outlives a recruiter's overrule, the label does not. */
export function withPassReason(paragraph: string, label: VerdictLabel, rows: CardRow[]): string {
  if (label !== "pass") return paragraph;
  const against = rows.filter((r) => r.tier === "required" && r.status === "no");
  const missing = against.filter((r) => {
    const bar = yearsBar(r.label);
    if (bar != null) return !new RegExp(`(?<![\\d.])${bar}\\s*\\+`).test(paragraph);
    const key = r.label.toLowerCase().match(/[a-z0-9+#.]{4,}/g) || [];
    return !sentences(paragraph).some((st) => NEGATION.test(st) && key.filter((w) => st.toLowerCase().includes(w)).length >= Math.min(2, key.length));
  });
  if (!missing.length) return paragraph;
  const why = missing.slice(0, 2).map((r) => (yearsBar(r.label) != null ? `On years: ${r.evidence}` : `Against: ${r.label}. ${r.evidence}`)).join(" ");
  return `${paragraph} ${why}`.trim();
}

/** A person held at "worth a message" by a years row a year short of the
 *  bar is told so, with the numbers, when the note does not carry them. When
 *  every other Required row is met, the note says that this is all that
 *  stands: worth a call. */
export function withShortReason(paragraph: string, label: VerdictLabel, rows: CardRow[]): string {
  if (label !== "message") return paragraph;
  const short = rows.find((r) => r.tier === "required" && r.status === "short" && r.numbers);
  if (!short?.numbers) return paragraph;
  const { have, bar } = short.numbers;
  // The numbers count only when one sentence states them together, and as
  // years: "3 months on it" here and "asks 4+ years" there say nothing about
  // the shortfall. A whole number of years may be written to a decimal.
  const haveRe = new RegExp(`(?<![\\d.])${String(have).replace(".", "\\.")}${Number.isInteger(have) ? "(\\.\\d+)?" : ""}\\s*(years?|yrs)\\b`, "i");
  const barRe = new RegExp(`(?<![\\d.])${bar}\\s*\\+`);
  if (sentences(paragraph).some((s) => haveRe.test(s) && barRe.test(s))) return paragraph;
  const others = rows.filter((r) => r.tier === "required" && r.id !== short.id);
  const allOthersMet = others.length > 0 && others.every((r) => r.status === "yes" || r.status === "equivalent");
  const sentence = allOthersMet ? `Meets every other Required row. ${years(have)} against the ${bar}+ bar, a year short. Worth a call.` : `A year short on the ${bar}+ bar.`;
  return `${paragraph} ${sentence}`.trim();
}

/** The numbers that decide a label are always in the review, whatever the
 *  model wrote: a Required years row a year short (the label held at
 *  message) and a Required row that reads no (a Pass) each get a gap bullet
 *  written by code when no gap bullet cites the row or states its numbers.
 *  Code-written, so it goes in after the guard, at the front. A fit bullet
 *  keeps only the met rows it cites (guardReview asks for at least one; an
 *  unmet row beside it would show as a "not shown" tag on a fit). */
export function withReviewReasons(review: Review, label: VerdictLabel, rows: CardRow[]): Review {
  const metIds = new Set(rows.filter((r) => r.status === "yes" || r.status === "equivalent").map((r) => r.id));
  const fits = review.fits.map((b) => ({ ...b, rowIds: b.rowIds.filter((id) => metIds.has(id)) }));
  const cited = new Set(review.gaps.flatMap((g) => g.rowIds));
  const stated = review.gaps.map((g) => g.text).join(" ");
  const added: ReviewBullet[] = [];
  const short = rows.find((r) => r.tier === "required" && r.status === "short" && r.numbers);
  if (short && !cited.has(short.id)) {
    const withShort = withShortReason(stated, label, rows);
    if (withShort !== stated) added.push({ text: withShort.slice(stated.length).trim(), rowIds: [short.id] });
  }
  const against = rows.filter((r) => r.tier === "required" && r.status === "no" && !cited.has(r.id));
  if (against.length) {
    const withPass = withPassReason(stated, label, rows.filter((r) => !cited.has(r.id)));
    if (withPass !== stated) added.push({ text: withPass.slice(stated.length).trim(), rowIds: against.slice(0, 2).map((r) => r.id) });
  }
  return { ...review, fits, gaps: [...added, ...review.gaps].slice(0, REVIEW_LIMITS.gaps) };
}

// ---------- rows decided by code ----------

/** The current career job as the facts chose it (an engineering role among
 *  those still "Present"); a current internship is not it. */
export function currentJobOf(jobs: JobText[], facts: CandidateFacts | null): JobText | null {
  const byFacts = facts?.currentTitle ? jobs.find((j) => j.career && j.current && j.title === facts.currentTitle && j.company === facts.currentCompany) : undefined;
  return byFacts || jobs.find((j) => j.career && j.current) || null;
}

/** At most `n` words around the first mention of a technology on the first
 *  line of the text that names it. Empty when no line does. */
export function wordsAround(text: string, tech: string[][], n = 12): string {
  const line = text.split("\n").find((l) => namesAny(l, tech));
  if (!line) return "";
  const words = line.split(/\s+/).filter(Boolean);
  const at = words.findIndex((w) => namesAny(w, tech));
  const start = at < 0 ? 0 : Math.max(0, Math.min(at - Math.floor(n / 2), words.length - n));
  return words.slice(start, start + n).join(" ").replace(/^[,;.·\s]+|[,;.·\s]+$/g, "");
}

const jobName = (j: JobText) => `${j.title}${j.company ? ` at ${j.company}` : ""}`;

// ---------- the judge ----------

export async function judgeWithScorecard(input: VerdictInput, allCriteria: Criterion[]): Promise<Verdict | null> {
  const started = Date.now();
  const timeout = input.timeoutMs ?? 30_000;
  const spareMs = () => timeout - (Date.now() - started);
  const facts = input.facts ?? null;
  const jobs = input.jobs ?? [];
  const m = materialOf(input, allCriteria);
  // Names that are not evidence of anything: every employer on the profile,
  // the companies the role targets, and the current employer's page name.
  const employers = [...new Set([...jobs.map((j) => j.company), ...input.targetedCompanies, (input.employerContext || "").split(/[(—:-]/)[0]].map((x) => (x || "").trim()).filter(Boolean))];
  const noise = jobs.map((j) => j.noise).join(" ");
  // The profile with "at <employer>" taken off its lines: a company called
  // Temporal or Prefect is where someone worked, not a technology they used,
  // so the profile rung of a tech row is read without those words.
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const profileSansEmployers = jobs.reduce(
    (text, j) => (j.company ? text.replace(new RegExp(`\\bat ${escapeRe(j.company)}(?![A-Za-z0-9])`, "g"), "at") : text),
    m.profileText
  );
  // The person's OWN material: what a quote must come from. Not the FACTS
  // block (code wrote it) and not the employer's description. A quote is
  // looked for line by line in the profile (a LinkedIn entry is one line)
  // and by nearness in the resume (PDF text wraps mid-sentence).
  const material = [m.profileText, m.resumeText, ...m.confirmedTrue].join("\n");
  const lineMaterial = [m.profileText, ...m.confirmedTrue].join("\n");
  const datedYears = facts?.engineeringYears == null ? null : m.basis === "career" ? facts.careerYears : Math.round((facts.engineeringYears + facts.unclassifiedYears) * 10) / 10;
  const currentJob = currentJobOf(jobs, facts);
  const memory = input.memory ?? new Map<string, Memory>();
  const memoryWrites: MemoryWrite[] = [];
  const now = new Date().toISOString();
  let usage = { input: 0, output: 0 };
  let calls = 0;

  const yearsRow = (c: Criterion, call: boolean): CardRow => {
    const ruled = careerYearsStatus(facts, yearsBar(c.label)!, m.basis);
    // Exceptional and Bonus rows never count against anyone, this one included.
    const st: RowStatus = ruled.status === "no" && c.tier !== "required" ? "unknown" : ruled.status;
    return {
      id: c.id, label: c.label, tier: c.tier, status: st, ai: st, evidence: ruled.evidence, call, confirmed: null, kind: "years", judgedBy: "code",
      ...(ruled.have != null ? { numbers: { have: ruled.have, bar: ruled.bar } } : {}),
      ...(facts?.engineeringYears != null ? { source: "Work history · dated positions" } : {}),
    };
  };

  const techRow = (c: Criterion, call: boolean): CardRow => {
    // What else does the job: what the row's own brackets name, and nothing
    // else. The ladder read here must be the one the editor, the job page and
    // the relabel show, and those read the card alone: an alternate the
    // employer declared on the role form stands in only once the card's
    // brackets name it (the drafter writes the role's stack there).
    const { names, accepted } = techSpec(c);
    const hasAccepted = accepted.length > 0;
    const ladder = techLadder(names.map((g) => g[0]), accepted.map((g) => g[0]));
    const name = names[0]?.[0] || "The technology";
    const careerJobs = jobs.filter((j) => j.career);
    const inResume = (tech: string[][]) => !!m.resumeText && namesAny(m.resumeText, tech);
    // Where a technology sits: the most recent career job that names it, else the resume.
    const found = (tech: string[][]): { job: JobText | null } | null => {
      const job = careerJobs.find((j) => namesAny(j.text, tech));
      if (job) return { job };
      return inResume(tech) ? { job: null } : null;
    };
    const dated = (tech: string[][]) => {
      const f = (facts?.skills || []).find((s) => !s.listedOnly && s.years > 0 && namesAny(s.skill, tech));
      return f ? ` ${years(f.years)} on dated jobs.` : "";
    };
    // The tag as written, else the words around the first mention on the job's line.
    const where = (j: JobText, tech: string[][]) => {
      const tag = j.tags.find((t) => namesAny(t, tech));
      return { phrase: `${tag ? "tagged" : "named"} on ${jobName(j)}`, quote: tag || wordsAround(j.text, tech), source: jobSource(j) };
    };
    let reach: TechReach;
    let evidence: string;
    let quote = "";
    let source: string | undefined;
    const onCurrent = !!currentJob && namesAny(currentJob.text, names);
    const named = onCurrent ? { job: currentJob } : found(names);
    const stand = !named ? accepted.find((g) => found([g])) : undefined;
    if (named && onCurrent) {
      const w = where(currentJob!, names);
      reach = "current"; evidence = `${name} ${w.phrase}; on the current job.${dated(names)}`; quote = w.quote; source = w.source;
    } else if (named) {
      reach = "named";
      if (named.job) { const w = where(named.job, names); evidence = `${name} ${w.phrase}.${dated(names)}`; quote = w.quote; source = w.source; }
      else { evidence = `${name} named in the resume.${dated(names)}`; quote = wordsAround(m.resumeText, names); source = "Resume"; }
    } else if (stand) {
      reach = "accepted";
      const f = found([stand])!;
      if (f.job) { const w = where(f.job, [stand]); evidence = `${stand[0]} on a job stands in for ${name} (${jobName(f.job)}).${dated([stand])}`; quote = w.quote; source = w.source; }
      else { evidence = `${stand[0]} in the resume stands in for ${name}.${dated([stand])}`; quote = wordsAround(m.resumeText, [stand]); source = "Resume"; }
    } else {
      // Not on a career job or in the resume: on the profile at all (the
      // skills list, the summary, an internship), or nowhere.
      const skillsLine = m.profileText.split("\n").find((l) => /^(all )?skills:/i.test(l.trim())) || "";
      const internship = (tech: string[][]) => jobs.find((j) => !j.career && namesAny(j.text, tech));
      const onProfile = (tech: string[][]) => namesAny(profileSansEmployers, tech) || !!internship(tech);
      const found2 = onProfile(names) ? names : accepted.find((g) => onProfile([g])) ? [accepted.find((g) => onProfile([g]))!] : null;
      if (found2) {
        reach = "profile";
        const what = found2[0][0];
        evidence = `${what} is on the profile (skills list, summary or an internship), not on a career job${what === name ? "" : `; ${name} is not named`}.`;
        const tag = skillsLine.replace(/^(all )?skills:/i, "").split(/,\s*/).map((t) => t.trim()).find((t) => t && namesAny(t, found2));
        const intern = internship(found2);
        if (tag) { quote = tag; source = "Skills list"; }
        else if (intern) { const w = where(intern, found2); quote = w.quote; source = w.source; }
        else { quote = wordsAround(profileSansEmployers, found2); source = "Profile"; }
      } else {
        reach = "none"; evidence = `${name} is not named on the profile or resume.`;
      }
    }
    // A quote is shown beside "copied from there", so it is kept only when
    // it really is there and says something.
    if (quote && quoteCheck(quote, lineMaterial, employers, noise, m.resumeText) !== "ok") quote = "";
    const status = techStatus(reach, metAtOf(c), hasAccepted);
    return {
      id: c.id, label: c.label, tier: c.tier, status, ai: status, evidence, call, confirmed: null, kind: "tech", judgedBy: "code",
      level: techLevel(reach, hasAccepted), levels: ladder.length, techReach: reach,
      ...(quote ? { quote, quotes: [{ text: quote, source: source || "Profile" }] } : {}), ...(source ? { source } : {}),
    };
  };

  const judgmentRow = (c: Criterion, call: boolean, read: { level: number; p: number[]; confidence: number; quote?: string; source?: string; quotes?: { text: string; source: string }[] }): CardRow => {
    const ladder = ladderOf(c);
    const level = Math.min(Math.max(1, Math.round(read.level)), ladder.length);
    const status = statusFromLevel(level, metAtOf(c));
    // "No single line to quote" is said of a met row only: remembered from a
    // pass where the row was met, it means nothing once the row counts from
    // a higher rung and is not.
    const source = read.source === NO_LINE_SOURCE && status !== "yes" && status !== "equivalent" ? undefined : read.source;
    // A record from before the lines were kept in threes carries one line.
    const quotes = read.quotes?.length ? read.quotes : read.quote ? [{ text: read.quote, source: read.source || "Profile" }] : [];
    return {
      id: c.id, label: c.label, tier: c.tier, status, ai: status, evidence: ladder[level - 1], call, confirmed: null, kind: "judgment", judgedBy: "jev",
      level, levels: ladder.length, p: read.p, confidence: read.confidence,
      ...(quotes.length ? { quote: quotes[0].text, quotes } : {}), ...(source ? { source } : {}),
    };
  };

  // ---- 1. rows by kind: code first, memory second, the judge last ----
  const rows: (CardRow | null)[] = allCriteria.map(() => null);
  type Pending = { c: Criterion; index: number; hash: string };
  const toAsk: Pending[] = [];
  allCriteria.forEach((c, i) => {
    const call = c.tier === "required" && !!c.confirmOnCall;
    const kind = rowKind(c);
    if (kind === "years") rows[i] = yearsRow(c, call);
    else if (kind === "tech") rows[i] = techRow(c, call);
    else {
      const hash = rowHash(c, m.materialHash);
      const known = memory.get(hash);
      if (known?.kind === "row") rows[i] = judgmentRow(c, call, known);
      else toAsk.push({ c, index: i, hash });
    }
  });

  // ---- 2. Jev: one request for every unremembered judgment row ----
  let unassessed = 0;
  const asked: Pending[] = [];
  if (toAsk.length) {
    const r = await jevJudgeLadders({
      candidate: { name: input.candidateName, profile: m.profileText, ...(m.resumeText ? { resume: m.resumeText } : {}), years: m.yearsLine, ...(m.confirmedTrue.length ? { confirmed: m.confirmedTrue } : {}) },
      criteria: toAsk.map((x) => x.c),
      timeoutMs: Math.min(timeout, 20_000),
    });
    if (isJevError(r)) {
      // Nothing partial is returned or remembered: the caller paces a retry
      // on the status (a key problem ends a run; a rate limit or a blip waits).
      console.error("verdict: jev", r.error, r.code || "", r.detail || "");
      if (r.status === 401) input.onError?.({ status: 401, code: "typesafe_key" });
      else if (r.status === 429) input.onError?.({ status: 429, code: r.code, retryAfter: r.retryAfter });
      else input.onError?.({ status: 0, code: r.code });
      return null;
    }
    calls++;
    usage = { input: usage.input + r.inputTokens, output: usage.output };
    toAsk.forEach((x, k) => {
      const a = r.answers[k];
      const call = x.c.tier === "required" && !!x.c.confirmOnCall;
      if (!a) {
        unassessed++;
        rows[x.index] = { id: x.c.id, label: x.c.label, tier: x.c.tier, status: "unknown", ai: "unknown", evidence: "Not assessed", call, confirmed: null, kind: "judgment" };
        return;
      }
      rows[x.index] = judgmentRow(x.c, call, { level: routeLevel(a.p, a.confidence), p: a.p, confidence: a.confidence });
      asked.push(x);
    });
  }

  // ---- 3. references: the line behind each rung reached, asked once ----
  // Never a status: the rows above are final before this call is made.
  const needRefs = asked.filter((x) => (rows[x.index]!.level ?? 1) >= 2);
  let refsFailed = false;
  if (needRefs.length) {
    const spare = spareMs();
    const found = spare >= 3_000
      ? await findReferences(
          needRefs.map((x) => ({ id: x.c.id, rung: rows[x.index]!.evidence })),
          { profileText: m.profileText, resumeText: m.resumeText, confirmed: m.confirmedTrue, jobs, employers, noise },
          { timeoutMs: Math.min(12_000, spare) }
        )
      : null;
    if (!found) refsFailed = true;
    else {
      calls++;
      usage = { input: usage.input + found.usage.input, output: usage.output + found.usage.output };
      for (const x of needRefs) {
        const row = rows[x.index]!;
        const ref = found.refs.get(x.c.id);
        if (ref) { row.quote = ref.quote; row.source = ref.source; row.quotes = ref.quotes; }
        // A met row with no line says so; an unmet row simply has none.
        else if (row.status === "yes" || row.status === "equivalent") row.source = NO_LINE_SOURCE;
      }
    }
  }
  // Remembered: what was asked this pass, with its reference. A row whose
  // reference call failed is shown without one and NOT remembered, so the
  // next review tries again; a row at rung 1 needs no reference.
  for (const x of asked) {
    const row = rows[x.index]!;
    if ((row.level ?? 1) >= 2 && refsFailed) continue;
    memoryWrites.push({
      hash: x.hash,
      record: { kind: "row", criterionId: x.c.id, level: row.level!, levels: row.levels!, p: row.p!, confidence: row.confidence!, ...(row.quote ? { quote: row.quote } : {}), ...(row.source ? { source: row.source } : {}), ...(row.quotes?.length ? { quotes: row.quotes } : {}), at: now },
    });
  }
  const finalRows = rows.map((r) => r!);

  // ---- 4. the label, by the fixed rules; the facts, by code ----
  let label: VerdictLabel = labelFromRows(finalRows, "message");
  // Recorded whenever the dated history is over a year short of the role's
  // minimum, whatever the label is today: the label is recomputed later (an
  // overrule, the call flag) and the rail must still hold then.
  const railNote = input.minYears != null && datedYears != null && datedYears < input.minYears - 1 ? `Dated history shows ${datedYears} years against ${input.minYears}+ required.` : null;
  if (label === "contact" && railNote) label = "message";
  const factItems = factLine(input, facts, jobs, m.basis);
  // The report card leads with the years the role's bar is about.
  // The profile's own skills list, as the profile text prints it, for the
  // skills never tagged on a dated job.
  const profileSkills = (m.profileText.split("\n").find((l) => /^(all )?skills:/i.test(l.trim())) || "").replace(/^\s*(all )?skills:/i, "").split(/,\s*/).map((t) => t.trim()).filter(Boolean);
  const profile = { ...profileFacts({ facts, jobs, education: input.education ?? null, employer: input.employer ?? null, profileSkills }), basis: m.basis };
  const openRequired = finalRows.filter((r) => r.tier === "required" && r.status !== "yes" && r.status !== "equivalent");
  const missing = openRequired
    .map((r) => (r.status === "no" ? `${r.label}: against.` : r.status === "short" && r.numbers ? `${r.label}: ${years(r.numbers.have)} against ${r.numbers.bar}+, a year short.` : `${r.label}: not shown on the profile.`))
    .slice(0, 4);

  // ---- 5. the review, from the rows, the facts and the role's own words ----
  const first = noteName(input.candidateName);
  const mark = (s: RowStatus) => (s === "yes" ? "YES" : s === "equivalent" ? "EQUIVALENT" : s === "no" ? "NO" : s === "short" ? "SHORT (within a year of the bar)" : "UNKNOWN (not shown)");
  const nHash = noteHash(finalRows, label, factItems, input.roleWords);
  const remembered = memory.get(nHash);
  let paragraph = "";
  let ask: string[] = [];
  let review: Review;
  // The single-call note's "better suited" line has no place in the review;
  // the field stays empty for older readers.
  const betterSuited = "";
  if (remembered?.kind === "note" && isReview(remembered.review)) {
    paragraph = remembered.paragraph;
    ask = remembered.ask;
    review = remembered.review;
  } else {
    const linesOf = (r: CardRow) => (r.quotes?.length ? r.quotes : r.quote ? [{ text: r.quote, source: r.source || "Profile" }] : []);
    const rowLine = (r: CardRow) => {
      const lines = linesOf(r);
      return `- [${r.id}] (${r.tier}) ${r.label}: ${mark(r.status)}. ${r.evidence}${lines.length ? ` Lines copied from the material: ${lines.map((q) => `"${q.text}" (${q.source})`).join("; ")}` : ""}`;
    };
    const words = roleWordsOf(input.roleWords);
    const roleBlock = [
      words.about ? `About: ${words.about}` : "",
      words.needs.length ? `Needs:\n${words.needs.map((x) => `- ${x}`).join("\n")}` : "",
      words.doing.length ? `Doing:\n${words.doing.map((x) => `- ${x}`).join("\n")}` : "",
      words.techStack ? `Tech stack: ${words.techStack}` : "",
    ].filter(Boolean).join("\n");
    const reviewUser =
      `ROLE: ${input.roleTitle}\nCANDIDATE'S NAME, AS TO WRITE IT: ${first}\nLABEL SHOWN BESIDE THE REVIEW: ${label === "contact" ? "Contact now" : label === "message" ? "Worth a message" : "Pass"}\n\n` +
      `FACTS:\n${factItems.map((f) => `- ${f}`).join("\n") || "- (none)"}\n\n` +
      `ROWS (id, tier, status, what was found, the lines copied from the material):\n${finalRows.map(rowLine).join("\n")}` +
      (roleBlock ? `\n\nTHE ROLE'S OWN WORDS (for phrasing the fit only; not evidence about the person):\n${roleBlock}` : "");
    const spare = spareMs();
    // A missing review never fails the person: code writes one, and the
    // verdict is not remembered, so the next review gets a proper one.
    const n = spare >= 3_000
      ? await askOpenAI({ model: NOTE_MODEL, system: REVIEW_SYSTEM, user: reviewUser, schemaName: "scorecard_review", schema: reviewSchema(finalRows.map((r) => r.id)), timeoutMs: Math.min(15_000, spare) })
      : null;
    if (n) {
      calls++;
      usage = { input: usage.input + n.usage.input, output: usage.output + n.usage.output };
    }
    // Every sentence is held to the rows and facts first (guardNote: no
    // technology from outside them, no claim on an unmet row, they/their),
    // then each bullet to the rows it cites (guardReview).
    const allowedText = `${factItems.join("\n")}\n${finalRows.map((r) => `${r.label} ${r.evidence} ${linesOf(r).map((q) => q.text).join(" ")}`).join("\n")}`;
    const names = [...first.split(/\s+/), ...employers];
    const tidy = (x: unknown) => noDashes(String(x ?? "")).replace(/\s+/g, " ").trim();
    const held = (x: unknown, questions: boolean) => guardNote(tidy(x), finalRows, allowedText, material, questions, names);
    const bulletsOf = (list: unknown, questions: boolean): ReviewBullet[] =>
      (Array.isArray(list) ? list : []).map((b) => {
        const raw = (b ?? {}) as { text?: unknown; row_ids?: unknown };
        return { text: held(raw.text, questions), rowIds: (Array.isArray(raw.row_ids) ? raw.row_ids : []).map((id) => String(id)) };
      });
    const draft = n
      ? guardReview(
          // A fit and the bottom line are claims; a gap and a question may
          // name what is not shown.
          { bottomLine: held(n.out.bottom_line, false), fits: bulletsOf(n.out.fits, false), gaps: bulletsOf(n.out.gaps, true), ask: (Array.isArray(n.out.ask) ? n.out.ask : []).map((q) => held(q, true)) },
          finalRows,
          material
        )
      : null;
    // The model's review stands when it has a bottom line and, for a person
    // the rows make a contact or a message with something met, at least one
    // fit bullet survived the guard; else code writes the review.
    const anyMet = finalRows.some((r) => r.status === "yes" || r.status === "equivalent");
    const fromModel = !!draft && !!draft.bottomLine && !((label === "contact" || label === "message") && anyMet && !draft.fits.length);
    review = withReviewReasons(fromModel ? draft! : fallbackReview(finalRows, label), label, finalRows);
    // The paragraph, for older readers: the bottom line and the first fit.
    paragraph = `${review.bottomLine} ${review.fits[0]?.text ?? ""}`.trim().slice(0, 700);
    ask = review.ask;
    if (fromModel && !unassessed) memoryWrites.push({ hash: nHash, record: { kind: "note", paragraph, missing, ask, betterSuited, review, at: now } });
  }

  // ---- 6. technologies, by code: the current job against the rest ----
  const techOf = (text: string) => technologiesNamed(text).map((g) => g[0]);
  const uniq = (list: string[]) => {
    const seen = new Set<string>();
    return list.filter((t) => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  const technologiesNow = currentJob ? uniq(techOf(currentJob.text)).slice(0, 8) : [];
  const nowSet = new Set(technologiesNow.map((t) => t.toLowerCase()));
  const skillsLine = m.profileText.split("\n").find((l) => /^(all )?skills:/i.test(l.trim())) || "";
  const technologiesBefore = uniq([
    ...jobs.filter((j) => j !== currentJob).flatMap((j) => techOf(j.text)),
    ...techOf(skillsLine),
    // A resume with no profile behind it: its technologies are all there is.
    ...(!jobs.length ? techOf(m.resumeText) : []),
  ]).filter((t) => !nowSet.has(t.toLowerCase())).slice(0, 8);

  const requirements: RequirementRead[] = finalRows
    .filter((r) => r.status === "yes" || r.status === "equivalent" || r.tier === "required")
    .map((r) => ({
      requirement: r.label,
      status: r.status === "yes" ? ("met" as const) : r.status === "equivalent" ? ("equivalent" as const) : ("missing" as const),
      evidence: r.evidence,
    }));

  return {
    label,
    paragraph,
    missing,
    ask,
    betterSuited,
    requirements,
    rows: finalRows,
    aiLabel: label,
    railNote,
    unassessed,
    facts: factItems,
    profile,
    review,
    technologiesNow,
    technologiesBefore,
    model: "code+jev",
    promptVersion: SCORECARD_JUDGE_VERSION,
    usage,
    ms: Date.now() - started,
    memoryWrites,
    calls,
  };
}
