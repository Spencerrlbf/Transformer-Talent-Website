import { sbRest, sbRpc } from "./supabase";

const OPENAI = "https://api.openai.com/v1";

function openaiKey() {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error("OPENAI_API_KEY not configured");
  return k;
}

export interface ExtractedJD {
  title: string;
  seniority: string;
  min_years: number | null;
  max_years: number | null;
  locations: string[];
  remote_ok: boolean;
  skills: string[];
  embedding_summary: string;
}

// Mirrors the location expansion used by the local matching pipeline.
const LOCATION_EXPANSIONS: Record<string, string[]> = {
  "san francisco": ["San Francisco", "Bay Area", "Oakland", "Berkeley", "Palo Alto", "Mountain View", "Sunnyvale", "Santa Clara", "Redwood City", "Menlo Park", "San Jose", "Cupertino"],
  "bay area": ["San Francisco", "Bay Area", "Oakland", "Berkeley", "Palo Alto", "Mountain View", "San Jose"],
  "new york": ["New York", "NYC", "Manhattan", "Brooklyn", "Jersey City", "Hoboken"],
  "los angeles": ["Los Angeles", "Santa Monica", "Culver City", "Pasadena"],
  "south bay area": ["San Jose", "Sunnyvale", "Santa Clara", "Mountain View", "Palo Alto", "Cupertino", "Bay Area"],
  "san jose": ["San Jose", "Sunnyvale", "Santa Clara", "Cupertino", "Bay Area"],
  "washington dc": ["Washington", "Arlington", "Bethesda", "Alexandria"],
  seattle: ["Seattle", "Bellevue", "Redmond", "Kirkland"],
  boston: ["Boston", "Cambridge", "Somerville"],
  austin: ["Austin", "Round Rock"],
  chicago: ["Chicago", "Evanston"],
  denver: ["Denver", "Boulder"],
  miami: ["Miami", "Fort Lauderdale"],
};

export function expandLocations(locations: string[]): string[] | null {
  const out = new Set<string>();
  for (const loc of locations) {
    const patterns = LOCATION_EXPANSIONS[loc.toLowerCase().trim()];
    if (patterns) patterns.forEach((p) => out.add(p));
    else if (loc.trim()) out.add(loc.trim());
  }
  return out.size ? [...out] : null;
}

export async function extractJD(jdText: string): Promise<ExtractedJD> {
  const res = await fetch(`${OPENAI}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "jd_extraction",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              seniority: { type: "string" },
              min_years: { type: ["integer", "null"] },
              max_years: { type: ["integer", "null"] },
              locations: { type: "array", items: { type: "string" } },
              remote_ok: { type: "boolean" },
              skills: { type: "array", items: { type: "string" } },
              embedding_summary: { type: "string" },
            },
            required: [
              "title", "seniority", "min_years", "max_years",
              "locations", "remote_ok", "skills", "embedding_summary",
            ],
          },
        },
      },
      messages: [
        {
          role: "system",
          content:
            "You extract structured data from job descriptions for a candidate-matching system. " +
            "embedding_summary must be a dense 2-4 sentence description of the ideal candidate " +
            "(role, seniority, core skills, domain) written like a candidate profile headline, " +
            "not a job ad. locations: city names only, empty array if remote/unspecified. " +
            "skills: max 12, most important first.",
        },
        { role: "user", content: jdText.slice(0, 24000) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`extraction failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content) as ExtractedJD;
}

export async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${OPENAI}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey()}`,
      "Content-Type": "application/json",
    },
    // Must match the model that produced candidates.matching_embedding.
    body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 8000) }),
  });
  if (!res.ok) throw new Error(`embedding failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data[0].embedding as number[];
}

export interface MatchRow {
  id: string;
  current_title: string | null;
  current_company: string | null;
  location: string | null;
  years_experience: number | null;
  previous_companies: string[] | null;
  education_schools: string[] | null;
  education_degrees: string[] | null;
  education_fields: string[] | null;
  top_skills: string[] | null;
  headline: string | null;
  source: string | null;
  similarity: number;
}

