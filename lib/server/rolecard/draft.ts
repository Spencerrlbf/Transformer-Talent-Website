// Drafts a role's scorecard from its job description in one typed call:
// three tiers of short, testable rows, each of a kind (years, technology or
// judgment). A judgment row comes back as three SLOTS, not sentences: what
// merely names the subject on a profile, what a line describing the work
// says, and what owning or leading it looks like. Code writes the rungs and
// the note from the slots (lib/rolecard.ts rungsFromSlots, noteFromSlots),
// so every card reads the same way and a title can never sit at the rung a
// row is met from. Code checks the draft and fixes what it can; the model is
// asked once more only for what it alone can fix. The recruiter can then
// reword, move, delete or add rows. Nothing here writes to the database.

import {
  MAX_GOOD, MAX_RUNG, WORK_VERB, isCareerYearsRow, noteFromSlots, rowKind, rungsFromSlots, sanitizeScorecard, yearsLabel,
  type Criterion, type RungSlots, type Scorecard, type Tier,
} from "@/lib/rolecard";
import { isLanguage, technologiesNamed } from "@/lib/tech-terms";

export interface DraftInput {
  title: string;
  yoe?: string | null;
  jd?: { about?: string; doing?: string[]; needs?: string[]; bonus?: string[] } | null;
  description?: string | null;
  skills?: { skill: string; must_have?: boolean; alternates?: string[] }[] | null;
  /** The role's free-text tech stack. Synced roles have no structured skills
   *  list, and without this the drafter never learns which other languages
   *  the employer's own stack would accept. */
  techStack?: string | null;
  minYears?: number | null;
}

/** Pinned: the same job description must draft the same card from one day
 *  to the next, so the model and a seed are fixed. */
export const DRAFT_MODEL = "gpt-4o-2024-08-06";
const DRAFT_SEED = 7;

/** One row as the model returns it, with its tier attached. */
export interface DraftRow {
  tier: Tier;
  kind: "years" | "technology" | "judgment";
  label: string;
  years: number | null;
  basis: "engineer" | "professional" | null;
  signal: string | null;
  work: string | null;
  beyond: string | null;
  metFrom: number | null;
}

const ROW = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["years", "technology", "judgment"] },
    label: { type: "string" },
    years: { type: ["integer", "null"] },
    basis: { type: ["string", "null"], enum: ["engineer", "professional", null] },
    signal: { type: ["string", "null"] },
    work: { type: ["string", "null"] },
    beyond: { type: ["string", "null"] },
    metFrom: { type: ["integer", "null"] },
  },
  required: ["kind", "label", "years", "basis", "signal", "work", "beyond", "metFrom"],
} as const;
// One array per tier, so a tier cannot be skipped the way a single list let it be.
const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { required: { type: "array", items: ROW }, exceptional: { type: "array", items: ROW }, bonus: { type: "array", items: ROW } },
  required: ["required", "exceptional", "bonus"],
} as const;

