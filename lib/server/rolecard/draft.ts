// Drafts a role's scorecard from its job description: three tiers, short
// testable rows. One call per role; the hiring manager or recruiter can then
// reword, move, delete or add rows. Nothing here writes to the database.

import { isCareerYearsRow, sanitizeScorecard, type Scorecard } from "@/lib/rolecard";
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

export const DRAFT_MODEL = "gpt-4o";

// One array per tier, so a tier cannot be skipped the way a single list let it be.
const ROWS = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: { label: { type: "string" }, good: { type: "string" } },
    required: ["label", "good"],
  },
} as const;

// The examples below are deliberately from OTHER kinds of role (payments,
// data platform, mobile). The first version used an agent-platform role as
// its example; the first role it was tried on was an agent-platform role, and
// it copied three rows from the prompt, including a "2+ years" bar no job
// description had asked for. The second version still carried two phrases
// from that role ("backend services in production", "evaluation or
// observability"), and both came back word for word. Nothing here may be
// taken from a role the drafter is being tested on.
const SYSTEM = `You are a senior technical recruiter turning a job description into the scorecard every candidate for this role is checked against. Most candidates are judged from a LinkedIn profile alone, so each row must be something a profile, a resume or a ten-minute call can answer.

THREE TIERS
- required: the hiring manager would reject without it. 3 to 5 rows. Include the minimum years when the role states one, as its own row, in exactly one of these two forms: for a software or engineering role, "5+ years as a software engineer"; for any other role (data science, research, product, design), "5+ years of professional experience". Include the core skill and the core kind of work.
- exceptional: what the ideal hire has beyond the bar: the rare thing that makes the hiring manager say yes on sight. 1 to 3 rows, drawn from the role's hardest responsibilities. Never generic praise.
- bonus: nice to have. 1 to 4 rows.

EVERY ROW IS CHECKABLE FROM WHAT PEOPLE ACTUALLY WRITE
- label: at most 10 words, no question mark. Never a sentence copied from the description. Never an adjective as the test: no deep, strong, solid, expert, proven, extensive, comfortable, familiar. Say the thing done: "Hands-on mobile experience" becomes "Has shipped an iOS or Android app to the store".
- good: one plain sentence, at most 28 words, naming what a PROFILE shows when this is true: titles, team names, skill tags, the words people use in a job description. Never duties nobody writes on a profile (on-call, code review, stakeholder management). Never "in any capacity", "exposure to", "familiarity with": they make everything count.
- One row, one question. If a single line on a profile would tick two rows, they are one row: merge them. When the description pairs two names for one capability, keep both joined by "or" ("billing or invoicing systems"), because people describe their work with either word.
- A technology row says what else would do the job, in brackets, taken from the role's own tech stack: "Backend in Java or Kotlin (Go, Scala or C# accepted)". When the stack lists several languages, every one that would do the row's job goes in the brackets, not only the closest. With no stated alternatives, name none. Put a years bar on a skill row ONLY when the description states one for that skill; how deep someone is, is a question for the call.
- A category row keeps technologies out of its label and lists them in good: label "Stream processing or message queues"; good "Kafka, Kinesis, Pub/Sub, RabbitMQ or SQS named on a job; Flink or Spark Streaming also count".

HOW DESCRIPTION LANGUAGE BECOMES A ROW (patterns from other roles)
- "Deep Python expertise" is not a row. "Python services in production (Go or Java accepted)" is.
- "Strong distributed-systems background" is not a row. "Has built distributed systems (queues, consensus, sharding)" is.
- "Comfort at the intersection of data and product" is not a row. "Has shipped data products used by customers" is.
- "8+ years of engineering with deep Java expertise" is TWO rows: "8+ years as a software engineer" and "Backend in Java or Kotlin (Scala or C# accepted)".

EXAMPLES OF THE FORM (from other roles; do not reuse their content)
- required: "Has built payment or ledger systems in production" :: good: "Payments, billing, ledger, reconciliation or card-processing work named in a title, a team or a job description."
- exceptional: "Has led a zero-to-one product as the first engineers" :: good: "Founding engineer, first engineer, early engineer or technical co-founder at a company that shipped."
- bonus: "Data warehouse modelling" :: good: "dbt, Snowflake, BigQuery or Redshift named on a job; dimensional modelling or analytics engineering in a description."

Every requirement and every hard responsibility in the description is covered by some row: reword what cannot be checked, never leave it out. Never invent requirements the description does not support. No rows about soft skills, culture, location, visa or salary. Order each tier by importance. 7 to 11 rows in total.`;

/** Enough written about the role to draft from. A bare title would make the
 *  model invent requirements, and invented Required rows would pass people. */
export const canDraft = (input: DraftInput): boolean => {
  const jd = input.jd || {};
  const text = [jd.about, input.description, ...(jd.needs || []), ...(jd.doing || [])].filter(Boolean).join(" ");
  // (the tech stack alone is not enough to draft from: it says what, never why)
  return text.trim().length >= 80 || (input.skills || []).length >= 2;
};

// ---------- a draft is checked in code, and sent back to be fixed ----------
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

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { required: ROWS, exceptional: ROWS, bonus: ROWS },
  required: ["required", "exceptional", "bonus"],
} as const;

