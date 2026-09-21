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

export const SCORECARD_JUDGE_VERSION = "v9";

const ROWS_SYSTEM = `You are a careful technical recruiter checking one candidate against a role's scorecard. You have the candidate's LinkedIn profile (and a resume when supplied), a FACTS block computed in code from their dated positions, and the role. Answer EVERY scorecard row, by its id.

STATUS
- yes: the candidate's own material shows it.
- equivalent: the thing itself is not shown, but a DIFFERENT thing that does the same job is: an alternative the row accepts, a concrete instance of a category ("vector database" by pgvector or Pinecone; "orchestration" by Temporal or Airflow; "cloud" by AWS, GCP or Azure), or the same work in another technology. Say what stands in. Never for the right thing in a smaller amount: that is unknown.
- unknown: the material does not show it. The honest answer for a thin profile and for anything a LinkedIn profile would not normally say.
- no: the material gives positive evidence AGAINST it: a career plainly in another discipline. Never from silence, never from low dated years.

EVIDENCE IS THE PERSON'S OWN WORDS
- Read for meaning, not for keywords. "Agent Evaluation Lead" or "eval platform" shows evaluation tooling for agents. "Platform and Infra" shows infrastructure work. Skill tags on a job such as Kubernetes, Docker, AWS Lambda, Terraform or PostgreSQL show backend services in production. The note after each row gives EXAMPLES of evidence: any one of them, or anything that says the same in other words.
- A title that itself names the work counts ("Backend Engineer", "Agent Platform lead", "Founding Engineer" for an early-engineer row). A generic title ("Software Engineer", "Member of Technical Staff") with an employer and a tenure shows nothing about a row: unknown.
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
3. What is not shown, or is against: the Required rows marked unknown or no, plainly ("TypeScript is not shown on the profile"). When most rows are unknown, say the profile is thin in a few words ("The profile is titles only").

Never state or imply experience for a row marked unknown. Never name a technology, product, duty or employer that is not in FACTS or ROWS. Never write suggests, implies, likely, probably, potential or ramp. Give no advice and no call to action: the label is shown beside the note. Use the first name once, then "they" and "their", never he or she. No bullets, no headings, no quotation marks.

ALSO RETURN: missing (0 to 4 short plain statements: the Required rows that are unknown or no first, then Exceptional ones), ask (0 to 3 short questions for a first call, one per unknown Required row first), better_suited (only when the label is pass or message AND FACTS points somewhere specific, such as years in another discipline: one sentence naming where they would fit; otherwise an empty string).`;