export async function matchCandidates(
  embedding: number[],
  jd: ExtractedJD,
  count = 30
): Promise<MatchRow[]> {
  const minYears = jd.min_years && jd.min_years > 2 ? jd.min_years - 2 : null;
  const locations = jd.remote_ok ? null : expandLocations(jd.locations);
  // Hybrid: vector channel (best-of legacy + spine) ∪ keyword channel over
  // skills/titles — exact stack matches join the pool even when embeddings miss.
  const [vecRows, kwRows] = await Promise.all([
    sbRpc<MatchRow[]>("match_candidates_v2", {
      query_embedding: embedding,
      match_count: count,
      min_years: minYears,
      location_patterns: locations,
    }),
    jd.skills.length
      ? sbRpc<MatchRow[]>("match_candidates_keyword", {
          skill_terms: jd.skills,
          match_count: 15,
          min_years: minYears,
          location_patterns: locations,
          query_embedding: embedding,
        }).catch(() => [])
      : Promise.resolve([]),
  ]);
  const seen = new Set(vecRows.map((r) => r.id));
  const merged = [...vecRows, ...kwRows.filter((r) => !seen.has(r.id))];
  merged.forEach((r) => seen.add(r.id));
  // People who asked not to be contacted leave here, before anything ranks,
  // shows, queues or saves them, and before we count whether to widen.
  const rows = await withoutOptedOut(merged);
  if (rows.length >= 5 || !locations) return rows;
  // Location filter left too few — widen to nationwide and merge.
  const widened = await sbRpc<MatchRow[]>("match_candidates_v2", {
    query_embedding: embedding,
    match_count: count,
    min_years: minYears,
    location_patterns: null,
  });
  return [...rows, ...(await withoutOptedOut(widened.filter((r) => !seen.has(r.id))))];
}

// The shortlist builder's rule for who is never put forward (assess() in
// lib/server/shortlist/rules.ts; copied, not imported, because it is not
// exported there). Keep the two in step.
const OPTED_OUT = /do not contact|not interested/i;

export function isOptedOut(status: string | null | undefined): boolean {
  return !!status && OPTED_OUT.test(status);
}

/**
 * The rows whose person we could look up and who has not opted out. A row
 * missing from the lookup is dropped too: we only show people we checked.
 */
export function keepContactable<T extends { id: string }>(
  rows: T[],
  statusById: Map<string, string | null>
): T[] {
  return rows.filter((r) => statusById.has(r.id) && !isOptedOut(statusById.get(r.id)));
}

// The match RPCs do not return status, so read it for the retrieved ids.
async function withoutOptedOut(rows: MatchRow[]): Promise<MatchRow[]> {
  const ids = [...new Set(rows.map((r) => r.id))];
  const statusById = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const res = await sbRest(`candidates?id=in.(${chunk.map((x) => `"${x}"`).join(",")})&select=id,status`);
    // Fail closed: without statuses we cannot tell who asked to be left alone,
    // so the search fails and the team runs it by hand.
    if (!res.ok) throw new Error(`candidate status read failed: ${res.status} ${await res.text()}`);
    for (const r of (await res.json()) as { id: string; status: string | null }[]) statusById.set(r.id, r.status);
  }
  return keepContactable(rows, statusById);
}

function skillOverlap(jdSkills: string[], candidateSkills: string[] | null): number {
  if (!jdSkills.length || !candidateSkills?.length) return 0;
  const cand = candidateSkills.map((s) => s.toLowerCase());
  let hits = 0;
  for (const s of jdSkills) {
    const needle = s.toLowerCase();
    if (cand.some((c) => c.includes(needle) || needle.includes(c))) hits++;
  }
  return hits / jdSkills.length;
}

// What a visitor to /talent sees of one person. No current employer, no
// per-person flags: a title and an employer, or "applied to us", can name
// someone to a stranger who pasted a job description.
export interface AnonymizedMatch {
  ref: string;
  title: string;
  yearsExperience: number | null;
  location: string | null;
  previousCompanies: string[];
  education: string[];
  skills: string[];
  score: number;
}

export interface TalentTeaser {
  matches: AnonymizedMatch[];
  /** How many of the shown people are already in our network; a count, never who. */
  inNetwork: number;
}

const GENERIC_TITLE = "Software Engineer";

// Same sources the old per-card "in conversation with us" badge counted.
const ENGAGED_SOURCES = new Set(["directory", "airtable_sync", "website_applicant"]);

