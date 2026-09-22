// Judging a person against a role's scorecard, in three parts, so that
// nothing a recruiter reads can be invented:
//
//   1. ROWS (model): every row gets a status, and every tick must QUOTE the
//      words on the person's own profile that decide it.
//   2. CODE: years rows by rule; a tick whose quote is not on the profile, is
//      only a generic title or an employer name, or hedges ("suggests") is
//      removed; a row that names a technology is met on a JOB (not the skills
//      list, not an internship alone); the label follows the rows; the fact
//      line about the person is written here from dated positions.
//   3. NOTE (model): the paragraph is written from the finished rows and the
//      fact line ONLY. That call never sees the profile, so it has nothing to
//      invent from; what it writes is still checked, with a code-written
//      paragraph as the fallback.
//
// Measured before this existed (17 people, one role): the single-call judge
// wrote "strong TypeScript backend experience" for three people whose
// profiles never mention TypeScript, beside a row that said "not shown".

import type { Verdict, VerdictInput } from "../verdict";
import { workKind, type CandidateFacts, type JobText } from "../facts";
import type { RequirementRead, VerdictLabel } from "@/lib/verdict-view";
import { sentences } from "@/lib/verdict-view";
import { namesAny, technologiesNamed } from "@/lib/tech-terms";
import { careerYearsStatus, isCareerYearsRow, labelFromRows, yearsBar, type CardRow, type Criterion, type RowStatus } from "@/lib/rolecard";

export const SCORECARD_JUDGE_VERSION = "v12";

const ROWS_SYSTEM = `You are a careful technical recruiter checking one candidate against a role's scorecard. You have the candidate's LinkedIn profile (and a resume when supplied), a FACTS block computed in code from their dated positions, and the role. Answer EVERY scorecard row, by its id.

STATUS
- yes: the candidate's own material shows it.
- equivalent: the thing itself is not shown, but a DIFFERENT thing that does the same job is: an alternative the row accepts, a concrete instance of a category ("vector database" by pgvector or Pinecone; "orchestration" by Temporal or Airflow; "cloud" by AWS, GCP or Azure), or the same work in another technology. Say what stands in. Never for the right thing in a smaller amount: that is unknown.
- unknown: the material does not show it. The honest answer for a thin profile and for anything a LinkedIn profile would not normally say.
- no: the material gives positive evidence AGAINST it: a career plainly in another discipline. Never from silence, never from low dated years.

EVIDENCE IS THE PERSON'S OWN WORDS
- Read for meaning, not for keywords. A title, a team name or a line of a description that names the work shows it: "Fraud Detection Lead" or "risk models" shows fraud-detection work; "Search Infra" shows infrastructure work. Skill tags on a job are that job's work: Kafka and Flink tagged on a job show stream processing. The note after each row gives EXAMPLES of evidence: any one of them, or anything that says the same in other words.
- A title that itself names the work counts ("Payments Engineer", "Search Platform lead", "Founding Engineer" for an early-engineer row). A generic title ("Software Engineer", "Member of Technical Staff") with an employer and a tenure shows nothing about a row: unknown.
- Where someone works is never evidence for a row: not the employer's product, its technology stack, its reputation, or that the role targets it.
- quote: for every yes or equivalent, copy the words from the PROFILE or RESUME that decide it, exactly as written there, at most 12 words: a skill tag, a line of a description, a title that names the work. If you cannot quote it, the status is unknown. For unknown and no, quote is "".
- evidence: one plain statement of at most 14 words: the fact that decides it, or for unknown, what is not shown. Never write suggests, implies, indicates, probably or likely.
- Technology rows: a technology counts when it is tagged or named on a JOB (a position's skills or description) or in the resume. A mention only in the profile's skills list is unknown, and the evidence says so. Per-skill years in FACTS count only the positions where the skill is tagged, so they are a floor, never a reason for no.
- Statements under CONFIRMED BY THE RECRUITER were checked by a person. They are true, they outrank the profile, and they may be quoted.

ALSO RETURN technologies_now (technologies tagged or named on the CURRENT job, or in the resume's most recent role; at most 8; names only, never soft skills) and technologies_before (from earlier jobs, or the profile's skills list; most recent first; at most 8; none already in technologies_now). Only technologies the material names.`;