async function askDrafter(messages: { role: string; content: string }[], timeoutMs: number): Promise<Scorecard | null> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: process.env.SCORECARD_DRAFT_MODEL || DRAFT_MODEL,
      temperature: 0,
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
    const out = JSON.parse(data.choices[0].message.content) as Record<"required" | "exceptional" | "bonus", { label: string; good: string }[]>;
    const criteria = (["exceptional", "required", "bonus"] as const).flatMap((tier) => (Array.isArray(out[tier]) ? out[tier] : []).map((r) => ({ ...r, tier })));
    return sanitizeScorecard({ criteria }, "ai");
  } catch {
    return null;
  }
}

/** Draft, check, repair. `budgetMs` is how long the caller can wait in all:
 *  a repair is only attempted while there is time for one. */
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
    { role: "system", content: SYSTEM },
    { role: "user", content: user.slice(0, 9000) },
  ];
  const first = await askDrafter(base, timeoutMs);
  if (!first) return null;
  // A row with a problem is reworded, never deleted. "Deleted" is strict: the
  // row's label is gone, the card is shorter for it, and no new row took up
  // its subject. (A row left as it was is not deleted, and neither is one
  // reworded in other words: both looked deleted to a looser test, and good
  // repairs were thrown away for it.) What was deleted stays owed until a
  // new row brings its subject back, however many rounds that takes.
  type Owed = { label: string; subject: Set<string> };
  const newlyDeleted = (before: Scorecard, beforeProblems: DraftProblem[], after: Scorecard): Owed[] => {
    const has = (card: Scorecard, label: string) => card.criteria.some((x) => x.label === label);
    const gone = before.criteria.filter((c) => !has(after, c.label));
    const flaggedGone = gone.filter((c) => hard(beforeProblems).some((p) => p.label === c.label && !DUPLICATE.test(p.problem)));
    const fresh = after.criteria.filter((x) => !has(before, x.label));
    // every new row is somebody's rewording: only the shortfall was deleted
    const shortfall = gone.length - fresh.length;
    if (shortfall <= 0) return [];
    return flaggedGone
      .map((c) => ({ label: c.label, subject: topic(c.label.replace(/\(.*?\)/g, " ")) }))
      .filter((o) => o.subject.size > 0 && !fresh.some((x) => [...topic(`${x.label} ${x.good || ""}`)].some((w) => o.subject.has(w))))
      .slice(0, shortfall);
  };
  const stillOwed = (owed: Owed[], card: Scorecard): Owed[] =>
    owed.filter((o) => !card.criteria.some((x) => !first.criteria.some((y) => y.label === x.label) && [...topic(`${x.label} ${x.good || ""}`)].some((w) => o.subject.has(w))));
  const asProblems = (owed: Owed[]): DraftProblem[] => owed.map((o) => ({ label: "(deleted row)", problem: `"${o.label}" was removed instead of reworded. Bring back what it asked for, as something a person has built or done.` }));
  const brief = (ps: DraftProblem[]) => ps.map((p) => `${p.advisory ? "(advice) " : ""}${p.label}: ${p.problem.slice(0, 70)}`).join(" | ").slice(0, 600);

  let best = first;
  let problems = draftProblems(first, input);
  const notes = [`first draft: ${first.criteria.length} rows, ${hard(problems).length} problem(s)${problems.length ? `: ${brief(problems)}` : ""}`];
  let latest = first;
  let latestProblems = problems;
  let owed: Owed[] = [];
  // Advice alone never starts a repair: it rides along with one.
  for (let round = 0; round < 2 && hard(latestProblems).length && Date.now() - started + timeoutMs < budgetMs; round++) {
    const asJson = (c: Scorecard) => JSON.stringify(Object.fromEntries((["required", "exceptional", "bonus"] as const).map((t) => [t, c.criteria.filter((x) => x.tier === t).map((x) => ({ label: x.label, good: x.good || "" }))])));
    const next = await askDrafter(
      [
        ...base,
        { role: "assistant", content: asJson(latest) },
        { role: "user", content: `That draft breaks the rules in ${latestProblems.length} place${latestProblems.length > 1 ? "s" : ""}. Return the whole scorecard again with every one of these fixed. Reword a row that has a problem, never delete it, and leave rows that have no problem as they are:\n${latestProblems.map((p) => `- "${p.label}" ${p.problem}`).join("\n")}` },
      ],
      timeoutMs
    );
    if (!next) {
      notes.push(`repair ${round + 1}: no reply`);
      break;
    }
    owed = stillOwed([...owed, ...newlyDeleted(latest, latestProblems, next)], next);
    const left = [...draftProblems(next, input), ...asProblems(owed)];
    notes.push(`repair ${round + 1}: ${next.criteria.length} rows, ${hard(left).length} problem(s)${left.length ? `: ${brief(left)}` : ""}`);
    if (hard(left).length < hard(problems).length) {
      best = next;
      problems = left;
    }
    // The next round works on the latest reply either way: it carries the
    // model's own last attempt, and what is still wrong with it.
    latest = next;
    latestProblems = left;
  }
  if (hard(problems).length) {
    console.warn(`scorecard draft: ${hard(problems).length} problem(s) left after repair:`, brief(hard(problems)));
    const tidied = sanitizeScorecard({ criteria: best.criteria.map((c) => (isCareerYearsRow(c.label) ? c : { ...c, id: undefined, label: tidyLabel(c.label) })) }, "ai");
    if (tidied) best = tidied;
    notes.push(`kept with ${hard(problems).length} problem(s) after tidying`);
  }
  // What the drafter did, kept on the card (never shown): the only way to see
  // from the database how a draft on an unfamiliar role went.
  best = { ...best, draftNotes: notes.map((n) => n.slice(0, 700)).slice(0, 6) };
  return best;
}