// The examples below are deliberately from OTHER kinds of role (payments,
// mobile, data). An earlier version used an agent-platform role as its
// example; the first role it was tried on was an agent-platform role, and it
// copied three rows from the prompt. Nothing here may be taken from a role
// the drafter is being tested on.
export const DRAFT_SYSTEM = `You are a senior technical recruiter turning a job description into the scorecard every candidate for this role is checked against. Most candidates are judged from a LinkedIn profile alone, so each row must be something a profile, a resume or a ten-minute call can answer.

THREE TIERS
- required: the hiring manager would reject without it. 3 to 5 rows. Include the minimum years when the role states one, as its own years row. Include the core skill and the core kind of work.
- exceptional: what the ideal hire has beyond the bar: the rare thing that makes the hiring manager say yes on sight. 1 to 3 rows, drawn from the role's hardest responsibilities. Never generic praise.
- bonus: nice to have. 1 to 4 rows.

THREE KINDS OF ROW
- years: the minimum years bar and nothing else. Give years as a whole number and basis: "engineer" for a software or engineering role, "professional" for any other (data science, research, product, design). Code writes the label. At most one years row, and only when the description states a minimum. No slots.
- technology: a language, framework or tool the person must have used, checked by code against their skill tags and resume. The label names it and, in brackets, what else the employer would accept from the role's own stack: "Backend in Java or Kotlin (Go, Scala or C# accepted)". When the stack lists several languages, every one that would do the row's job goes in the brackets, not only the closest. With no stated alternatives, name none. Put a years bar on a technology row ONLY when the description states one for that skill. No slots.
- judgment: work the person has done, judged on rungs that code writes from three slots you fill, each a phrase of at most 18 words, never a sentence:
  - signal: the concrete things a profile shows when it merely NAMES the subject without describing work: the titles, team names, skill tags, tool or product names, or the mention itself, written as those things. No verb of doing. Examples: "A payments, billing or ledger title, team or skills tag"; "Kafka or Kinesis on a skills list"; "A chemistry or materials science degree on the profile".
  - work: what a line DESCRIBING the work says: the thing, then what they did with it, with a verb of doing (built, ran, shipped, deployed, operated, designed, owned, led, migrated, scaled, trained, published). Example: "a payment, billing or ledger system they built, deployed or ran in production".
  - beyond: what owning or leading it looks like. Example: "Owned or led the payments platform or ledger".
  - metFrom: 3, the rung where the work is described. Use 2 only when the signal is the thing itself and nothing more needs describing: a degree, a certification, a licence, a security clearance, a language spoken.
  A job title or a team name says where someone sat, not what they did: it belongs in signal, never in work.

EVERY ROW IS CHECKABLE FROM WHAT PEOPLE ACTUALLY WRITE
- label: at most 10 words, no question mark. Never a sentence copied from the description. Never an adjective as the test: no deep, strong, solid, expert, proven, extensive, comfortable, familiar. Say the thing done: "Hands-on mobile experience" becomes "Has shipped an iOS or Android app to the store".
- The work the role is named after ("Payments Engineer": payments) is Required or Exceptional, never Bonus. Bonus never counts for or against anyone.
- One row, one question. If a single line on a profile would tick two rows, they are one row: merge them. When the description pairs two names for one capability, keep both joined by "or" ("billing or invoicing systems"), because people describe their work with either word.
- A category row keeps technologies out of its label and puts them in the slots: label "Stream processing or message queues"; signal "Kafka, Kinesis, Pub/Sub, RabbitMQ or SQS on a skills list or in a team name"; work "a stream or queue they built or ran in production with Kafka, Kinesis, Pub/Sub, RabbitMQ or SQS". Name only technologies the description or the stack names.

HOW DESCRIPTION LANGUAGE BECOMES A ROW (patterns from other roles)
- "Deep Python expertise" is not a row. "Python services in production (Go or Java accepted)" is, as a technology row.
- "Strong mobile background" is not a row. "Has shipped an iOS or Android app to the store" is, as a judgment row: signal "An iOS, Android or mobile title, team or skills tag", work "an iOS or Android app they built and shipped to the App Store or Google Play", beyond "Led the mobile team or owned the app end to end".
- "Comfort at the intersection of data and product" is not a row. "Has shipped data products used by customers" is.
- "8+ years of engineering with deep Java expertise" is TWO rows: a years row (8, engineer) and "Backend in Java or Kotlin (Scala or C# accepted)".

EXAMPLES OF THE FORM (from other roles; do not reuse their content)
- required, judgment: "Has built payment or ledger systems in production" :: signal "A payments, billing or ledger title, team or skills tag" :: work "a payment, billing or ledger system they built, deployed or ran in production" :: beyond "Owned or led the payments platform or ledger" :: metFrom 3
- exceptional, judgment: "Has led a zero-to-one product as one of the first engineers" :: signal "Founding engineer, first engineer, early engineer or technical co-founder in a title" :: work "a product they took from nothing to shipped as one of the first engineers" :: beyond "Founded the company or led the founding team" :: metFrom 3
- bonus, technology: "Data warehouse modelling with dbt (Snowflake, BigQuery or Redshift accepted)"

Every requirement and every hard responsibility in the description is covered by some row: reword what cannot be checked, never leave it out. Never invent requirements the description does not support: a thin description gets fewer rows, not made-up ones. No rows about soft skills, culture, location, visa or salary. Order each tier by importance. 5 to 11 rows in total.`;