type RowOut = { id: string; status: RowStatus; quote: string; evidence: string };

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
  const q = quote.replace(/["“”‘’…]/g, " ").replace(/\s+/g, " ").trim();
  if (q.length < 2) return false;
  const skip = new Set([...employers.flatMap((e) => tokens(e)), ...tokens(noise)]);
  const content = tokens(q).filter((t) => !GENERIC_WORDS.has(t) && !skip.has(t) && !/^\d+$/.test(t));
  if (!content.length) return false;
  return material.split("\n").some((line) => {
    const lt = new Set(tokens(line));
    return content.every((t) => lt.has(t));
  });
}

const stripExamples = (label: string) => label.replace(/\(.*?\)/g, " ").replace(/(\be\.g\.|\bsuch as\b|\blike\b|\bor similar\b|\bincluding\b).*$/i, " ");
/** What else the row itself accepts: only what its brackets name. The
 *  "examples of evidence" note is NOT a list of substitutes (it may well name
 *  Kubernetes as evidence of backend work on a TypeScript row). */
const bracketed = (label: string) => (label.match(/\(([^)]*)\)/g) || []).join(" ");

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
  // A years bar is about engineering years on an engineering role, and about
  // the career on any other (a data science or product role). Decided once.
  const basis: "engineering" | "career" = workKind(input.roleTitle) === "engineering" || allCriteria.some((c) => isCareerYearsRow(c.label) && /\b(engineer|developer|software)/i.test(c.label)) ? "engineering" : "career";
  const datedYears = facts?.engineeringYears == null ? null : basis === "career" ? facts.careerYears : Math.round((facts.engineeringYears + facts.unclassifiedYears) * 10) / 10;

  // ---- 1. rows ----
  let rowsOut: RowOut[] = [];
  let techNow: string[] = [];
  let techBefore: string[] = [];
  let usage = { input: 0, output: 0 };
  if (asked.length) {
    const user =
      `ROLE: ${input.roleTitle}${input.minYears ? ` (${input.minYears}+ years)` : ""}\n\n` +
      `JOB DESCRIPTION:\n${input.jdText.slice(0, 4000)}\n\n` +
      `SCORECARD (answer every row by id):\n${asked
        .map((c) => `- [${c.id}] (${c.tier}) ${c.label}${c.good ? ` :: examples of evidence (any one, or anything that says the same in other words): ${c.good}` : ""}`)
        .join("\n")}\n\n` +
      (input.confirmedFacts?.length ? `CONFIRMED BY THE RECRUITER:\n${input.confirmedFacts.slice(-12).map((f) => `- ${f}`).join("\n")}\n\n` : "") +
      `CANDIDATE: ${input.candidateName}\nLINKEDIN PROFILE:\n${input.profileText.slice(0, 5000)}\n\n` +
      (input.resumeText ? `RESUME EXCERPT:\n${input.resumeText.slice(0, 3000)}\n\n` : "") +
      `FACTS (computed in code from dated positions):\n${input.factsBlock}`;
    const r = await callOpenAI(
      input, ROWS_SYSTEM, user, "scorecard_rows",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          rows: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", enum: asked.map((c) => c.id) },
                status: { type: "string", enum: ["yes", "equivalent", "unknown", "no"] },
                quote: { type: "string" },
                evidence: { type: "string" },
              },
              required: ["id", "status", "quote", "evidence"],
            },
          },
          technologies_now: { type: "array", items: { type: "string" } },
          technologies_before: { type: "array", items: { type: "string" } },
        },
        required: ["rows", "technologies_now", "technologies_before"],
      },
      input.timeoutMs ?? 30_000,
      true
    );
    if (!r) return null;
    rowsOut = Array.isArray(r.out.rows) ? (r.out.rows as RowOut[]) : [];
    techNow = cleanTech(r.out.technologies_now, material);
    techBefore = cleanTech(r.out.technologies_before, material).filter((t) => !techNow.some((n) => n.toLowerCase() === t.toLowerCase()));
    usage = r.usage;
  }

  // ---- 2. code ----
  const idOf = (x: string) => String(x || "").replace(/^[\s\[]+|[\s\]]+$/g, "").toLowerCase();
  let unassessed = 0;
  let removed = 0;
  const rows: CardRow[] = allCriteria.map((c) => {
    const call = c.tier === "required" && !!c.confirmOnCall;
    if (isCareerYearsRow(c.label)) {
      const ruled = careerYearsStatus(facts, yearsBar(c.label)!, basis);
      // Exceptional and Bonus rows never count against anyone, this one included.
      const st: RowStatus = ruled.status === "no" && c.tier !== "required" ? "unknown" : ruled.status;
      return { id: c.id, label: c.label, tier: c.tier, status: st, evidence: ruled.evidence, ai: st, call, confirmed: null };
    }
    const r = rowsOut.find((x) => x && idOf(x.id) === c.id.toLowerCase());
    if (!r) unassessed++;
    let status: RowStatus = r && ["yes", "equivalent", "unknown", "no"].includes(r.status) ? r.status : "unknown";
    let evidence = (r?.evidence || (r ? "" : "Not assessed")).trim().slice(0, 180);
    // Cut a long quote at a separator: a word cut in half is a word that is
    // "not on the profile", and a real tick was lost that way.
    const rawQuote = (r?.quote || "").trim();
    let quote = rawQuote.length <= 160 ? rawQuote : rawQuote.slice(0, 160).replace(/[,;.·]?\s*[^\s,;.·]*$/, "");
    let dropped: CardRow["dropped"];
    const drop = (why: string) => {
      // Kept on the row (never shown) so a wrongly removed tick can be found.
      dropped = { status, quote: rawQuote.slice(0, 200), evidence: evidence.slice(0, 160), why };
      status = "unknown";
      evidence = why;
      quote = "";
      removed++;
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
      if (HEDGE.test(evidence)) drop("Not shown on the profile.");
      else if (labelTech.length) {
        // A row that names a technology is decided here, on the jobs
        // themselves: stronger than any quote, so no quote is asked of it.
        if (onAJob(labelTech)) {
          /* the requirement itself is on a job: the judge's yes or equivalent stands */
        } else if (onAJob(acceptedTech)) {
          status = "equivalent";
          const stand = acceptedTech.find((g) => onAJob([g]))!;
          if (!namesAny(evidence, [stand])) evidence = `${stand[0]} on a job stands in for ${labelTech[0][0]}.`;
        } else if (status === "equivalent" && !acceptedTech.length) {
          // The row names no alternatives, so the judge's stand-in is allowed
          // only if every technology it cites is itself on a job.
          const cited = technologiesNamed(`${evidence} ${quote}`).filter((g) => !labelTech.some((l) => l[0] === g[0]));
          if (!cited.length || !cited.every((g) => onAJob([g]))) drop(reasonNotOnAJob(labelTech, input.profileText, jobs));
        } else drop(reasonNotOnAJob([...labelTech, ...acceptedTech], input.profileText, jobs));
      } else if (!quoteIsGrounded(quote, material, employers, noise)) drop("Not shown on the profile: nothing written there says this.");
      else {
        // Any technology the evidence or quote names must be the person's own
        // (an employer that shares a technology's name is not a technology).
        const invented = technologiesNamed(`${evidence} ${quote}`).filter((g) => !namesAny(material, [g]) && !employers.some((e) => g.some((n) => n.toLowerCase() === e.toLowerCase())));
        if (invented.length) drop(`${invented[0][0]} is not named on the profile or resume.`);
      }
    }
    // Rail: a row with a years bar and a subject ("5 years building X")
    // cannot be met when the dated history is over a year short of it.
    const bar = yearsBar(c.label);
    if (bar != null && datedYears != null && datedYears < bar - 1 && (status === "yes" || status === "equivalent")) drop(`Dated history shows ${datedYears} years against ${bar}+.`);
    return { id: c.id, label: c.label, tier: c.tier, status, evidence, ai: status, call, confirmed: null, ...(quote ? { quote } : {}), ...(dropped ? { dropped } : {}) };
  });
  if (removed) console.warn(`verdict: ${removed} tick(s) removed: the profile does not say it`);

  let label: VerdictLabel = labelFromRows(rows, "message");
  // Recorded whenever the dated history is over a year short of the role's
  // minimum, whatever the label is today: the label is recomputed later (an
  // overrule, the call flag) and the rail must still hold then.
  const railNote = input.minYears != null && datedYears != null && datedYears < input.minYears - 1 ? `Dated history shows ${datedYears} years against ${input.minYears}+ required.` : null;
  if (label === "contact" && railNote) label = "message";
  const factItems = factLine(input, facts, jobs, basis);

  // ---- 3. the note, from the rows and facts only ----
  const first = (input.candidateName || "The candidate").split(/\s+/)[0];
  const mark = (s: RowStatus) => (s === "yes" ? "YES" : s === "equivalent" ? "EQUIVALENT" : s === "no" ? "NO" : "UNKNOWN (not shown)");
  const noteUser =
    `ROLE: ${input.roleTitle}\nCANDIDATE FIRST NAME: ${first}\nLABEL SHOWN BESIDE THE NOTE: ${label === "contact" ? "Contact now" : label === "message" ? "Worth a message" : "Pass"}\n\n` +
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
  const names = [first, ...employers];
  const clean = (list: unknown, max: number, len: number, questions = false) =>
    (Array.isArray(list) ? list : [])
      .map((x) => guardNote(String(x || ""), rows, allowedText, material, questions, names).slice(0, len))
      .filter(Boolean)
      .slice(0, max);
  let paragraph = n ? guardNote(String(n.out.paragraph || ""), rows, allowedText, material, false, names) : "";
  if (sentences(paragraph).length < 2) paragraph = fallbackNote(first, factItems, rows);
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
    unassessed: unassessed + (n ? 0 : 1),
    facts: factItems,
    technologiesNow: techNow,
    technologiesBefore: techBefore,
    model: input.model,
    promptVersion: SCORECARD_JUDGE_VERSION,
    usage,
    ms: Date.now() - started,
  };
}