const NOTE_SYSTEM = `You write the short note a recruiter reads in ten seconds beside a candidate's scorecard. Everything you may say is in the message: FACTS, computed in code from dated positions, and ROWS, already decided, each with the words from the profile that decided it. You have not seen the profile. Add nothing to what is there.

Write 2 to 4 sentences, at most 70 words:
1. Who they are, from FACTS: current title and company, how long they have been there, and their years as FACTS words them (in engineering roles, or of career). When FACTS says they worked at a company this role targets, say so as a fact.
2. What the profile shows for this role: only rows marked yes or equivalent, each with its evidence. For an equivalent, say what stands in for what.
3. What is not shown, or is against: the Required rows marked unknown or no, plainly ("TypeScript is not shown on the profile"). A years row is never "not shown": say its numbers ("3 years against the 4+ asked"). When the label is Pass, say which Required row is against and its numbers. When most rows are unknown, say the profile is thin in a few words ("The profile is titles only").

Never state or imply experience for a row marked unknown. Never name a technology, product, duty or employer that is not in FACTS or ROWS. Never write suggests, implies, likely, probably, potential or ramp. Give no advice and no call to action: the label is shown beside the note. Use the candidate's name once, exactly as given, then "they" and "their", never he or she. No bullets, no headings, no quotation marks.

ALSO RETURN: missing (0 to 4 short plain statements: the Required rows that are unknown or no first, then Exceptional ones), ask (0 to 3 short questions for a first call, one per unknown Required row first), better_suited (only when the label is pass or message AND FACTS points somewhere specific, such as years in another discipline: one sentence naming where they would fit; otherwise an empty string).`;

type RowOut = { id: string; status: RowStatus; quote: string; evidence: string };

