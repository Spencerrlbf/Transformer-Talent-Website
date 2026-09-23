// The words behind a tick. A judgment row is decided by the judge's
// probabilities (jev.ts) and NEVER by what is written here: this module only
// finds, in the person's own material, the lines (up to three) that show the
// situation the row was judged to be in, so the recruiter can read them
// beside the tick.
// One small model call points at the words; code checks that they really
// are on the profile or resume, and works out where. A row for which no
// single line says it keeps its tick and says so.
//
// The quote checks (quoteCheck, acrossAWrap, sourceOfQuote) are the ones the
// v13 judge used to remove ticks with; here they can only remove a quote.

import type { JobText } from "../facts";

/** Pinned: a reference is part of a remembered row, so the model that found
 *  it is part of the row's key. */
export const REF_MODEL = "gpt-4o-mini-2024-07-18";
export const OPENAI_SEED = 7;
/** The source line on a met row with no quotable line (lib/rolecard.ts, so
 *  the checklist can tell it from a real source). */
export { NO_LINE_SOURCE } from "@/lib/rolecard";
/** At most three passages of at most twelve words each, per row: what the
 *  model is asked for, and what is taken whatever it sends. */
export const MAX_QUOTES = 3;
const MAX_QUOTE_WORDS = 12;
const MAX_QUOTE = 160;