// Trailing words that only say what kind of legal entity a company is.
const LEGAL_SUFFIXES = [
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co",
  "company", "gmbh", "plc", "llp", "lp", "ag", "sa", "pbc",
];
const LEGAL_SUFFIX_WORDS = new Set(LEGAL_SUFFIXES);
// Dotted spellings too: "S.A.", "L.L.C.".
const LEGAL_SUFFIX_ALT = LEGAL_SUFFIXES.map((w) => w.split("").join("\\.?")).join("|");
const LEGAL_SUFFIX_TAIL = new RegExp(`[\\s,.&]+(?:${LEGAL_SUFFIX_ALT})\\.?$`, "i");

/**
 * One spelling per employer for comparing names: lowercase, no punctuation or
 * accents, no legal suffix. "Stripe, Inc." and "stripe" give the same key.
 * Dots and apostrophes close up rather than split ("S.A." is "sa").
 */
export function employerKey(name: string | null | undefined): string {
  const words = (name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.'\u2019]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIX_WORDS.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

// Two keys name the same employer when one equals or contains the other
// ("google" and "google deepmind"). Squashed spellings ("open ai", "openai")
// count too, but only past four letters, so a short name like "x" does not
// knock out every employer that happens to contain the letter.
function sameEmployer(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `)) return true;
  const ca = a.replace(/ /g, "");
  const cb = b.replace(/ /g, "");
  return Math.min(ca.length, cb.length) >= 4 && (ca.includes(cb) || cb.includes(ca));
}

/**
 * The employer a free-text line names after " at " or "@" ("Staff Engineer at
 * Stripe | ex-Google" gives "Stripe"). Only that one segment: the rest of the
 * line is taglines and past jobs.
 */
export function employerSegment(text: string | null | undefined): string | null {
  const m = (text || "").match(/(?:^|\s)at\s+|@/i);
  if (!m || m.index === undefined) return null;
  const rest = (text || "").slice(m.index + m[0].length);
  const seg = rest.split(/[|•·,;()/]|\s[-\u2013\u2014]\s/)[0].trim();
  return seg || null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const squash = (key: string) => key.replace(/ /g, "");

// Words a company name often ends with that say what it does, not who it is:
// "Scale AI" is "Scale" in a title, "Meta Platforms" is "Meta".
const NAME_DESCRIPTORS = new Set([
  "ai", "ml", "lab", "labs", "tech", "technology", "technologies", "payments", "platform", "platforms",
  "systems", "software", "solutions", "services", "web", "cloud", "research", "robotics", "networks",
  "security", "analytics", "digital", "group", "holdings", "global", "international", "ventures",
  "capital", "studios", "games", "health", "therapeutics", "computing", "industries", "enterprise",
  "enterprises",
]);
// Short names that are also everyday title words are never cut on their own:
// "Open AI" on record must not turn "Open Source Engineer" into "Source Engineer".
const TITLE_WORDS = new Set(["open", "applied", "general", "data", "deep", "machine", "physical", "product", "design"]);

/**
 * The spellings of one employer a title might use, as employer keys: the name,
 * each half of "Amazon Web Services (AWS)", and the name without trailing
 * descriptors ("scale" for "Scale AI"). A short name is kept only past the
 * same four letters sameEmployer asks for.
 */
function employerAliases(company: string): string[] {
  const inner = [...company.matchAll(/\(([^()]*)\)/g)].map((m) => m[1]);
  const keys = [company, company.replace(/\([^()]*\)/g, " "), ...inner].map(employerKey).filter(Boolean);
  for (const key of [...keys]) {
    const words = key.split(" ");
    while (words.length > 1 && NAME_DESCRIPTORS.has(words[words.length - 1])) words.pop();
    const core = words.join(" ");
    if (core !== key && squash(core).length >= 4 && !TITLE_WORDS.has(core)) keys.push(core);
  }
  return [...new Set(keys)];
}

// One word of a title, with the dots, apostrophes, hyphens and ampersands
// names carry inside them ("C3.ai", "McDonald's", "Co-founder", "AT&T").
const TITLE_WORD = /[\p{L}\p{N}]+(?:[.'’&-][\p{L}\p{N}]+)*\.?/gu;

/**
 * Cuts every run of whole words that spells one of the keys, compared with the
 * spaces closed up: "Open AI" goes for "OpenAI", "Stripe, Inc." for "Stripe".
 * Only whole runs match, so "Scaling" stays when the employer is "Scale".
 */
function cutEmployerRuns(title: string, keys: string[]): string {
  const targets = new Set(keys.map(squash));
  // Room for a spelling written with more spaces than the key, or a legal suffix.
  const longest = Math.max(...keys.map((k) => k.split(" ").length)) + 2;
  const words = [...title.matchAll(TITLE_WORD)];
  const start = (i: number) => words[i].index ?? 0;
  const end = (i: number) => start(i) + words[i][0].length;
  let out = "";
  let from = 0;
  for (let i = 0; i < words.length; ) {
    let n = Math.min(longest, words.length - i);
    while (n > 0 && !targets.has(squash(employerKey(title.slice(start(i), end(i + n - 1)))))) n--;
    if (!n) {
      i++;
      continue;
    }
    out += title.slice(from, start(i)) + " ";
    from = end(i + n - 1);
    i += n;
  }
  return out + title.slice(from);
}

/**
 * Drops the parts of a title (between commas, slashes or spaced dashes, or in
 * brackets) that name the employer under a looser spelling: "Engineer, Stripe"
 * when the company is "Stripe Payments", "Research Scientist, Google" when it
 * is "Google DeepMind". The first part is the role itself, so it goes only when
 * it is nothing but a piece of the name.
 */
function dropEmployerParts(title: string, keys: string[]): string {
  // A piece of the name ("google" of "google deepmind"); a short piece like
  // "ai" of "scale ai" only when it is a spelling in its own right ("aws").
  const pieceOf = (part: string) =>
    !!part && keys.some((k) => squash(part) === squash(k) || (squash(part).length >= 4 && ` ${k} `.includes(` ${part} `)));
  // Or the whole name with more around it ("stripe payments team").
  const holds = (part: string) =>
    !!part && keys.some((k) => ` ${part} `.includes(` ${k} `) || (squash(k).length >= 4 && squash(part).includes(squash(k))));
  const t = title.replace(/\(([^()]*)\)/g, (all, inner: string) => {
    const key = employerKey(inner);
    return pieceOf(key) || holds(key) ? " " : all;
  });
  const parts = t.split(/(\s*[,;/]\s*|\s+[-\u2013\u2014]\s+)/);
  let out = pieceOf(employerKey(parts[0])) ? "" : parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const key = employerKey(parts[i + 1]);
    if (!pieceOf(key) && !holds(key)) out += parts[i] + parts[i + 1];
  }
  return out;
}

// Leftovers from cutting an employer out of a title: separators with nothing
// after them, empty brackets, and connectors like "for" that now end the line.
// "+" and a trailing "." are left alone ("C++ Engineer", "Engineer Sr.").
function tidyTitle(t: string): string {
  let s = t
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/\s+([,;:])/g, "$1")
    .replace(/([,;:/&\-\u2013\u2014])(?:\s*[,;:/&\-\u2013\u2014])+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  for (;;) {
    const next = s
      .replace(/^[\s,;:./&\-\u2013\u2014]+|[\s,;:/&\-\u2013\u2014]+$/g, "")
      .replace(/\s+(?:at|for|with|of|in|and)$/i, "")
      .replace(/^(?:at|for|with)\s+/i, "");
    if (next === s) return s;
    s = next;
  }
}

/**
 * A job title safe to show a stranger. People write their employer into the
 * title ("ML Engineer @ OpenAI", "Head of AI | Anthropic", "Stripe Staff
 * Engineer", "Engineer, Stripe"), so everything after the first " at ", "@",
 * "|", "•" or "·" goes, and then the current company goes under any spelling
 * past employers are matched on: as written, spaced or squashed ("Open AI"),
 * without descriptors ("Meta" of "Meta Platforms"), or as a part of the title
 * that is a piece of the name ("Google" of "Google DeepMind").
 */
export function publicTitle(
  currentTitle: string | null | undefined,
  currentCompany: string | null | undefined
): string {
  let t = (currentTitle || "").split(/(?:^|\s)at\s+|[@|•·]/i)[0];
  // With no company on record, the one the title itself names after " at " or "@" stands in.
  const full = (currentCompany || "").trim() || employerSegment(currentTitle) || "";
  if (!full) {
    // Nothing says who the employer is, so a part after a spaced dash or in
    // brackets is taken to be it ("Engineer - Stripe"). That can cut a team
    // ("Senior Engineer - Infrastructure" shows "Senior Engineer"), the safe
    // way to be wrong. Commas and slashes stay: real titles lean on them
    // ("Staff Engineer, Infrastructure", "ML / AI Engineer").
    t = t.replace(/\([^)]*\)?/g, " ").split(/\s[-\u2013\u2014]\s/)[0];
    return tidyTitle(t) || GENERIC_TITLE;
  }
  let bare = full;
  while (LEGAL_SUFFIX_TAIL.test(bare)) bare = bare.replace(LEGAL_SUFFIX_TAIL, "").trim();
  // Longest spelling first, so "Stripe, Inc." goes whole before "Stripe" is tried.
  // A legal suffix written after the name goes with it ("Stripe, Inc." when
  // the company is "Stripe"), but not the "Co" of "Co-founder".
  const suffix = `(?:[\\s,]+(?:${LEGAL_SUFFIX_ALT})\\.?(?![\\p{L}\\p{N}-]))?`;
  for (const name of [...new Set([full, bare])].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const pattern = escapeRe(name).replace(/\s+/g, "\\s+");
    t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${pattern}${suffix}(?![\\p{L}\\p{N}])`, "giu"), " ");
  }
  const keys = employerAliases(full);
  if (keys.length) t = dropEmployerParts(cutEmployerRuns(t, keys), keys);
  return tidyTitle(t) || GENERIC_TITLE;
}