// The judge reads the whole resume. It was shown the first 3,000 characters,
// and every one of the first eight resumes on file is longer than that
// (typically 4,850): earlier jobs and the skills section were never seen.
const RESUME_CHARS = 12_000;
const NOT_QUOTED = "Not shown on the profile: nothing written there says this.";
// The judge's own words gave its tick away as an inference (suggests, implies).
const HEDGED = "Not shown on the profile.";
// A title, an employer and a date say nothing about a row: that tick was an
// inference from where the person works, and gets no second look.
const SAYS_NOTHING = "Not shown on the profile: a title and an employer do not say this.";
const HEDGE = /\b(suggests?|impl(y|ies|ied)|indicat(es?|ing)|presumably|probably|likely|potential)\b/i;
// Words that say nothing about the work: generic title words, seniority,
// and what a copied profile line drags along with it (dates, tenure, place).
const GENERIC_WORDS = new Set([
  "software", "engineer", "engineering", "developer", "senior", "junior", "staff", "member", "technical", "intern", "internship",
  "principal", "lead", "sr", "jr", "associate", "head", "mts", "swe", "sde", "founding", "team",
  "the", "and", "for", "with", "from", "at", "of", "in", "to", "a", "an", "ii", "iii", "iv", "full", "part", "time", "contract", "present",
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
  "yr", "yrs", "year", "years", "mo", "mos", "month", "months", "remote", "hybrid", "onsite", "united", "states", "area", "greater", "city", "new", "york", "san", "francisco", "bay", "london",
]);
const tokens = (s: string) => (s.toLowerCase().match(/[a-z0-9+#]+(?:\.[a-z0-9]+)*/g) || []).filter((t) => t.length >= 2);

/** Is the quote really on the person's profile, and does it SAY something?
 *  What is left of the quote once generic title words, seniority, the
 *  employers' names, dates, tenure and places are taken out must (1) not be
 *  empty, (2) be on the profile in full, and (3) sit together on one line of
 *  it. "Software Engineer. at Cognition. Sep 2025 - Present. New York" is a
 *  copied line and proves nothing; a quote stitched from a skill here and a
 *  city there proves nothing; one invented word in a real line proves nothing. */
export function quoteIsGrounded(quote: string, material: string, employers: string[], noise = ""): boolean {
  return quoteCheck(quote, material, employers, noise) === "ok";
}

/** Why a quote fails. "empty": it is a generic title, an employer, a date or
 *  a place, which says nothing about any row (an inference from where someone
 *  works). "absent": it says something, but those words are not on the
 *  profile (a paraphrase, or the scorecard's own note copied back). */
export function quoteCheck(quote: string, material: string, employers: string[], noise = "", resume = ""): "ok" | "empty" | "absent" {
  const content = quoteContent(quote, employers, noise);
  if (!content.length) return "empty";
  const onOneLine = [material, resume].join("\n").split("\n").some((line) => {
    const lt = new Set(tokens(line));
    return content.every((t) => lt.has(t));
  });
  return onOneLine || (!!resume && acrossAWrap(quote, resume)) ? "ok" : "absent";
}

/** What a quote says once generic title words, seniority, the employers'
 *  names, dates, tenure and places are taken out. */
function quoteContent(quote: string, employers: string[], noise = ""): string[] {
  const q = quote.replace(/["“”‘’…]/g, " ").replace(/\s+/g, " ").trim();
  if (q.length < 2) return [];
  const skip = new Set([...employers.flatMap((e) => tokens(e)), ...tokens(noise)]);
  return [...new Set(tokens(q).filter((t) => !GENERIC_WORDS.has(t) && !skip.has(t) && !/^\d+$/.test(t)))];
}

/** A resume is text out of a PDF: a bullet wraps across two or three lines
 *  wherever the page was narrow, so "on one line" alone rejects true quotes
 *  (5 of the first 8 stored resumes wrap). A quote that is not on one line
 *  is looked for across the wrap, strictly: ALL of its words, in the quote's
 *  own order, back to back, with room for two stray tokens at most (a page
 *  number, a word the judge dropped). A line wrap adds no words, so a true
 *  quote needs no more room than that. Looser tests let a quote be stitched
 *  from neighbouring bullets: "Led a team of 8 engineers" from "worked
 *  alongside a team of 8 engineers ... Led migration of" (words near each
 *  other), and "6 years building machine learning infrastructure" from "6
 *  years at Acme; building internal tools. Evaluated machine learning
 *  infrastructure vendors" (in order, six words of slack). */
function acrossAWrap(quote: string, text: string): boolean {
  const q = tokens(quote.replace(/["“”‘’…]/g, " "));
  if (q.length < 3) return false;
  const t = tokens(text);
  const span = q.length + 2;
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== q[0]) continue;
    let k = 1;
    for (let j = i + 1; j < Math.min(t.length, i + span) && k < q.length; j++) if (t[j] === q[k]) k++;
    if (k === q.length) return true;
  }
  return false;
}

/** WHERE an answer was found, for the line under it: the job, the resume,
 *  the skills list, the summary, education. Worked out in code from where
 *  the quote sits, never asked of the model, so it cannot be invented. */
export function sourceOfQuote(quote: string, a: { jobs: JobText[]; profileText: string; resumeText?: string | null; confirmed: string[]; employers: string[]; noise: string }): string | undefined {
  const content = quoteContent(quote, a.employers, a.noise);
  if (!content.length) return undefined;
  const within = (text: string) => { const t = new Set(tokens(text)); return content.every((w) => t.has(w)); };
  // One line of one job (its title, its skill tags, a line of its
  // description) before anything looser: a job's whole text as a bag of words
  // claimed quotes that were really on the resume, or on another job.
  const onALine = a.jobs.find((j) => j.text.split("\n").some(within));
  if (onALine) return jobSource(onALine);
  if (a.resumeText && (a.resumeText.split("\n").some(within) || acrossAWrap(quote, a.resumeText))) return "Resume";
  if (a.confirmed.some(within)) return "Confirmed earlier by your team";
  const job = a.jobs.find((j) => within(j.text));
  if (job) return jobSource(job);
  const lines = a.profileText.split("\n");
  const at = lines.findIndex(within);
  if (at < 0) return undefined;
  if (/^(all )?skills:/i.test(lines[at].trim())) return "Skills list";
  // The profile prints a job as one line ("Founding Engineer. at Perch. Jan
  // 2025 - Feb 2026. Skills: TypeScript, …"): a quote found on it is that job's.
  const ofJob = a.jobs.find((j) => j.title && lines[at].startsWith(j.title));
  if (ofJob) return jobSource(ofJob);
  const isJobLine = (line: string) => a.jobs.some((j) => j.title && line.startsWith(j.title));
  const jobLines = lines.map((l, i) => (isJobLine(l) ? i : -1)).filter((i) => i >= 0);
  if (jobLines.length && at < jobLines[0]) return "Profile summary";
  if (jobLines.length && at > jobLines[jobLines.length - 1]) return "Education";
  return "Profile";
}
const jobSource = (j: JobText) => `Work history · ${[j.title, j.company && `at ${j.company}`].filter(Boolean).join(" ")}`.slice(0, 120);

const stripExamples = (label: string) => label.replace(/\(.*?\)/g, " ").replace(/(\be\.g\.|\bsuch as\b|\blike\b|\bor similar\b|\bincluding\b).*$/i, " ");
/** What else the row itself accepts: only what its brackets name. The
 *  "examples of evidence" note is NOT a list of substitutes (it may well name
 *  Kubernetes as evidence of backend work on a TypeScript row). */
const bracketed = (label: string) => (label.match(/\(([^)]*)\)/g) || []).join(" ");

/** Is a quote about this row at all? It shares a word (by its first five
 *  letters: "infra" and "infrastructure", "eval" and "evaluation") with the
 *  row's label or note, or it names a technology. Used only on a second look. */
function aboutTheRow(quote: string, c: Criterion): boolean {
  if (technologiesNamed(quote).length) return true;
  const key = (t: string) => t.slice(0, 5);
  const rowWords = new Set(tokens(`${c.label} ${c.good || ""}`).filter((t) => t.length >= 4 && !GENERIC_WORDS.has(t)).map(key));
  return tokens(quote).some((t) => t.length >= 4 && !GENERIC_WORDS.has(t) && (rowWords.has(key(t)) || [...rowWords].some((w) => w.startsWith(t) || t.startsWith(w))));
}

function reasonNotOnAJob(tech: string[][], profileText: string, jobs: JobText[]): string {
  const name = tech[0]?.[0] || "It";
  if (jobs.some((j) => !j.career && namesAny(j.text, tech))) return `${name} is tagged on an internship only; other use is not shown.`;
  if (namesAny(profileText, tech)) return `${name} is in the profile's skills list only, not tied to a job.`;
  return `${name} is not named on the profile or resume.`;
}

async function callOpenAI(
  input: VerdictInput,
  system: string,
  user: string,
  schemaName: string,
  schema: Record<string, unknown>,
  timeoutMs: number,
  reportErrors: boolean
): Promise<{ out: Record<string, unknown>; usage: { input: number; output: number } } | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: input.model,
      temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  }).catch((e: unknown) => {
    if (reportErrors) input.onError?.({ status: 0, code: e instanceof Error ? e.name : "fetch_failed" });
    return null;
  });
  if (!res) return null;
  if (!res.ok) {
    let code: string | undefined;
    let body = "";
    try {
      body = await res.text();
      code = (JSON.parse(body) as { error?: { code?: string } })?.error?.code;
    } catch {
      /* body unreadable */
    }
    console.error(`verdict(${schemaName}): openai`, res.status, code || "", body.slice(0, 300));
    if (reportErrors) input.onError?.({ status: res.status, code, retryAfter: res.headers.get("retry-after") ?? undefined });
    return null;
  }
  try {
    const data = (await res.json()) as { choices: { message: { content: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    return { out: JSON.parse(data.choices[0].message.content), usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 } };
  } catch {
    return null;
  }
}

const cleanTech = (list: unknown, material: string): string[] => {
  const seen = new Set<string>();
  return (Array.isArray(list) ? list : [])
    .map((t) => String(t || "").trim().replace(/\s+/g, " "))
    .filter((t) => t.length >= 2 && t.length <= 40)
    // Only technologies the person's material actually names.
    .filter((t) => {
      const known = technologiesNamed(t);
      return known.length ? namesAny(material, known) : material.toLowerCase().includes(t.toLowerCase());
    })
    .filter((t) => {
      const k = t.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 8);
};

const years = (n: number) => `${n} ${n === 1 ? "year" : "years"}`;

const companyKey = (name: string) =>
  name.toLowerCase().replace(/[.,]/g, " ").replace(/\b(inc|llc|lp|ltd|plc|corp|corporation|co|company|investments?|technologies|labs?|ai|the)\b/g, " ").replace(/\s+/g, " ").trim();
/** "Two Sigma" is "Two Sigma Investments, LP"; "Meta" is not "Metaphor". */
const sameCompany = (a: string, b: string) => {
  const x = companyKey(a), y = companyKey(b);
  return !!x && !!y && (x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `));
};

/** Facts about the person, written by code from dated positions. Where they
 *  work and what that company does appears here, once, as a fact: never as a
 *  tick or a "likely" on a row. */
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
const PRONOUNS: [RegExp, string][] = [
  [/\b(He|She) is\b/g, "They are"], [/\b(he|she) is\b/g, "they are"],
  [/\b(He|She) was\b/g, "They were"], [/\b(he|she) was\b/g, "they were"],
  [/\b(He|She) has\b/g, "They have"], [/\b(he|she) has\b/g, "they have"],
  [/\bHis /g, "Their "], [/\bhis /g, "their "],
];

/** Keep only sentences that name nothing outside what the rows and facts
 *  carry, and that do not claim a technology whose row is not met. `names`
 *  are words that are people or companies here, whatever else they may be
 *  elsewhere (a candidate called Ray, an employer called Temporal). */
export function guardNote(paragraph: string, rows: CardRow[], allowedText: string, material: string, questions = false, names: string[] = []): string {
  const isName = (group: string[]) => group.some((n) => names.some((x) => x.toLowerCase() === n.toLowerCase()));
  const unmetTech = rows.filter((r) => r.status === "unknown" || r.status === "no").flatMap((r) => technologiesNamed(stripExamples(r.label)));
  const kept = sentences(paragraph).filter((s) => {
    if (HEDGE.test(s) || /\bramp\b/i.test(s)) return false;
    for (const group of technologiesNamed(s)) {
      if (isName(group)) continue;
      const inAllowed = namesAny(allowedText, [group]) || namesAny(material, [group]);
      if (!inAllowed) return false;
      if (questions) continue; // a question may name what is not shown; it claims nothing
      const unmet = unmetTech.some((g) => g[0] === group[0]);
      const metElsewhere = rows.some((r) => (r.status === "yes" || r.status === "equivalent") && namesAny(`${r.label} ${r.evidence} ${r.quote || ""}`, [group]));
      if (unmet && !metElsewhere) {
        // The negation must sit with the claim, in the same clause: "has
        // TypeScript experience, though not at scale" still claims it.
        const clause = s.split(/[,;:]| but | though | although /i).find((part) => namesAny(part, [group])) || s;
        if (!NEGATION.test(clause)) return false;
      }
    }
    return true;
  });
  let text = kept.join(" ").trim();
  for (const [re, to] of PRONOUNS) text = text.replace(re, to);
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

function fallbackNote(first: string, facts: string[], rows: CardRow[]): string {
  const met = rows.filter((r) => r.status === "yes" || r.status === "equivalent").map((r) => r.label);
  const open = rows.filter((r) => r.tier === "required" && r.status === "unknown").map((r) => r.label);
  const against = rows.filter((r) => r.tier === "required" && r.status === "no");
  return [
    facts[0] ? `${first}: ${facts[0]}${facts[1] ? `; ${facts[1].split(";")[0]}` : ""}.` : "",
    met.length ? `The profile shows: ${met.slice(0, 4).join("; ")}.` : "The profile shows little for this role.",
    against.length ? `Against: ${against.map((r) => r.evidence).slice(0, 2).join(" ")}` : "",
    open.length ? `Not shown: ${open.slice(0, 3).join("; ")}.` : "",
  ].filter(Boolean).join(" ");
}

export async function judgeWithScorecard(input: VerdictInput, allCriteria: Criterion[]): Promise<Verdict | null> {
  const started = Date.now();
  const facts = input.facts ?? null;
  const jobs = input.jobs ?? [];
  // Names that are not evidence of anything: every employer on the profile,
  // the companies the role targets, and the current employer's page name.
  const employers = [...new Set([...jobs.map((j) => j.company), ...input.targetedCompanies, (input.employerContext || "").split(/[(—:-]/)[0]].map((x) => (x || "").trim()).filter(Boolean))];
  const noise = jobs.map((j) => j.noise).join(" ");
  const asked = allCriteria.filter((c) => !isCareerYearsRow(c.label));
  // What a recruiter confirmed as TRUE about the person. A confirmed "no"
  // names the requirement too, and must never be read as evidence for it.
  const confirmedTrue = (input.confirmedFacts || []).filter((f) => !/:\s*no\b/i.test(f));
  // The person's OWN material: what a quote must come from. Not the FACTS
  // block (code wrote it) and not the employer's description.
  const material = [input.profileText, input.resumeText || "", ...confirmedTrue].join("\n");
  // A quote is looked for line by line in the profile (a LinkedIn entry is
  // one line) and by nearness in the resume (PDF text wraps mid-sentence).
  const lineMaterial = [input.profileText, ...confirmedTrue].join("\n");
  const resume = input.resumeText || "";
  const whereFrom = (quote: string) => sourceOfQuote(quote, { jobs, profileText: input.profileText, resumeText: resume, confirmed: confirmedTrue, employers, noise });
  // A years bar is about engineering years on an engineering role, and about
  // the career on any other (a data science or product role). Decided once.
  const basis: "engineering" | "career" = workKind(input.roleTitle) === "engineering" || allCriteria.some((c) => isCareerYearsRow(c.label) && /\b(engineer|developer|software)/i.test(c.label)) ? "engineering" : "career";
  const datedYears = facts?.engineeringYears == null ? null : basis === "career" ? facts.careerYears : Math.round((facts.engineeringYears + facts.unclassifiedYears) * 10) / 10;

  // ---- 1. rows ----
  let rowsOut: RowOut[] = [];
  let techNow: string[] = [];
  let techBefore: string[] = [];
  let usage = { input: 0, output: 0 };
  let rowsUser = "";
  const rowsSchema = (ids: string[], withTech: boolean) => ({
    type: "object",
    additionalProperties: false,
    properties: {
      rows: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", enum: ids },
            status: { type: "string", enum: ["yes", "equivalent", "unknown", "no"] },
            quote: { type: "string" },
            evidence: { type: "string" },
          },
          required: ["id", "status", "quote", "evidence"],
        },
      },
      ...(withTech ? { technologies_now: { type: "array", items: { type: "string" } }, technologies_before: { type: "array", items: { type: "string" } } } : {}),
    },
    required: withTech ? ["rows", "technologies_now", "technologies_before"] : ["rows"],
  });
  if (asked.length) {
    const user =
      `ROLE: ${input.roleTitle}${input.minYears ? ` (${input.minYears}+ years)` : ""}\n\n` +
      `JOB DESCRIPTION:\n${input.jdText.slice(0, 4000)}\n\n` +
      `SCORECARD (answer every row by id):\n${asked
        .map((c) => `- [${c.id}] (${c.tier}) ${c.label}${c.good ? ` :: examples of evidence (any one, or anything that says the same in other words): ${c.good}` : ""}`)
        .join("\n")}\n\n` +
      (input.confirmedFacts?.length ? `CONFIRMED BY THE RECRUITER:\n${input.confirmedFacts.slice(-12).map((f) => `- ${f}`).join("\n")}\n\n` : "") +
      `CANDIDATE: ${input.candidateName}\nLINKEDIN PROFILE:\n${input.profileText.slice(0, 5000)}\n\n` +
      (input.resumeText ? `RESUME:\n${input.resumeText.slice(0, RESUME_CHARS)}\n\n` : "") +
      `FACTS (computed in code from dated positions):\n${input.factsBlock}`;
    rowsUser = user;
    const r = await callOpenAI(input, ROWS_SYSTEM, user, "scorecard_rows", rowsSchema(asked.map((c) => c.id), true), input.timeoutMs ?? 30_000, true);
    if (!r) return null;
    rowsOut = Array.isArray(r.out.rows) ? (r.out.rows as RowOut[]) : [];
    techNow = cleanTech(r.out.technologies_now, material);
    techBefore = cleanTech(r.out.technologies_before, material).filter((t) => !techNow.some((n) => n.toLowerCase() === t.toLowerCase()));
    usage = r.usage;
  }

  // ---- 2. code ----
  const idOf = (x: string) => String(x || "").replace(/^[\s\[]+|[\s\]]+$/g, "").toLowerCase();
  const answerFor = (list: RowOut[], c: Criterion) => list.find((x) => x && idOf(x.id) === c.id.toLowerCase());
  const decide = (c: Criterion, r: RowOut | undefined): CardRow => {
    const call = c.tier === "required" && !!c.confirmOnCall;
    if (isCareerYearsRow(c.label)) {
      const ruled = careerYearsStatus(facts, yearsBar(c.label)!, basis);
      // Exceptional and Bonus rows never count against anyone, this one included.
      const st: RowStatus = ruled.status === "no" && c.tier !== "required" ? "unknown" : ruled.status;
      return { id: c.id, label: c.label, tier: c.tier, status: st, evidence: ruled.evidence, ai: st, call, confirmed: null, ...(facts?.engineeringYears != null ? { source: "Work history · dated positions" } : {}) };
    }
    let status: RowStatus = r && ["yes", "equivalent", "unknown", "no"].includes(r.status) ? r.status : "unknown";
    let evidence = (r?.evidence || (r ? "" : "Not assessed")).trim().slice(0, 180);
    // Cut a long quote at a separator: a word cut in half is a word that is
    // "not on the profile", and a real tick was lost that way.
    const rawQuote = (r?.quote || "").trim();
    let quote = rawQuote.length <= 160 ? rawQuote : rawQuote.slice(0, 160).replace(/[,;.·]?\s*[^\s,;.·]*$/, "");
    let dropped: CardRow["dropped"];
    let source: string | undefined;
    const drop = (why: string) => {
      // Kept on the row (never shown) so a wrongly removed tick can be found.
      dropped = { status, quote: rawQuote.slice(0, 200), evidence: evidence.slice(0, 160), why };
      status = "unknown";
      evidence = why;
      quote = "";
    };
    // Exceptional and Bonus rows never count against anyone.
    if (status === "no" && c.tier !== "required") status = "unknown";
    if (status === "yes" || status === "equivalent") {
      const labelTech = technologiesNamed(stripExamples(c.label));
      // What else does the job: what the row's own brackets name, and the
      // alternatives the employer declared for that skill on the role.
      const declared = input.skills.filter((sk) => namesAny(sk.skill, labelTech)).flatMap((sk) => sk.alternates);
      const acceptedTech = technologiesNamed(`${bracketed(c.label)} ${declared.join(", ")}`).filter((g) => !labelTech.some((l) => l[0] === g[0]));
      // On a job: a career position's title, skill tags or description, or the
      // resume. Not the profile's skills list, not an internship alone, and
      // not a confirmed fact (its wording names the requirement, whatever the answer).
      const onAJob = (tech: string[][]) => tech.length > 0 && (jobs.some((j) => j.career && namesAny(j.text, tech)) || (!!input.resumeText && namesAny(input.resumeText, tech)));
      if (HEDGE.test(evidence)) drop(HEDGED);
      else if (labelTech.length) {
        // A row that names a technology is decided here, on the jobs
        // themselves: stronger than any quote, so no quote is asked of it.
        // Where it is: the most recent career job that names it, else the resume.
        const jobWith = (tech: string[][]) => jobs.find((j) => j.career && namesAny(j.text, tech));
        const foundAt = (tech: string[][]) => { const j = jobWith(tech); return j ? jobSource(j) : "Resume"; };
        if (onAJob(labelTech)) {
          /* the requirement itself is on a job: the judge's yes or equivalent stands */
          source = foundAt(labelTech);
        } else if (onAJob(acceptedTech)) {
          status = "equivalent";
          const stand = acceptedTech.find((g) => onAJob([g]))!;
          if (!namesAny(evidence, [stand])) evidence = `${stand[0]} on a job stands in for ${labelTech[0][0]}.`;
          source = foundAt([stand]);
        } else if (status === "equivalent" && !acceptedTech.length) {
          // The row names no alternatives, so the judge's stand-in is allowed
          // only if every technology it cites is itself on a job.
          const cited = technologiesNamed(`${evidence} ${quote}`).filter((g) => !labelTech.some((l) => l[0] === g[0]));
          if (!cited.length || !cited.every((g) => onAJob([g]))) drop(reasonNotOnAJob(labelTech, input.profileText, jobs));
          else source = foundAt([cited[0]]);
        } else drop(reasonNotOnAJob([...labelTech, ...acceptedTech], input.profileText, jobs));
      } else if (quoteCheck(quote, lineMaterial, employers, noise, resume) !== "ok") drop(quoteCheck(quote, lineMaterial, employers, noise, resume) === "absent" ? NOT_QUOTED : SAYS_NOTHING);
      else {
        // Any technology the evidence or quote names must be the person's own
        // (an employer that shares a technology's name is not a technology).
        const invented = technologiesNamed(`${evidence} ${quote}`).filter((g) => !namesAny(material, [g]) && !employers.some((e) => g.some((n) => n.toLowerCase() === e.toLowerCase())));
        if (invented.length) drop(`${invented[0][0]} is not named on the profile or resume.`);
        else source = whereFrom(quote);
      }
    }
    // Rail: a row with a years bar and a subject ("5 years building X")
    // cannot be met when the dated history is over a year short of it.
    const bar = yearsBar(c.label);
    if (bar != null && datedYears != null && datedYears < bar - 1 && (status === "yes" || status === "equivalent")) drop(`Dated history shows ${datedYears} years against ${bar}+.`);
    // A technology row is decided on the jobs, not on its quote, so the quote
    // was never checked; it is shown beside "copied from there", so it is
    // kept only when it really is there.
    if (quote && technologiesNamed(stripExamples(c.label)).length && (status === "yes" || status === "equivalent")) {
      if (quoteCheck(quote, lineMaterial, employers, noise, resume) === "ok") {
        const w = whereFrom(quote);
        if (w && w !== "Profile") source = w;
      } else quote = "";
    }
    const met = status === "yes" || status === "equivalent";
    return { id: c.id, label: c.label, tier: c.tier, status, evidence, ai: status, call, confirmed: null, ...(quote ? { quote } : {}), ...(met && source ? { source } : {}), ...(dropped ? { dropped } : {}) };
  };
  const rows: CardRow[] = allCriteria.map((c) => decide(c, answerFor(rowsOut, c)));
  const unassessed = asked.filter((c) => !answerFor(rowsOut, c)).length;

  // Two kinds of dropped tick get one more look, under the same guards and
  // one more: the new quote must be ABOUT the row. (1) A quote that is not on
  // the profile is a mistake in QUOTING (the scorecard's own note copied, a
  // paraphrase), and the person may well have the evidence. (2) A tick whose
  // evidence hedged (suggests, implies): the same grounded team name was kept
  // in one run ("Platform and Infra shows infrastructure work") and dropped
  // in the next ("Platform and Infra work implies…") on the model's choice of
  // verb; what decides is whether the profile's words are there and about the
  // row, so the judge is asked to state the fact plainly or withdraw. A tick
  // resting on a title and an employer ("says nothing") gets no second look.
  // What the second look answered is kept on the row, so a tick it did not
  // restore can be understood afterwards.
  const again = rows.filter((r) => r.dropped?.why === NOT_QUOTED || r.dropped?.why === HEDGED);
  const record = (old: CardRow, again: string) => { rows[rows.indexOf(old)] = { ...old, dropped: { ...old.dropped!, again } }; };
  // Only in the time the rows call left unused, so the longest a person can
  // take is what it was before there was a second look.
  const spare = (input.timeoutMs ?? 30_000) - (Date.now() - started);
  let secondLookFailed = false;
  if (again.length && rowsUser && spare >= 4_000) {
    const reason = (r: CardRow) =>
      r.dropped!.why === HEDGED
        ? `- [${r.id}] your evidence was an inference ("${r.dropped!.evidence.slice(0, 100)}"). An inference is not evidence.`
        : `- [${r.id}] rejected quote: "${r.dropped!.quote.slice(0, 120)}" (those words are not written on the candidate's profile or resume; words from the scorecard or the job description are not the candidate's words).`;
    const r2 = await callOpenAI(
      input, ROWS_SYSTEM,
      `${rowsUser}\n\nSECOND LOOK. Answer ONLY these rows again:\n${again.map(reason).join("\n")}\nFor each row: if the profile has words that decide it (a skill tag on a job, a line of a description, a title or team name that names the work), copy them exactly and state the fact plainly. If it does not, answer unknown with quote "": that is the expected answer for most rows, and a quote about something else is worse than none.`,
      "scorecard_rows_again", rowsSchema(again.map((r) => r.id), false), Math.min(10_000, spare), false
    );
    if (!r2) {
      secondLookFailed = true;
      for (const old of again) record(old, "no reply");
    } else {
      usage = { input: usage.input + r2.usage.input, output: usage.output + r2.usage.output };
      const out2 = Array.isArray(r2.out.rows) ? (r2.out.rows as RowOut[]) : [];
      for (const old of again) {
        const c = allCriteria.find((x) => x.id === old.id)!;
        const second = answerFor(out2, c);
        if (!second) { record(old, "not answered"); continue; }
        const next = decide(c, second);
        const met = next.status === "yes" || next.status === "equivalent";
        // Kept only when it now stands AND the new quote is about this row:
        // asked twice, a judge will quote something, and a real line about
        // something else must not tick the row. It shares a word with the
        // row or its note, or it names a technology. The first attempt stays
        // on the row for diagnosis.
        if (met && aboutTheRow(next.quote || "", c)) rows[rows.indexOf(old)] = { ...next, dropped: { ...old.dropped!, why: `${old.dropped!.why} (a second look found a quote)` } };
        else if (met) record(old, `quote not about the row: "${(next.quote || "").slice(0, 100)}"`);
        else if (next.dropped) record(old, `${next.status === "unknown" ? "rejected again" : next.status}: ${next.dropped.why} "${next.dropped.quote.slice(0, 100)}"`);
        else record(old, `${next.status}: ${next.evidence.slice(0, 100)}`);
      }
    }
  } else if (again.length) for (const old of again) record(old, rowsUser ? "no time" : "no rows call");
  const removed = rows.filter((r) => r.dropped && r.status === "unknown").length;
  if (removed) console.warn(`verdict: ${removed} tick(s) removed: the profile does not say it`);

  let label: VerdictLabel = labelFromRows(rows, "message");
  // Recorded whenever the dated history is over a year short of the role's
  // minimum, whatever the label is today: the label is recomputed later (an
  // overrule, the call flag) and the rail must still hold then.
  const railNote = input.minYears != null && datedYears != null && datedYears < input.minYears - 1 ? `Dated history shows ${datedYears} years against ${input.minYears}+ required.` : null;
  if (label === "contact" && railNote) label = "message";
  const factItems = factLine(input, facts, jobs, basis);

  // ---- 3. the note, from the rows and facts only ----
  const first = noteName(input.candidateName);
  const mark = (s: RowStatus) => (s === "yes" ? "YES" : s === "equivalent" ? "EQUIVALENT" : s === "no" ? "NO" : "UNKNOWN (not shown)");
  const noteUser =
    `ROLE: ${input.roleTitle}\nCANDIDATE'S NAME, AS TO WRITE IT: ${first}\nLABEL SHOWN BESIDE THE NOTE: ${label === "contact" ? "Contact now" : label === "message" ? "Worth a message" : "Pass"}\n\n` +
    `FACTS:\n${factItems.map((f) => `- ${f}`).join("\n") || "- (none)"}\n\n` +
    `ROWS:\n${rows.map((r) => `- (${r.tier}) ${r.label}: ${mark(r.status)}. ${r.evidence}${r.quote ? ` [profile says: ${r.quote}]` : ""}`).join("\n")}`;
  const n = await callOpenAI(
    input, NOTE_SYSTEM, noteUser, "scorecard_note",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        paragraph: { type: "string" },
        missing: { type: "array", items: { type: "string" } },
        ask: { type: "array", items: { type: "string" } },
        better_suited: { type: "string" },
      },
      required: ["paragraph", "missing", "ask", "better_suited"],
    },
    Math.min(15_000, input.timeoutMs ?? 15_000),
    false // a missing note never fails the person: code writes one
  );
  const allowedText = `${factItems.join("\n")}\n${rows.map((r) => `${r.label} ${r.evidence} ${r.quote || ""}`).join("\n")}`;
  const names = [...first.split(/\s+/), ...employers];
  const clean = (list: unknown, max: number, len: number, questions = false) =>
    (Array.isArray(list) ? list : [])
      .map((x) => guardNote(String(x || ""), rows, allowedText, material, questions, names).slice(0, len))
      .filter(Boolean)
      .slice(0, max);
  let paragraph = n ? guardNote(String(n.out.paragraph || ""), rows, allowedText, material, false, names) : "";
  if (sentences(paragraph).length < 2) paragraph = fallbackNote(first, factItems, rows);
  paragraph = withPassReason(paragraph, label, rows);
  if (n) usage = { input: usage.input + n.usage.input, output: usage.output + n.usage.output };
  const openRequired = rows.filter((r) => r.tier === "required" && r.status !== "yes" && r.status !== "equivalent");
  const missing = n ? clean(n.out.missing, 4, 160) : openRequired.map((r) => `${r.label}: ${r.status === "no" ? "against" : "not shown on the profile"}.`).slice(0, 4);

  const requirements: RequirementRead[] = rows
    .filter((r) => r.status === "yes" || r.status === "equivalent" || r.tier === "required")
    .map((r) => ({
      requirement: r.label,
      status: r.status === "yes" ? ("met" as const) : r.status === "equivalent" ? ("equivalent" as const) : ("missing" as const),
      evidence: r.evidence,
    }));

  return {
    label,
    paragraph: paragraph.slice(0, 700),
    missing,
    ask: n ? clean(n.out.ask, 3, 200, true) : [],
    betterSuited: n ? guardNote(String(n.out.better_suited || ""), rows, allowedText, material, false, names).slice(0, 250) : "",
    requirements,
    rows,
    aiLabel: label,
    railNote,
    // A note the model could not write (rate limit, timeout) is replaced by
    // the code-written one and shown, but the verdict is not saved for reuse:
    // the next review gets a proper note.
    // (a second look that failed is the same: the tick it might have
    // restored is not settled, so the next review asks again)
    unassessed: unassessed + (n ? 0 : 1) + (secondLookFailed ? 1 : 0),
    facts: factItems,
    technologiesNow: techNow,
    technologiesBefore: techBefore,
    model: input.model,
    promptVersion: SCORECARD_JUDGE_VERSION,
    usage,
    ms: Date.now() - started,
  };
}