/** Enough written about the role to draft from. A bare title would make the
 *  model invent requirements, and invented Required rows would pass people. */
export const canDraft = (input: DraftInput): boolean => {
  const jd = input.jd || {};
  const text = [jd.about, input.description, ...(jd.needs || []), ...(jd.doing || [])].filter(Boolean).join(" ");
  // (the tech stack alone is not enough to draft from: it says what, never why)
  return text.trim().length >= 80 || (input.skills || []).length >= 2;
};

// ---------- a draft is checked in code; the model is asked once more only for what it alone can fix ----------
// The first drafts ignored the rules above whenever the job description made
// it easy to: "Deep TypeScript backend expertise" and "Production-grade
// infrastructure experience" came straight from the description's
// requirements, adjectives and all, and the judge cannot answer such rows.
// A prompt asks; this checks, names each problem, and asks for a repair.

const ADJECTIVE = /\b(deep|deeply|strong|strongly|solid|expert|proven|extensive|significant|comfortable|comfort|familiar|familiarity|excellent|advanced|proficient|proficiency|production-grade|world-class|hands-on|robust)\b/i;
const VAGUE_ENDING = /\b(experience|expertise|knowledge|skills?|background|understanding|intersection|ability|abilities|mindset)\s*$/i;
const LOOSE_NOTE = /\bin any capacity\b|\bexposure to\b|\bfamiliarity\b|\bon-call\b|\bcode reviews?\b|\bstakeholder/i;
const STOP = new Set(["the", "and", "for", "with", "from", "of", "in", "to", "a", "an", "or", "at", "on", "has", "have", "as", "is", "are", "that", "this", "their", "years", "year"]);
const words = (t: string) => (t.toLowerCase().match(/[a-z0-9+#.]+/g) || []).map((w) => w.replace(/\.+$/, "")).filter((w) => w.length > 2 && !STOP.has(w));
// "Experience with X" is a row anything can satisfy, whatever X is.
// ("Knowledge graphs" and "Background job processing" are real subjects: the
// preposition is what makes it the empty form.)
const WEAK_OPENER = /^\s*(?:(?:has|have)\s+(?:an?\s+|some\s+)?)?(?:(?:experience|knowledge|understanding|exposure|background|expertise|familiarity|proficiency)\s+(?:with|of|in|to|on|across)|(?:experienced|skilled|proficient|versed)\s+(?:with|in|at)|ability\s+to)\b/i;
// Words that say nothing about WHICH requirement a sentence is: used to tell
// whether a row covers a requirement, and whether two rows cover one thing.
const GENERIC = new Set([
  "experience", "expertise", "knowledge", "skill", "skills", "background", "understanding", "ability", "comfort", "comfortable", "intersection",
  "software", "engineering", "engineer", "engineers", "developer", "system", "systems", "production", "grade", "environment", "environments",
  "fast", "moving", "paced", "deep", "strong", "solid", "proven", "extensive", "hands", "team", "teams", "work", "working", "built", "build",
  "building", "platform", "senior", "staff", "principal", "lead", "junior", "head", "manager", "remote", "hybrid", "onsite", "full", "stack", "time", "run", "running", "owned", "own", "led", "shipped", "used", "using", "professional", "plus", "etc", "e.g", "similar", "related", "tools", "tool",
]);
const stem = (w: string) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const topic = (t: string) => new Set(words(t).filter((w) => !GENERIC.has(w) && !ADJECTIVE.test(w)).map(stem));
const DUPLICATE = /second row about|covers the same ground/;

export interface DraftProblem {
  label: string;
  problem: string;
  /** A judgement call the code cannot settle (would Python do this row's
   *  job? is "data" the work or the job family?). Sent along when a repair
   *  is happening anyway; never the reason for one, never counted. */
  advisory?: boolean;
}
const hard = (ps: DraftProblem[]) => ps.filter((p) => !p.advisory);

/** Everything the role says, in one text: what a technology named in a slot
 *  must be found in. */
const roleText = (input: DraftInput): string => {
  const jd = input.jd || {};
  return [input.title, jd.about, input.description, ...(jd.doing || []), ...(jd.needs || []), ...(jd.bonus || []), (input.skills || []).flatMap((s) => [s.skill, ...(s.alternates || [])]).join(", "), input.techStack].filter(Boolean).join("\n");
};
const tidy = (s: string | null | undefined): string => String(s ?? "").replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
/** A row whose subject is a thing one holds, not work one did: met when named. */
const NAMED_THING = /\b(degree|bachelor'?s?|master'?s?|bsc|msc|mba|phd|doctorate|certif\w*|qualification|licen[cs]ed?|accredit\w*|clearance|fluent|native speaker)\b/i;
const SLOT_HELP = {
  signal: "The signal is what names the subject on a profile without describing work: a title, a team name, a skill tag, a product name.",
  work: "The work is what a line describing the work says: the thing, then what they did with it, with a verb of doing.",
  beyond: "Beyond is what owning or leading it looks like.",
} as const;

/** What is wrong with the rows as the model returned them: the slots, the
 *  kinds, the years. In words the model can act on. */
export function slotProblems(rows: DraftRow[], input: DraftInput): DraftProblem[] {
  const out: DraftProblem[] = [];
  const known = new Set(technologiesNamed(roleText(input)).map((g) => g[0]));
  let yearsRows = 0;
  for (const r of rows) {
    const label = tidy(r.label) || "(unnamed row)";
    if (r.kind === "years") {
      yearsRows++;
      if (!(typeof r.years === "number" && r.years >= 1)) out.push({ label, problem: "is a years row with no number of years. Give years as a whole number, or leave the row out." });
      continue;
    }
    if (r.kind !== "judgment") continue;
    for (const k of ["signal", "work", "beyond"] as const) {
      if (!tidy(r[k])) out.push({ label, problem: `has no ${k} slot. ${SLOT_HELP[k]}` });
    }
    const work = tidy(r.work);
    const signal = tidy(r.signal);
    if (work && !WORK_VERB.test(work)) out.push({ label, problem: `its work slot ("${work.slice(0, 60)}") has no verb of doing. Say what they built, ran, shipped, deployed or operated.` });
    if (signal && WORK_VERB.test(signal)) out.push({ label, problem: `its signal slot ("${signal.slice(0, 60)}") describes work. A signal is a title, a team name, a skill tag or a mention: what names the subject without describing it.` });
    for (const g of technologiesNamed(`${work} ${signal} ${tidy(r.beyond)}`)) {
      if (!known.has(g[0])) out.push({ label, problem: `names ${g[0]}, which neither the description nor the role's stack does. Name only technologies the role itself names.` });
    }
  }
  if (yearsRows > 1) out.push({ label: "(years rows)", problem: `has ${yearsRows} years rows. Keep one, the minimum the description states.` });
  return out;
}

/** What is wrong with a draft, row by row, in words the model can act on. */
export function draftProblems(card: Scorecard, input: DraftInput): DraftProblem[] {
  const out: DraftProblem[] = [];
  const jd = input.jd || {};
  const sentences = [...(jd.needs || []), ...(jd.bonus || []), ...(jd.doing || [])];
  const stack = technologiesNamed(`${input.techStack || ""} ${(input.skills || []).flatMap((x) => [x.skill, ...(x.alternates || [])]).join(", ")}`);
  const seenTech = new Map<string, string>();
  for (const c of card.criteria) {
    const core = c.label.replace(/\(.*?\)/g, " ");
    if (isCareerYearsRow(c.label)) continue;
    const adj = core.match(ADJECTIVE);
    if (adj) out.push({ label: c.label, problem: `uses "${adj[0]}" as the test. Say the thing done instead (for example "Python services in production", "Has built distributed systems").` });
    else if (VAGUE_ENDING.test(core.trim())) out.push({ label: c.label, problem: `ends in "${core.trim().split(/\s+/).pop()}", which nobody can check. Name what the person has built, run or used.` });
    else if (WEAK_OPENER.test(core)) out.push({ label: c.label, problem: `opens with "${core.match(WEAK_OPENER)![0].trim()}", which anything can satisfy. Say what the person has built, run or shipped ("Has built ...").` });
    const w = words(core);
    const copied = w.length >= 3 && sentences.find((sn) => { const sw = new Set(words(sn)); return w.filter((x) => sw.has(x)).length / w.length >= 0.8; });
    // A requirement that was already checkable may be kept nearly as written,
    // once it says something done ("Has built forecasting models in production").
    if (copied && !adj && !VAGUE_ENDING.test(core.trim()) && !/^\s*(has|have)\s/i.test(core)) out.push({ label: c.label, problem: `is the description's own sentence shortened ("${copied.slice(0, 80)}"). Rewrite it as what a profile would show.` });
    const named = technologiesNamed(core);
    if (named.length) {
      const others = stack.filter((g) => !named.some((n) => n[0] === g[0]));
      // Only a stand-in of the same kind is asked for: a language for a
      // language. Java is no stand-in for Kafka, whatever the stack lists.
      const otherLanguages = others.filter(isLanguage);
      if (!/\(/.test(c.label) && named.some(isLanguage) && otherLanguages.length)
        out.push({ label: c.label, problem: `names ${named.find(isLanguage)![0]} but not what else would do the job. Add, in brackets, each language the employer would accept in its place (the role's own stack also lists: ${otherLanguages.map((g) => g[0]).join(", ")}).` });
      // Brackets that name a stand-in but no LANGUAGE, when the role's own
      // stack lists other languages: a Java engineer then reads "not shown"
      // on a TypeScript row that says "(Node.js accepted)". Whether Java does
      // that row's job is the drafter's call, so this is advice.
      const inBrackets = technologiesNamed((c.label.match(/\(([^)]*)\)/g) || []).join(" "));
      if (/\(/.test(c.label) && named.some(isLanguage) && otherLanguages.length && !inBrackets.some(isLanguage))
        out.push({ advisory: true, label: c.label, problem: `its brackets name no other language, and the role's own stack also lists ${otherLanguages.map((g) => g[0]).join(", ")}. Add each one that would do this row's job; leave out any that would not.` });
      for (const g of named) {
        const first = seenTech.get(g[0]);
        if (first && first !== c.label) out.push({ label: c.label, problem: `is a second row about ${g[0]} (the other is "${first}"). One profile line would tick both: merge them into one row.` });
        else seenTech.set(g[0], c.label);
      }
    }
    if (c.good && LOOSE_NOTE.test(c.good)) out.push({ label: c.label, problem: `its note ("${c.good.slice(0, 70)}") names something nobody writes on a profile, or lets anything count. Name titles, team names, skill tags or the words people use in a job description.` });
  }
  // Two rows on one thing ("Has owned durable workflow orchestration" and
  // "Workflow orchestration"): one profile line would tick both. The longer
  // row may add one word at most: "Has published ML research" and "... at
  // NeurIPS, ICML or ICLR" are a bar and what is beyond it, not a duplicate.
  const ACTION = new Set(["built", "build", "run", "ran", "owned", "own", "led", "lead", "shipped", "used", "using", "worked", "designed", "written", "wrote", "managed", "experience"]);
  const subject = (t: string) => new Set(words(t).filter((w) => !ACTION.has(w)).map(stem));
  const rows = card.criteria.filter((c) => !isCareerYearsRow(c.label)).map((c) => ({ c, t: subject(c.label.replace(/\(.*?\)/g, " ")) }));
  rows.forEach((b, i) => {
    const twin = rows.slice(0, i).find((a) => {
      const [small, big] = a.t.size <= b.t.size ? [a.t, b.t] : [b.t, a.t];
      return small.size >= 2 && big.size - small.size <= 1 && [...small].every((w) => big.has(w));
    });
    if (twin && !out.some((p) => p.label === b.c.label && DUPLICATE.test(p.problem))) out.push({ label: b.c.label, problem: `covers the same ground as "${twin.c.label}". One profile line would tick both: keep one row, in the tier it belongs to.` });
  });
  // A note is what the recruiter reads under the row. One written by hand
  // that only repeats the row's own words ("Infrastructure work named in job
  // titles or descriptions" under "Has built infrastructure") adds nothing.
  // A note written from the slots always names the work, so it passes.
  const FILLER = new Set(["named", "shown", "listed", "mentioned", "described", "stated", "job", "jobs", "title", "titles", "description", "descriptions", "profile", "profiles", "role", "roles", "team", "teams", "similar", "related", "context", "such", "like", "any", "one", "more", "also", "count", "counts", "e.g", "eg", "including", "such as", "work", "working", "system", "systems", "tools", "tool", "environment", "environments", "production", "experience", "skill", "skills", "tag", "tags", "list", "lists"]);
  for (const c of card.criteria) {
    if (!c.good || isCareerYearsRow(c.label)) continue;
    if (technologiesNamed(c.good).length) continue; // a technology is evidence
    const own = new Set([...topic(c.label.replace(/\(.*?\)/g, " "))].map(stem));
    const adds = [...topic(c.good)].map(stem).filter((w) => !own.has(w) && !FILLER.has(w) && !GENERIC.has(w));
    if (!adds.length) out.push({ label: c.label, problem: `its note ("${c.good.slice(0, 60)}") only repeats the row. Name what a profile shows when this is true: the titles, team names, skill tags or technologies that count, and the words people use in a description.` });
  }
  // The role's subject decides something. A word of the title that appears
  // on the card only in Bonus rows ("Agent Platform Engineer" with agents in
  // Bonus) was drafted into the wrong tier: Bonus never counts for or against.
  // A row is ABOUT a word when the word is its subject ("Has built AI agent
  // systems"), not a qualifier ("...observability systems for agent
  // performance" is about observability).
  const VERBS = new Set(["has", "have", "built", "build", "designed", "owned", "own", "led", "lead", "shipped", "ran", "run", "used", "worked", "delivered", "created", "developed", "maintained", "operated", "implemented", "managed", "scaled"]);
  const subjectOf = (label: string) => words(label.replace(/\(.*?\)/g, " ")).map(stem).filter((x) => !GENERIC.has(x) && !VERBS.has(x) && !ADJECTIVE.test(x));
  const isAbout = (c: Criterion, w: string) => { const ws = subjectOf(c.label); return ws[0] === w || (ws.length <= 2 && ws.includes(w)); };
  for (const w of [...topic(input.title)]) {
    if (w.length <= 3 || GENERIC.has(w) || technologiesNamed(w).length) continue;
    const about = card.criteria.filter((c) => isAbout(c, w));
    if (about.length && about.every((c) => c.tier === "bonus"))
      out.push({ label: about[0].label, problem: `is in Bonus, but "${w}" is in the role's title: it is the work itself. Put this row in Exceptional (the ideal hire) or Required (without it, no).` });
  }
  // The core of the role has a row. A word of the role's TITLE that the
  // description itself uses three times or more, and that no row and no note
  // mentions, may be a requirement left out: an agent-platform card came back
  // with nothing about agents. Advice only: the word can just as well be the
  // job family ("data", "full stack") or how the job is worked ("remote").
  const onCard = topic(card.criteria.map((c) => `${c.label} ${c.good || ""}`).join(" "));
  const said = new Map<string, number>();
  for (const w of words([jd.about || input.description || "", ...(jd.doing || []), ...(jd.needs || []), ...(jd.bonus || [])].join(" ")).map(stem)) said.set(w, (said.get(w) || 0) + 1);
  for (const w of words(input.title)) {
    const n = said.get(stem(w)) || 0;
    if (n >= 3 && w.length > 3 && !GENERIC.has(w) && !GENERIC.has(stem(w)) && !ADJECTIVE.test(w) && !technologiesNamed(w).length && !onCard.has(stem(w)))
      out.push({ advisory: true, label: "(missing row)", problem: `no row mentions "${w}", which is in the role's title and which the description names ${n} times. If it is work the person must have done, add a row that says what they have built or done with it; if it is only the job family or the employer's market, change nothing.` });
  }
  const count = (t: string) => card.criteria.filter((c) => c.tier === t).length;
  if (count("exceptional") < 1) out.push({ label: "(exceptional tier)", problem: "is empty. Add 1 to 3 rows from the role's hardest responsibilities." });
  if (count("bonus") < 1 && (jd.bonus || []).length) out.push({ label: "(bonus tier)", problem: "is empty although the description lists nice-to-haves." });
  if (count("required") > 5) out.push({ label: "(required tier)", problem: `has ${count("required")} rows. Keep the 3 to 5 the hiring manager would really reject on; move the rest down.` });
  return out;
}

/** The last resort when a repair still leaves an adjective or a vague ending:
 *  take the word out in code rather than ship a row nobody can answer. */
function tidyLabel(label: string): string {
  const t = label.replace(new RegExp(`^\\s*${ADJECTIVE.source}\\s+`, "i"), "").replace(VAGUE_ENDING, "").replace(/\s+/g, " ").trim();
  return t.length >= 6 ? t.charAt(0).toUpperCase() + t.slice(1) : label;
}

/** The rows as a card: the years label written by code in its fixed form,
 *  a judgment row's rungs and note written from its slots, a technology row
 *  as its label. A judgment row whose slots are missing is kept without a
 *  ladder (its note or label seeds a single rung) and flagged for repair. */
export function toScorecard(rows: DraftRow[]): Scorecard | null {
  let years = false;
  const criteria: Partial<Criterion>[] = [];
  for (const r of rows) {
    const label = tidy(r.label);
    if (r.kind === "years") {
      if (years || typeof r.years !== "number" || r.years < 1) continue;
      years = true;
      criteria.push({ tier: r.tier, label: yearsLabel(r.years, r.basis === "professional" ? "professional" : "engineer") });
      continue;
    }
    if (!label) continue;
    if (r.kind === "technology" || isCareerYearsRow(label)) {
      criteria.push({ tier: r.tier, label });
      continue;
    }
    const slots: RungSlots = { signal: tidy(r.signal), work: tidy(r.work), beyond: tidy(r.beyond) };
    const filled = !!(slots.signal && slots.work && slots.beyond);
    // A degree, a certification or a licence is met when it is named: the
    // mention is the thing. Code decides that whatever the model said.
    const metFrom: 2 | 3 = r.metFrom === 2 || NAMED_THING.test(label) ? 2 : 3;
    // A judgment row whose label names a technology would be decided from job
    // tags unless the kind is stored: the model asked for rungs, so it gets them.
    const override = rowKind({ label }) === "tech" ? { kind: "judgment" as const } : {};
    criteria.push({
      tier: r.tier,
      label,
      ...override,
      ...(filled ? { good: noteFromSlots(slots, metFrom), ladder: rungsFromSlots(slots, metFrom), metAt: metFrom } : {}),
    });
  }
  return sanitizeScorecard({ criteria }, "ai");
}

/** The reply's shape, rebuilt from the rows, for the assistant turn of a repair. */
const asReply = (rows: DraftRow[]) =>
  JSON.stringify(Object.fromEntries((["required", "exceptional", "bonus"] as const).map((t) => [t, rows.filter((r) => r.tier === t).map(({ tier: _tier, ...rest }) => rest)])));

async function askDrafter(messages: { role: string; content: string }[], timeoutMs: number): Promise<DraftRow[] | null> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: process.env.SCORECARD_DRAFT_MODEL || DRAFT_MODEL,
      temperature: 0,
      seed: DRAFT_SEED,
      response_format: { type: "json_schema", json_schema: { name: "scorecard", strict: true, schema: DRAFT_SCHEMA } },
      messages,
    }),
  }).catch(() => null);
  if (!res || !res.ok) {
    if (res) console.error("scorecard draft: openai", res.status, (await res.text().catch(() => "")).slice(0, 300));
    return null;
  }
  try {
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    const out = JSON.parse(data.choices[0].message.content) as Record<Tier, Partial<DraftRow>[]>;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
    const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
    return (["exceptional", "required", "bonus"] as const).flatMap((tier) =>
      (Array.isArray(out[tier]) ? out[tier] : []).map((r) => ({
        tier,
        kind: r.kind === "years" || r.kind === "technology" ? r.kind : "judgment",
        label: str(r.label) || "",
        years: num(r.years),
        basis: r.basis === "professional" ? "professional" : r.basis === "engineer" ? "engineer" : null,
        signal: str(r.signal),
        work: str(r.work),
        beyond: str(r.beyond),
        metFrom: num(r.metFrom),
      }))
    );
  } catch {
    return null;
  }
}