// Words that say nothing about the work: generic title words, seniority,
// and what a copied profile line drags along with it (dates, tenure, place).
export const GENERIC_WORDS = new Set([
  "software", "engineer", "engineering", "developer", "senior", "junior", "staff", "member", "technical", "intern", "internship",
  "principal", "lead", "sr", "jr", "associate", "head", "mts", "swe", "sde", "founding", "team",
  "the", "and", "for", "with", "from", "at", "of", "in", "to", "a", "an", "ii", "iii", "iv", "full", "part", "time", "contract", "present",
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
  "yr", "yrs", "year", "years", "mo", "mos", "month", "months", "remote", "hybrid", "onsite", "united", "states", "area", "greater", "city", "new", "york", "san", "francisco", "bay", "london",
]);
export const tokens = (s: string) => (s.toLowerCase().match(/[a-z0-9+#]+(?:\.[a-z0-9]+)*/g) || []).filter((t) => t.length >= 2);

/** Why a quote fails. "empty": it is a generic title, an employer, a date or
 *  a place, which says nothing about any row (an inference from where someone
 *  works). "absent": it says something, but those words are not on the
 *  profile (a paraphrase, or the scorecard's own note copied back). "ok":
 *  what is left of the quote once generic title words, seniority, the
 *  employers' names, dates, tenure and places are taken out is on the
 *  profile in full, together on one line of it (or across a wrapped resume
 *  line). "Software Engineer. at Cognition. Sep 2025 - Present. New York" is
 *  a copied line and proves nothing; a quote stitched from a skill here and a
 *  city there proves nothing; one invented word in a real line proves nothing. */
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
export function quoteContent(quote: string, employers: string[], noise = ""): string[] {
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
 *  number, a word the model dropped). A line wrap adds no words, so a true
 *  quote needs no more room than that. Looser tests let a quote be stitched
 *  from neighbouring bullets: "Led a team of 8 engineers" from "worked
 *  alongside a team of 8 engineers ... Led migration of" (words near each
 *  other), and "6 years building machine learning infrastructure" from "6
 *  years at Acme; building internal tools. Evaluated machine learning
 *  infrastructure vendors" (in order, six words of slack). */
export function acrossAWrap(quote: string, text: string): boolean {
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

export const jobSource = (j: Pick<JobText, "title" | "company">) => `Work history · ${[j.title, j.company && `at ${j.company}`].filter(Boolean).join(" ")}`.slice(0, 120);

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

// ---------- one small model call, shared with the note ----------

export interface OpenAIReply {
  out: Record<string, unknown>;
  usage: { input: number; output: number };
}

/** A strict-schema call to OpenAI at temperature 0 with a fixed seed. Null on
 *  any failure (no key, a refusal, a timeout, an unreadable reply): every
 *  caller has a code-written fallback, so nothing here fails a person. */
export async function askOpenAI(a: { model: string; system: string; user: string; schemaName: string; schema: Record<string, unknown>; timeoutMs: number }): Promise<OpenAIReply | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(a.timeoutMs),
    body: JSON.stringify({
      model: a.model,
      temperature: 0,
      seed: OPENAI_SEED,
      response_format: { type: "json_schema", json_schema: { name: a.schemaName, strict: true, schema: a.schema } },
      messages: [
        { role: "system", content: a.system },
        { role: "user", content: a.user },
      ],
    }),
  }).catch(() => null);
  if (!res) return null;
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      /* body unreadable */
    }
    console.error(`verdict(${a.schemaName}): openai`, res.status, body.slice(0, 300));
    return null;
  }
  try {
    const data = (await res.json()) as { choices: { message: { content: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    return { out: JSON.parse(data.choices[0].message.content), usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 } };
  } catch {
    return null;
  }
}

// ---------- the references ----------

export const REF_SYSTEM = `You find, in a candidate's own material, the words that show a situation described on a recruiter's scorecard. The rows are ALREADY DECIDED: you do not judge them, you only point at the words.

For each row you are given the situation the candidate was judged to be in. Copy, exactly as written in the LinkedIn profile, the resume or the confirmed statements, at most three short passages of at most 12 words each that show that situation: a skill tag, a title, a team name, a line of a description. For a situation about work the person has done (built, ran, shipped, owned), point at the line that describes the work: a job title, a team name or a skill tag alone is not the words that show it. Each passage comes from a different line where the material has more than one. Copy words as they are written there: never paraphrase, never join words from different lines, never copy the scorecard's own words back. When no single line says it, return an empty list for that row: that is the expected answer for many rows, and a passage about something else is worse than none.`;

export interface ReferenceMaterial {
  profileText: string;
  resumeText: string;
  /** Statements a recruiter confirmed as TRUE (never a confirmed "no"). */
  confirmed: string[];
  jobs: JobText[];
  /** Names that are never evidence: every employer on the profile, the role's targets. */
  employers: string[];
  /** Locations and durations as the profile prints them: not evidence either. */
  noise: string;
}

export interface Reference {
  /** The first verified line and where it was found (older readers). */
  quote: string;
  source: string;
  /** Every verified line, in the order the model gave them, at most MAX_QUOTES. */
  quotes: { text: string; source: string }[];
}

export interface ReferencesFound {
  /** By row id; a row with no line to quote is absent. */
  refs: Map<string, Reference>;
  usage: { input: number; output: number };
  ms: number;
}

/** ONE call for every row that needs a line: the whole material plus, per
 *  row, the rung reached. Up to MAX_QUOTES lines come back per row, each
 *  checked against the material; the first verified one is the row's quote
 *  and all of them are its quotes. Returns null when the call failed, so the
 *  caller can show the rows without references and NOT remember them: the
 *  next review tries again. Never touches a status. */
export async function findReferences(rows: { id: string; rung: string }[], m: ReferenceMaterial, opts: { timeoutMs: number }): Promise<ReferencesFound | null> {
  const started = Date.now();
  const out: ReferencesFound = { refs: new Map(), usage: { input: 0, output: 0 }, ms: 0 };
  if (!rows.length) return out;
  const ids = [...new Set(rows.map((r) => r.id))];
  const user =
    `LINKEDIN PROFILE:\n${m.profileText}\n\n` +
    (m.resumeText ? `RESUME:\n${m.resumeText}\n\n` : "") +
    (m.confirmed.length ? `CONFIRMED BY A RECRUITER (true):\n${m.confirmed.map((c) => `- ${c}`).join("\n")}\n\n` : "") +
    `ROWS (the id, then the situation to find the words for):\n${rows.map((r) => `[${r.id}] ${r.rung}`).join("\n")}`;
  const reply = await askOpenAI({
    model: REF_MODEL,
    system: REF_SYSTEM,
    user,
    schemaName: "scorecard_references",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        refs: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { id: { type: "string", enum: ids }, quotes: { type: "array", items: { type: "string" } } },
            required: ["id", "quotes"],
          },
        },
      },
      required: ["refs"],
    },
    timeoutMs: opts.timeoutMs,
  });
  if (!reply) return null;
  out.usage = reply.usage;
  // A quote is looked for line by line in the profile (a LinkedIn entry is
  // one line) and by nearness in the resume (PDF text wraps mid-sentence).
  const lineMaterial = [m.profileText, ...m.confirmed].join("\n");
  const answers = Array.isArray(reply.out.refs) ? (reply.out.refs as { id?: unknown; quotes?: unknown }[]) : [];
  for (const a of answers) {
    const id = String(a?.id ?? "");
    if (!ids.includes(id) || out.refs.has(id)) continue;
    // Only the first MAX_QUOTES passages sent are looked at; every one that
    // checks out is kept, in the order given, and the first of them is the
    // row's quote. The same line sent twice counts once.
    const quotes = (Array.isArray(a.quotes) ? a.quotes : []).map((q) => String(q ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, MAX_QUOTES);
    const verified: { text: string; source: string }[] = [];
    for (const raw of quotes) {
      // A long quote is cut to its twelve-word allowance (a prefix of a real
      // line is still on that line), then at a separator: a word cut in half
      // is a word that is "not on the profile".
      const words = raw.split(" ");
      const trimmed = words.length <= MAX_QUOTE_WORDS ? raw : words.slice(0, MAX_QUOTE_WORDS).join(" ");
      const quote = trimmed.length <= MAX_QUOTE ? trimmed : trimmed.slice(0, MAX_QUOTE).replace(/[,;.·]?\s*[^\s,;.·]*$/, "");
      if (!quote || verified.some((v) => v.text.toLowerCase() === quote.toLowerCase())) continue;
      if (quoteCheck(quote, lineMaterial, m.employers, m.noise, m.resumeText) !== "ok") continue;
      const source = sourceOfQuote(quote, { jobs: m.jobs, profileText: m.profileText, resumeText: m.resumeText, confirmed: m.confirmed, employers: m.employers, noise: m.noise }) || "Profile";
      verified.push({ text: quote, source });
    }
    if (verified.length) out.refs.set(id, { quote: verified[0].text, source: verified[0].source, quotes: verified });
  }
  out.ms = Date.now() - started;
  return out;
}