/**
 * Past employers safe to show: never the current one under another spelling
 * ("Stripe, Inc." when the current company is "Stripe"). With no current
 * company on record, the employer the title or headline names stands in.
 */
export function publicPriorEmployers(
  row: Pick<MatchRow, "current_company" | "current_title" | "headline" | "previous_companies">
): string[] {
  const current = row.current_company?.trim()
    ? [employerKey(row.current_company)]
    : [employerSegment(row.headline), employerSegment(row.current_title)].map(employerKey);
  const currentKeys = current.filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of row.previous_companies || []) {
    const key = employerKey(c);
    if (!key || seen.has(key) || currentKeys.some((k) => sameEmployer(k, key))) continue;
    seen.add(key);
    out.push(c.trim());
  }
  return out.slice(0, 3);
}

// Composite scoring: embedding-major with a real keyword term now that
// refreshed candidates carry full skill lists. Evidence-backed profiles
// deliberately outrank equally-similar sparse ones.
export function rankAndAnonymize(
  rows: MatchRow[],
  jd: ExtractedJD,
  top = 5
): TalentTeaser {
  const scored = rows
    .map((r) => ({
      row: r,
      score: 0.7 * r.similarity + 0.3 * skillOverlap(jd.skills, r.top_skills),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, top);

  const matches = scored.map(({ row, score }, i) => {
    const education = (row.education_schools || [])
      .map((school, idx) => {
        const degree = row.education_degrees?.[idx];
        return degree ? `${degree}, ${school}` : school;
      })
      .filter((e, idx, arr) => arr.indexOf(e) === idx)
      .slice(0, 2);
    // Never the headline: it is usually "Title at Employer". With no current
    // company on record, the employer the headline names is cut instead (or,
    // failing that, the one the title names; publicTitle looks there itself).
    const company = row.current_company?.trim() || employerSegment(row.headline);
    return {
      ref: `TT-${String(i + 1).padStart(2, "0")}`,
      title: publicTitle(row.current_title, company),
      yearsExperience: row.years_experience,
      location: row.location,
      previousCompanies: publicPriorEmployers(row),
      education,
      skills: (row.top_skills || []).slice(0, 6),
      score: Math.round(score * 100) / 100,
    };
  });
  const inNetwork = scored.filter(({ row }) => !!row.source && ENGAGED_SOURCES.has(row.source)).length;
  return { matches, inNetwork };
}

// The one profile line the fit model reads, built only from what the visitor
// sees, so its "strengths" can never quote anything we cut.
export function fitProfileText(m: AnonymizedMatch): string {
  return `${m.title}. ${m.yearsExperience ?? "?"} yrs. ${m.location ?? ""}. Prev: ${m.previousCompanies.join(", ")}. Education: ${m.education.join("; ")}. Skills: ${m.skills.join(", ")}`;
}