/** Draft, check, and ask once more only for what the model alone can fix.
 *  `budgetMs` is how long the caller can wait in all: the repair is only
 *  attempted while there is time for one. */
export async function draftScorecard(input: DraftInput, timeoutMs = 25_000, budgetMs = 55_000): Promise<Scorecard | null> {
  if (!process.env.OPENAI_API_KEY || !canDraft(input)) return null;
  const started = Date.now();
  const jd = input.jd || {};
  const skills = (input.skills || [])
    .map((s) => `- ${s.skill}${s.must_have ? " (must-have)" : " (nice-to-have)"}${s.alternates?.length ? `; also accepts: ${s.alternates.join(", ")}` : ""}`)
    .join("\n");
  const user =
    `ROLE: ${input.title}${input.yoe ? ` (${input.yoe})` : input.minYears ? ` (${input.minYears}+ years)` : ""}\n\n` +
    (jd.about ? `ABOUT:\n${jd.about}\n\n` : input.description ? `DESCRIPTION:\n${input.description.slice(0, 4000)}\n\n` : "") +
    (jd.doing?.length ? `RESPONSIBILITIES:\n- ${jd.doing.join("\n- ")}\n\n` : "") +
    (jd.needs?.length ? `REQUIREMENTS:\n- ${jd.needs.join("\n- ")}\n\n` : "") +
    (jd.bonus?.length ? `NICE TO HAVE:\n- ${jd.bonus.join("\n- ")}\n\n` : "") +
    (skills ? `SKILLS THE EMPLOYER LISTED:\n${skills}\n\n` : "") +
    (input.techStack ? `TECH STACK THE ROLE LISTS (not all must-haves; use it to name the alternatives a technology row accepts): ${input.techStack}\n` : "");
  const base = [
    { role: "system", content: DRAFT_SYSTEM },
    { role: "user", content: user.slice(0, 9000) },
  ];
  const brief = (ps: DraftProblem[]) => ps.map((p) => `${p.advisory ? "(advice) " : ""}${p.label}: ${p.problem.slice(0, 70)}`).join(" | ").slice(0, 600);
  const check = (rows: DraftRow[]) => {
    const card = toScorecard(rows);
    const problems = card ? [...slotProblems(rows, input), ...draftProblems(card, input)] : [{ label: "(card)", problem: "has no rows. Return the scorecard." }];
    return { rows, card, problems };
  };

  const first = await askDrafter(base, timeoutMs);
  if (!first) return null;
  let best = check(first);
  const notes = [`first draft: ${best.card?.criteria.length ?? 0} rows, ${hard(best.problems).length} problem(s)${best.problems.length ? `: ${brief(best.problems)}` : ""}`];
  // One repair, for the problems only the model can fix; advice rides along.
  if (hard(best.problems).length && Date.now() - started + timeoutMs < budgetMs) {
    const next = await askDrafter(
      [
        ...base,
        { role: "assistant", content: asReply(best.rows) },
        { role: "user", content: `That draft breaks the rules in ${best.problems.length} place${best.problems.length > 1 ? "s" : ""}. Return the whole scorecard again with every one of these fixed. Reword a row that has a problem, never delete it, and leave rows that have no problem as they are:\n${best.problems.map((p) => `- "${p.label}" ${p.problem}`).join("\n")}` },
      ],
      timeoutMs
    );
    if (!next) notes.push("repair: no reply");
    else {
      const repaired = check(next);
      notes.push(`repair: ${repaired.card?.criteria.length ?? 0} rows, ${hard(repaired.problems).length} problem(s)${repaired.problems.length ? `: ${brief(repaired.problems)}` : ""}`);
      if (repaired.card && hard(repaired.problems).length < hard(best.problems).length) best = repaired;
    }
  }
  if (!best.card) return null;
  let card = best.card;
  if (hard(best.problems).length) {
    console.warn(`scorecard draft: ${hard(best.problems).length} problem(s) left after repair:`, brief(hard(best.problems)));
    const tidied = sanitizeScorecard({ criteria: card.criteria.map((c) => (isCareerYearsRow(c.label) ? c : { ...c, id: undefined, label: tidyLabel(c.label) })) }, "ai");
    if (tidied) card = tidied;
    notes.push(`kept with ${hard(best.problems).length} problem(s) after tidying`);
  }
  // What the drafter did, kept on the card (never shown): the only way to see
  // from the database how a draft on an unfamiliar role went.
  return { ...card, draftNotes: notes.map((n) => n.slice(0, 700)).slice(0, 6) };
}
